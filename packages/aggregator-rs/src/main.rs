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
//! as Node's `live.on('batch')` does.
//!
//! `/live-agg` sends per-host rolling stats every 200 ms (`agg.rs`), with
//! a 5-minute snapshot on connect and a per-client top-N cut
//! (`agg_wire.rs`), as `packages/aggregator/src/aggregate.ts` and
//! `server.ts` do.
//!
//! Env: `AGGREGATOR_PORT` (default 8080), `PRODUCER_URL` (default
//! `127.0.0.1:50051`), `SAMPLE_STRIDE` (default 1: per host, keep every
//! Nth event for the rolling stats).

mod agg;
mod agg_wire;
mod metrics;
mod wire;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
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
    agg: agg::Aggregate,
}

/// One `/live-agg` tick: the rows (each client cuts its own top N) and
/// the frame for a client that takes them all, written once.
struct AggTick {
    rows: Vec<agg_wire::HostTick>,
    globals: agg_wire::GlobalsTick,
    full_frame: Arc<str>,
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
    agg_ticks: broadcast::Sender<Arc<AggTick>>,
    metrics: Metrics,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("AGGREGATOR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let producer = std::env::var("PRODUCER_URL").unwrap_or_else(|_| "127.0.0.1:50051".to_string());

    let sample_stride: u64 = std::env::var("SAMPLE_STRIDE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .map(|v| v.floor().max(1.0) as u64)
        .unwrap_or(1);

    let (frames, _) = broadcast::channel(CLIENT_QUEUE_FRAMES);
    let (agg_ticks, _) = broadcast::channel(CLIENT_QUEUE_FRAMES);
    let mut live = new_live();
    let mut agg = agg::Aggregate::new(agg::AggOptions {
        sample_stride,
        ..agg::AggOptions::default()
    });
    agg.attach(&mut live).expect("aggregate pipeline");
    let app = Arc::new(App {
        inner: Mutex::new(Inner { live, agg }),
        frames,
        agg_ticks,
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
        .route("/live-agg", get(live_agg_handler))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind aggregator port");
    println!(
        "aggregator listening on :{port} (producer={producer}, sampleStride={sample_stride}, impl=rust)"
    );
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
    let mut requests_sum = 0.0;
    for e in &batch.events {
        requests_sum += e.requests as f64;
    }
    let rows: Vec<(i64, Vec<Option<Value>>)> = batch
        .events
        .into_iter()
        .map(|e| {
            let values = vec![
                Some(Value::Number(e.cpu)),
                Some(Value::Number(e.requests as f64)),
                Some(Value::String(e.host)),
            ];
            (e.time_ms, values)
        })
        .collect();
    let frame = {
        let mut guard = app.inner.lock().unwrap();
        let inner = &mut *guard;
        let out = match inner.live.push_many(rows) {
            Ok(out) => out,
            Err(e) => {
                // Strict order and required columns refuse the whole
                // batch, as pond-ts does (Node's pushMany throws). A
                // non-finite cpu counts as a missing value. Counted in
                // /metrics; only the first refusal is logged.
                if app.metrics.batch_refused() == 1 {
                    eprintln!("push_many refused a batch of {n}: {e} (further refusals counted in /metrics only)");
                }
                return;
            }
        };
        inner.agg.observe_main(&out);
        inner.agg.add_requests(requests_sum);
        let root = inner.live.root();
        let events = out.into_iter().find_map(|o| match o {
            Output::Batch { node, events } if node == root => Some(events),
            _ => None,
        });
        let frame = events.map(|events| {
            let ser = Instant::now();
            let frame: Arc<str> = wire::append_frame(&events).into();
            app.metrics.fanout_serialize.add(ser.elapsed());
            frame
        });
        app.metrics.set_window_len(inner.live.len());

        // Per-host rolling stats (read from `out` above); any tick this
        // batch completed goes out.
        let ticks = inner.agg.drain_ticks();
        for tick in ticks {
            let full_frame: Arc<str> =
                agg_wire::append_frame(tick.rows.iter(), &tick.globals).into();
            let _ = app.agg_ticks.send(Arc::new(AggTick {
                rows: tick.rows,
                globals: tick.globals,
                full_frame,
            }));
        }

        // Send while holding the lock, so a client taking a snapshot
        // sees each batch either in the snapshot or as an append.
        if let Some(frame) = &frame {
            let bc = Instant::now();
            let _ = app.frames.send(frame.clone());
            app.metrics.fanout_broadcast.add(bc.elapsed());
        }
        frame
    };
    app.metrics.push_many(n, started.elapsed());
    app.metrics.record_batch_done(arrived.elapsed());
    if let Some(frame) = frame {
        app.metrics.record_fanout(n, frame.len(), arrived.elapsed());
    }
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

async fn live_agg_handler(
    ws: WebSocketUpgrade,
    RawQuery(query): RawQuery,
    State(app): State<Arc<App>>,
) -> impl IntoResponse {
    let prefs = agg_wire::parse_connect_query(query.as_deref());
    ws.on_upgrade(move |socket| live_agg_client(socket, app, prefs))
}

/// One `/live-agg` client, as Node's `wss.on('connection')` branch: the
/// history snapshot cut to the client's top N, then each tick cut the
/// same way, and `set-top-n` control messages.
async fn live_agg_client(mut socket: WebSocket, app: Arc<App>, mut prefs: agg_wire::ClientPrefs) {
    let (snapshot, history_len, mut rx) = {
        let inner = app.inner.lock().unwrap();
        let (rows, globals) = inner.agg.history();
        let projected = agg_wire::project_history(&rows, &mut prefs);
        (
            agg_wire::snapshot_frame(&agg::THRESHOLDS, &projected, &globals),
            rows.len(),
            app.agg_ticks.subscribe(),
        )
    };
    if socket.send(Message::Text(snapshot)).await.is_err() {
        return;
    }
    app.metrics.client_connected();
    loop {
        tokio::select! {
            tick = rx.recv() => match tick {
                Ok(t) => {
                    let frame = match agg_wire::project(&t.rows, &mut prefs) {
                        None => t.full_frame.to_string(),
                        Some(kept) => agg_wire::append_frame(kept.into_iter(), &t.globals),
                    };
                    if socket.send(Message::Text(frame)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    eprintln!("/live-agg client {missed} ticks behind; disconnecting");
                    app.metrics.client_dropped();
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                // Node clamps n against the snapshot's row count (or 1000).
                // Node reads text and binary frames alike.
                Some(Ok(msg @ (Message::Text(_) | Message::Binary(_)))) => {
                    let text = match msg {
                        Message::Text(t) => t,
                        Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                        _ => unreachable!(),
                    };
                    if let Some((top_n, by)) = agg_wire::parse_control(&text, history_len) {
                        prefs.top_n = top_n;
                        if let Some(by) = by {
                            prefs.rank_by = by;
                        }
                        prefs.last_top_hosts = None;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
    app.metrics.client_disconnected();
}

async fn metrics_handler(State(app): State<Arc<App>>) -> impl IntoResponse {
    Json(app.metrics.snapshot())
}

#[cfg(test)]
mod tests {
    use super::{backoff_ms, new_live};
    use pond_rs::Value;

    fn row(t: i64, cpu: f64) -> (i64, Vec<Option<Value>>) {
        (
            t,
            vec![
                Some(Value::Number(cpu)),
                Some(Value::Number(1.0)),
                Some(Value::String("h".into())),
            ],
        )
    }

    /// The production window refuses a whole batch with a non-finite
    /// cpu or an out-of-order row, as pond-ts does, and keeps what it had.
    #[test]
    fn window_refuses_bad_batches_whole() {
        let mut live = new_live();
        live.push_many(vec![row(1_000, 0.5)]).unwrap();
        assert!(live
            .push_many(vec![row(2_000, 0.5), row(3_000, f64::NAN)])
            .is_err());
        assert!(live.push_many(vec![row(4_000, f64::INFINITY)]).is_err());
        assert!(live
            .push_many(vec![row(5_000, 0.5), row(500, 0.5)])
            .is_err());
        assert_eq!(live.len(), 1);
    }

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
