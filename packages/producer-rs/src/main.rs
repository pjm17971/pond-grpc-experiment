//! Rust producer for the gRPC experiment.
//!
//! Same contract as `packages/producer` (Node): serves `Subscribe` on
//! `events.proto` and sends one `EventBatch` per tick, one event per
//! host. Env: `GRPC_PORT` (50051), `EVENTS_PER_SEC` (2, per host),
//! `HOST_COUNT` (4), `VARIABILITY` (0.4).
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
//! - The simulator runs once per tick and each subscriber gets a copy
//!   through its own unbounded queue, like Node's `call.write` with
//!   backpressure ignored. A subscriber slower than the producer (the
//!   Node aggregator at high load) makes that queue grow here.
//! - With nobody subscribed the simulator does not run; its walk clock
//!   restarts when a subscriber arrives (`Simulator::resume`).

mod sim;

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio_stream::wrappers::{TcpListenerStream, UnboundedReceiverStream};
use tonic::{Request, Response, Status};

pub mod proto {
    tonic::include_proto!("pond.experiment.v1");
}

use proto::producer_server::{Producer, ProducerServer};
use proto::{EventBatch, SubscribeRequest};

type Subscribers = Arc<Mutex<Vec<mpsc::UnboundedSender<Result<EventBatch, Status>>>>>;

struct Service {
    subscribers: Subscribers,
}

#[tonic::async_trait]
impl Producer for Service {
    type SubscribeStream = UnboundedReceiverStream<Result<EventBatch, Status>>;

    async fn subscribe(
        &self,
        _req: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, Status> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers.lock().unwrap().push(tx);
        Ok(Response::new(UnboundedReceiverStream::new(rx)))
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

    let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
    tokio::spawn(run_simulator(
        subscribers.clone(),
        events_per_sec,
        host_count,
        variability,
    ));

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
        .add_service(ProducerServer::new(Service { subscribers }))
        .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
            let _ = tokio::signal::ctrl_c().await;
        });
    // Same ready line the Node producer prints (dev-utils waits for it).
    println!(
        "producer listening on :{port} (events={events_per_sec}/s, hosts={host_count}, variability=±{variability}, impl=rust)"
    );
    server.await.expect("gRPC server");
}

async fn run_simulator(
    subs: Subscribers,
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
        let mut list = subs.lock().unwrap();
        // Drop subscribers whose stream has closed.
        list.retain(|tx| !tx.is_closed());
        if list.is_empty() {
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
        if let Some((last, rest)) = list.split_last() {
            for tx in rest {
                let _ = tx.send(Ok(batch.clone()));
            }
            let _ = last.send(Ok(batch));
        }
    }
}
