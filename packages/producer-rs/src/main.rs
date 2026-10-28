//! Rust producer for the gRPC experiment.
//!
//! Same contract as `packages/producer` (Node): serves `Subscribe` on
//! `events.proto` and sends one `EventBatch` per tick, one event per
//! host. Env: `GRPC_PORT` (50051), `EVENTS_PER_SEC` (2, per host),
//! `HOST_COUNT` (4), `VARIABILITY` (0.4), `METRICS_PORT` (unset: off;
//! else `GET /metrics` serves the counters in `Counters` as JSON, same
//! shape as the Node producer).
//!
//! Why it exists: the Node producer is one JS thread and tops out near
//! 370k events/s in the cloud container (measured at 1000 hosts ×
//! 1000/s: producer ~110% CPU, Rust aggregator ~50%), so it hides how
//! fast the aggregators are.
//!
//! Differences from Node, on purpose:
//! - Ticks keep to the target rate: a late tick is made up (tokio
//!   `MissedTickBehavior::Burst`), where Node's `setInterval` drifts
//!   and also cannot go below 1 ms (so Node caps at 1000 ticks/s).
//! - The simulator runs once per tick and every subscriber reads it from
//!   one bounded queue (`QUEUE_BATCHES`, 64 batches; a tokio broadcast
//!   channel). gRPC only takes the next batch when HTTP/2 flow control
//!   lets it send, so a subscriber slower than the producer falls behind
//!   in the queue; once it is 64 batches behind, its oldest unsent
//!   batches are dropped (it skips ahead) rather than stalling the
//!   producer or the other subscribers. Drops are counted.
//! - With nobody subscribed the simulator does not run; its walk clock
//!   restarts when a subscriber arrives (`Simulator::resume`).

mod sim;

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::{BroadcastStream, TcpListenerStream};
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status};

pub mod proto {
    tonic::include_proto!("pond.experiment.v1");
}

use proto::producer_server::{Producer, ProducerServer};
use proto::{EventBatch, SubscribeRequest};

/// Batches a subscriber may fall behind before its oldest are dropped.
const QUEUE_BATCHES: usize = 64;

/// Producer counters (`/metrics`).
#[derive(Default)]
struct Counters {
    batches_produced: AtomicU64,
    rows_produced: AtomicU64,
    /// Summed over subscribers: a batch dropped for two slow subscribers
    /// counts twice.
    dropped_batches: AtomicU64,
    dropped_rows: AtomicU64,
}

struct Service {
    tx: broadcast::Sender<EventBatch>,
    counters: Arc<Counters>,
    rows_per_batch: u64,
}

type BatchStream = Pin<Box<dyn Stream<Item = Result<EventBatch, Status>> + Send>>;

#[tonic::async_trait]
impl Producer for Service {
    type SubscribeStream = BatchStream;

    async fn subscribe(
        &self,
        _req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let counters = Arc::clone(&self.counters);
        let rows_per_batch = self.rows_per_batch;
        // `Lagged(n)`: this subscriber fell more than QUEUE_BATCHES behind
        // and the oldest n batches it had not taken are gone.
        let stream = BroadcastStream::new(self.tx.subscribe()).filter_map(move |item| match item {
            Ok(batch) => Some(Ok(batch)),
            Err(BroadcastStreamRecvError::Lagged(n)) => {
                counters.dropped_batches.fetch_add(n, Ordering::Relaxed);
                counters
                    .dropped_rows
                    .fetch_add(n * rows_per_batch, Ordering::Relaxed);
                None
            }
        });
        Ok(Response::new(Box::pin(stream)))
    }
}

fn env<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tokio::main]
async fn main() {
    let port: u16 = env("GRPC_PORT", 50051);
    let events_per_sec: f64 = env("EVENTS_PER_SEC", 2.0);
    if !(events_per_sec.is_finite() && events_per_sec > 0.0) {
        eprintln!("EVENTS_PER_SEC must be a number above 0, got {events_per_sec}");
        std::process::exit(2);
    }
    let host_count: usize = env("HOST_COUNT", 4);
    let variability: f64 = env("VARIABILITY", 0.4);

    let (tx, _) = broadcast::channel(QUEUE_BATCHES);
    let counters = Arc::new(Counters::default());
    tokio::spawn(run_simulator(
        tx.clone(),
        Arc::clone(&counters),
        events_per_sec,
        host_count,
        variability,
    ));
    let metrics_port: Option<u16> = std::env::var("METRICS_PORT")
        .ok()
        .and_then(|v| v.parse().ok());
    if let Some(mp) = metrics_port {
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", mp)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("bind metrics :{mp} failed: {e}");
                std::process::exit(1);
            }
        };
        tokio::spawn(serve_metrics(listener, tx.clone(), Arc::clone(&counters)));
    }

    // Bind first, so the ready line below means the port is ours (as
    // Node prints only after `bindAsync` succeeds).
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind :{port} failed: {e}");
            std::process::exit(1);
        }
    };
    let server = tonic::transport::Server::builder()
        .add_service(ProducerServer::new(Service {
            tx,
            counters,
            rows_per_batch: host_count as u64,
        }))
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
            let _ = tokio::signal::ctrl_c().await;
        });
    // Same ready line the Node producer prints (dev-utils waits for it).
    println!(
        "producer listening on :{port} (events={events_per_sec}/s, hosts={host_count}, variability=±{variability}, impl=rust)"
    );
    server.await.expect("gRPC server");
}

/// A bare-bones HTTP server for `GET /metrics` (any path answers): the
/// bench scrapes it once a second, so no framework.
async fn serve_metrics(
    listener: tokio::net::TcpListener,
    tx: broadcast::Sender<EventBatch>,
    counters: Arc<Counters>,
) {
    let started = Instant::now();
    loop {
        let Ok((mut sock, _)) = listener.accept().await else {
            // e.g. out of file handles: back off rather than spin.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let body = format!(
            "{{\"uptimeSec\":{},\"subscribers\":{},\"queueBatches\":{},\"batchesProduced\":{},\"rowsProduced\":{},\"droppedBatches\":{},\"droppedRows\":{}}}",
            started.elapsed().as_secs_f64(),
            tx.receiver_count(),
            QUEUE_BATCHES,
            counters.batches_produced.load(Ordering::Relaxed),
            counters.rows_produced.load(Ordering::Relaxed),
            counters.dropped_batches.load(Ordering::Relaxed),
            counters.dropped_rows.load(Ordering::Relaxed),
        );
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            // The request itself is ignored; don't wait on it for long.
            let _ = tokio::time::timeout(Duration::from_secs(1), sock.read(&mut buf)).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.write_all(body.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
    }
}

async fn run_simulator(
    tx: broadcast::Sender<EventBatch>,
    counters: Arc<Counters>,
    events_per_sec: f64,
    host_count: usize,
    variability: f64,
) {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    let mut sim = sim::Simulator::new(host_count, variability, now_ms(), seed);
    let mut every = tokio::time::interval(Duration::from_secs_f64(1.0 / events_per_sec));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
    every.tick().await; // the first tick fires at once; Node's first is one period in
    let mut idle = true;
    loop {
        every.tick().await;
        if tx.receiver_count() == 0 {
            // Node runs the simulator with nobody listening; skipping it
            // saves the CPU, and `resume` below hides the gap.
            idle = true;
            continue;
        }
        let now = now_ms();
        if idle {
            sim.resume(now);
            idle = false;
        }
        let batch = sim.tick(now);
        counters.batches_produced.fetch_add(1, Ordering::Relaxed);
        counters
            .rows_produced
            .fetch_add(batch.events.len() as u64, Ordering::Relaxed);
        // Never blocks: a full queue overwrites the oldest batch.
        let _ = tx.send(batch);
    }
}
