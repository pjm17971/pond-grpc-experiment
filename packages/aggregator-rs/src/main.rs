//! Rust aggregator for the gRPC experiment.
//!
//! Same contract as `packages/aggregator` (Node): reads `EventBatch`es
//! from the producer over gRPC, serves the raw stream on `/live` as a
//! snapshot frame then append frames (`packages/shared/src/wire.ts`),
//! plus `/health` and `/metrics` in the shape the bench scripts read.
//!
//! This is the shell. The 30 s window behind the `/live` snapshot is a
//! plain `VecDeque` for now; it becomes a pond-rs `LiveSeries` when
//! pond-rs's live layer lands (R3 step 2), and `/live-agg` (per-host
//! rolling stats every 200 ms) follows R3 steps 4 to 6.
//!
//! Env: `AGGREGATOR_PORT` (default 8080), `PRODUCER_URL` (default
//! `127.0.0.1:50051`).

mod metrics;
mod wire;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use tokio::sync::broadcast;

use metrics::Metrics;
use wire::Row;

pub mod proto {
    tonic::include_proto!("pond.experiment.v1");
}

/// Matches the Node aggregator's `retention: { maxAge: '30s' }`.
const RETENTION_MS: i64 = 30_000;
/// Append frames a slow `/live` client may fall behind by before it
/// is disconnected. The Node aggregator has no limit (M4 never ran).
const CLIENT_QUEUE_FRAMES: usize = 1024;

struct Inner {
    rows: VecDeque<Row>,
}

struct App {
    inner: Mutex<Inner>,
    frames: broadcast::Sender<Arc<str>>,
    metrics: Metrics,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("AGGREGATOR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let producer =
        std::env::var("PRODUCER_URL").unwrap_or_else(|_| "127.0.0.1:50051".to_string());

    let (frames, _) = broadcast::channel(CLIENT_QUEUE_FRAMES);
    let app = Arc::new(App {
        inner: Mutex::new(Inner {
            rows: VecDeque::new(),
        }),
        frames,
        metrics: Metrics::new(),
    });

    tokio::spawn(ingest(app.clone(), producer.clone()));

    let router = Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({ "ok": true })) }))
        .route("/metrics", get(metrics_handler))
        .route("/live", get(live_handler))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind aggregator port");
    println!("aggregator listening on :{port} (producer={producer}, impl=rust)");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server");
}

/// Dial the producer and re-dial with backoff, as `ingest.ts` does.
async fn ingest(app: Arc<App>, producer: String) {
    let url = format!("http://{producer}");
    let mut attempt: u32 = 0;
    loop {
        match proto::producer_client::ProducerClient::connect(url.clone()).await {
            Ok(mut client) => match client.subscribe(proto::SubscribeRequest {}).await {
                Ok(resp) => {
                    attempt = 0;
                    let mut stream = resp.into_inner();
                    loop {
                        match stream.message().await {
                            Ok(Some(batch)) => on_batch(&app, batch),
                            Ok(None) => break,
                            Err(e) => {
                                eprintln!("producer stream error: {e}");
                                break;
                            }
                        }
                    }
                }
                Err(e) => eprintln!("subscribe failed: {e}"),
            },
            Err(e) => eprintln!("connect to {producer} failed: {e}"),
        }
        let delay = (250u64 << attempt.min(5)).min(5_000);
        attempt += 1;
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

fn on_batch(app: &App, batch: proto::EventBatch) {
    let arrived = Instant::now();
    let n = batch.events.len();
    if n == 0 {
        return;
    }
    app.metrics.record_ingest(n);

    let started = Instant::now();
    let rows: Vec<Row> = batch.events.into_iter().map(Row::from).collect();
    let frame = {
        let mut inner = app.inner.lock().unwrap();
        let ser = Instant::now();
        let frame: Arc<str> = wire::append_frame(&rows).into();
        app.metrics.fanout_serialize.add(ser.elapsed());
        let latest = rows.last().map(|r| r.time_ms).unwrap_or(i64::MIN);
        inner.rows.extend(rows);
        while inner
            .rows
            .front()
            .is_some_and(|r| r.time_ms < latest - RETENTION_MS)
        {
            inner.rows.pop_front();
        }
        app.metrics.set_window_len(inner.rows.len());
        // Send while holding the lock, so a client taking a snapshot
        // sees each batch either in the snapshot or as an append.
        let bc = Instant::now();
        let _ = app.frames.send(frame.clone());
        app.metrics.fanout_broadcast.add(bc.elapsed());
        frame
    };
    app.metrics.push_many(n, started.elapsed());
    app.metrics.record_fanout(n, frame.len(), arrived.elapsed());
}

async fn live_handler(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| live_client(socket, app))
}

async fn live_client(mut socket: WebSocket, app: Arc<App>) {
    let (snapshot, mut rx) = {
        let inner = app.inner.lock().unwrap();
        (wire::snapshot_frame(inner.rows.iter()), app.frames.subscribe())
    };
    app.metrics.client_connected();
    if socket.send(Message::Text(snapshot)).await.is_ok() {
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Ok(f) => {
                        if socket.send(Message::Text(f.to_string())).await.is_err() {
                            break;
                        }
                    }
                    // Fell more than CLIENT_QUEUE_FRAMES behind: close.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                msg = socket.recv() => match msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
    }
    app.metrics.client_disconnected();
}

async fn metrics_handler(State(app): State<Arc<App>>) -> impl IntoResponse {
    Json(app.metrics.snapshot())
}
