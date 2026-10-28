//! Rust aggregator for the gRPC experiment.
//!
//! Same contract as `packages/aggregator` (Node): reads `EventBatch`es
//! from the producer over gRPC, serves the raw stream on `/live` as a
//! snapshot frame then append frames (`packages/shared/src/wire.ts`),
//! plus `/health` and `/metrics` in the shape the bench scripts read.
//!
//! The 30 s window behind `/live` is a pond-rs `LiveSeries` (R3 step 2),
//! as the Node side keeps a pond-ts one: each gRPC batch is one
//! `push_many`, and the root's `Batch` output becomes the append frame,
//! as Node's `live.on('batch')` does. `/live-agg` (per-host rolling stats
//! every 200 ms) follows pond-rs R3 steps 4 to 6.
//!
//! Env: `AGGREGATOR_PORT` (default 8080), `PRODUCER_URL` (default
//! `127.0.0.1:50051`).

mod metrics;
mod wire;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use tokio::sync::broadcast;

use metrics::Metrics;
use pond_rs::live::{LiveOptions, LiveSeries, Output, OutputKind};
use pond_rs::{ColumnDef, ColumnKind, Value};

pub mod proto {
    tonic::include_proto!("pond.experiment.v1");
}

/// Append frames a slow `/live` client may fall behind by before it
/// is disconnected. The Node aggregator has no limit (M4 never ran).
const CLIENT_QUEUE_FRAMES: usize = 1024;

struct Inner {
    live: LiveSeries,
}

/// `packages/shared/src/schema.ts`, with the Node aggregator's
/// `retention: { maxAge: '30s' }` and default strict ordering.
fn new_live() -> LiveSeries {
    let mut live = LiveSeries::with_options(
        "metrics",
        vec![
            ColumnDef::required("time", ColumnKind::Time),
            ColumnDef::required("cpu", ColumnKind::Number),
            ColumnDef::required("requests", ColumnKind::Number),
            ColumnDef::required("host", ColumnKind::String),
        ],
        LiveOptions::new().max_age("30s"),
    )
    .expect("schema");
    let root = live.root();
    live.watch(root, OutputKind::Batch).expect("watch root");
    live
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
    let producer = std::env::var("PRODUCER_URL").unwrap_or_else(|_| "127.0.0.1:50051".to_string());

    let (frames, _) = broadcast::channel(CLIENT_QUEUE_FRAMES);
    let app = Arc::new(App {
        inner: Mutex::new(Inner { live: new_live() }),
        frames,
        metrics: Metrics::new(),
    });

    tokio::spawn(ingest(app.clone(), producer.clone()));

    let router = Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "ok": true })) }),
        )
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

/// Dial the producer and re-dial with backoff, as `ingest.ts` does:
/// `shared/src/backoff.ts` (1 s doubling to 30 s, ±20% jitter), with
/// the attempt counter reset on a stream's first delivered batch.
async fn ingest(app: Arc<App>, producer: String) {
    let url = format!("http://{producer}");
    let mut attempt: u32 = 0;
    loop {
        match proto::producer_client::ProducerClient::connect(url.clone()).await {
            Ok(mut client) => match client.subscribe(proto::SubscribeRequest {}).await {
                Ok(resp) => {
                    let mut stream = resp.into_inner();
                    let mut first = true;
                    loop {
                        match stream.message().await {
                            Ok(Some(batch)) => {
                                if first {
                                    attempt = 0;
                                    first = false;
                                }
                                on_batch(&app, batch);
                            }
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
        let delay = backoff_ms(attempt);
        attempt += 1;
        eprintln!("reconnecting in {delay}ms (attempt {attempt})");
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

/// Port of `shared/src/backoff.ts` defaults.
fn backoff_ms(attempt: u32) -> u64 {
    let base = (1000.0 * 2f64.powi(attempt.min(30) as i32)).min(30_000.0);
    // Jitter source: the clock's sub-second nanos; no rand dependency.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let unit = nanos as f64 / 1e9 * 2.0 - 1.0; // -1 .. 1
    (base + unit * base * 0.2).round() as u64
}

fn on_batch(app: &App, batch: proto::EventBatch) {
    let arrived = Instant::now();
    let n = batch.events.len();
    if n == 0 {
        return;
    }
    app.metrics.record_ingest(n);

    let started = Instant::now();
    let rows = batch.events.into_iter().map(|e| {
        let values: Vec<Option<Value>> = vec![
            Some(Value::Number(e.cpu)),
            Some(Value::Number(e.requests as f64)),
            Some(Value::String(e.host)),
        ];
        (e.time_ms, values)
    });
    let frame = {
        let mut inner = app.inner.lock().unwrap();
        let out = match inner.live.push_many(rows) {
            Ok(out) => out,
            Err(e) => {
                // Strict ordering refuses the whole batch, as pond-ts.
                eprintln!("push_many refused a batch of {n}: {e}");
                return;
            }
        };
        let Some(Output::Batch { events, .. }) =
            out.into_iter().find(|o| o.kind() == OutputKind::Batch)
        else {
            return;
        };
        let ser = Instant::now();
        let frame: Arc<str> = wire::append_frame(&events).into();
        app.metrics.fanout_serialize.add(ser.elapsed());
        app.metrics.set_window_len(inner.live.len());
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
        (
            wire::snapshot_frame(inner.live.events()),
            app.frames.subscribe(),
        )
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
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!("/live client {missed} frames behind; disconnecting");
                        app.metrics.client_dropped();
                        break;
                    }
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

#[cfg(test)]
mod tests {
    use super::backoff_ms;

    #[test]
    fn backoff_matches_node_defaults() {
        for (attempt, base) in [
            (0u32, 1000.0),
            (1, 2000.0),
            (4, 16_000.0),
            (5, 30_000.0),
            (40, 30_000.0),
        ] {
            let d = backoff_ms(attempt) as f64;
            assert!(
                d >= base * 0.8 - 1.0 && d <= base * 1.2 + 1.0,
                "attempt {attempt}: {d}"
            );
        }
    }
}
