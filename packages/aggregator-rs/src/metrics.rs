//! `/metrics` in the shape of `packages/aggregator/src/metrics.ts`
//! (`MetricsSnapshot`), so `scripts/bench.ts` reads both servers alike.
//!
//! Differences from Node, by necessity: there is no GC, so `gc` is
//! always `{}`; `memory.heapUsed` and `memory.rss` both report the
//! process resident size (RSS), so the bench's "heap peak" column is
//! Node's JS heap against Rust's whole-process RSS. Extra:
//! `ws.clientsDropped`, clients cut off for falling behind.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Same bounded ring as Node's `Histogram` (1024 samples, sort on read).
const HIST_CAPACITY: usize = 1024;

pub struct Histogram {
    buf: Mutex<(Vec<f64>, usize)>,
}

impl Histogram {
    fn new() -> Self {
        Histogram {
            buf: Mutex::new((Vec::with_capacity(HIST_CAPACITY), 0)),
        }
    }

    pub fn add(&self, d: Duration) {
        let ms = d.as_secs_f64() * 1000.0;
        let mut g = self.buf.lock().unwrap();
        let (buf, idx) = &mut *g;
        if buf.len() < HIST_CAPACITY {
            buf.push(ms);
        } else {
            buf[*idx] = ms;
            *idx = (*idx + 1) % HIST_CAPACITY;
        }
    }

    fn snapshot(&self) -> Value {
        let g = self.buf.lock().unwrap();
        if g.0.is_empty() {
            return Value::Null;
        }
        let mut s = g.0.clone();
        s.sort_by(|a, b| a.total_cmp(b));
        // Same percentile rule as Node's `pct`: min(n - 1, floor(n * p)).
        let pct = |p: f64| s[((s.len() as f64 * p).floor() as usize).min(s.len() - 1)];
        json!({ "p50": pct(0.5), "p95": pct(0.95), "p99": pct(0.99), "count": s.len() })
    }
}

pub struct Metrics {
    started: Instant,
    ingested: AtomicU64,
    fanned_out: AtomicU64,
    bytes_fanned_out: AtomicU64,
    push_calls: AtomicU64,
    push_events: AtomicU64,
    push_max: AtomicUsize,
    window_len: AtomicUsize,
    clients: AtomicUsize,
    clients_dropped: AtomicU64,
    ingest_to_fanout: Histogram,
    push_total: Histogram,
    pub fanout_serialize: Histogram,
    pub fanout_broadcast: Histogram,
}

impl Metrics {
    pub fn new() -> Self {
        Metrics {
            started: Instant::now(),
            ingested: AtomicU64::new(0),
            fanned_out: AtomicU64::new(0),
            bytes_fanned_out: AtomicU64::new(0),
            push_calls: AtomicU64::new(0),
            push_events: AtomicU64::new(0),
            push_max: AtomicUsize::new(0),
            window_len: AtomicUsize::new(0),
            clients: AtomicUsize::new(0),
            clients_dropped: AtomicU64::new(0),
            ingest_to_fanout: Histogram::new(),
            push_total: Histogram::new(),
            fanout_serialize: Histogram::new(),
            fanout_broadcast: Histogram::new(),
        }
    }

    pub fn record_ingest(&self, n: usize) {
        self.ingested.fetch_add(n as u64, Ordering::Relaxed);
    }

    pub fn push_many(&self, n: usize, took: Duration) {
        self.push_calls.fetch_add(1, Ordering::Relaxed);
        self.push_events.fetch_add(n as u64, Ordering::Relaxed);
        self.push_max.fetch_max(n, Ordering::Relaxed);
        self.push_total.add(took);
    }

    pub fn record_fanout(&self, n: usize, bytes: usize, since_arrival: Duration) {
        self.fanned_out.fetch_add(n as u64, Ordering::Relaxed);
        let clients = self.clients.load(Ordering::Relaxed) as u64;
        self.bytes_fanned_out
            .fetch_add(bytes as u64 * clients, Ordering::Relaxed);
        self.ingest_to_fanout.add(since_arrival);
    }

    pub fn set_window_len(&self, n: usize) {
        self.window_len.store(n, Ordering::Relaxed);
    }

    pub fn client_connected(&self) {
        self.clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn client_disconnected(&self) {
        self.clients.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn client_dropped(&self) {
        self.clients_dropped.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> Value {
        let calls = self.push_calls.load(Ordering::Relaxed);
        let events = self.push_events.load(Ordering::Relaxed);
        let rss = rss_bytes();
        let clients = self.clients.load(Ordering::Relaxed);
        json!({
            "impl": "rust",
            "uptimeSec": self.started.elapsed().as_secs_f64(),
            "events": {
                "ingested": self.ingested.load(Ordering::Relaxed),
                "fannedOut": self.fanned_out.load(Ordering::Relaxed),
                "bytesFannedOut": self.bytes_fanned_out.load(Ordering::Relaxed),
            },
            "pushMany": {
                "calls": calls,
                "totalEvents": events,
                "avgBatchSize": if calls == 0 { 0.0 } else { events as f64 / calls as f64 },
                "maxBatchSize": self.push_max.load(Ordering::Relaxed),
            },
            "liveSeriesLength": self.window_len.load(Ordering::Relaxed),
            "arrivalQueueLength": 0,
            "arrivalTimesDropped": 0,
            "latency": {
                "ingestToFanoutMs": self.ingest_to_fanout.snapshot(),
                "pushManyTotalMs": self.push_total.snapshot(),
                "fanoutRecordMs": Value::Null,
                "fanoutSerializeMs": self.fanout_serialize.snapshot(),
                "fanoutBroadcastMs": self.fanout_broadcast.snapshot(),
            },
            "ws": {
                "clientCount": clients,
                "bufferedAmount": vec![0; clients],
                "clientsDropped": self.clients_dropped.load(Ordering::Relaxed),
            },
            "memory": { "rss": rss, "heapUsed": rss, "heapTotal": rss, "external": 0, "arrayBuffers": 0 },
            "gc": {},
        })
    }
}

/// Resident set size in bytes (Linux, macOS, Windows), or 0 if unknown.
fn rss_bytes() -> u64 {
    memory_stats::memory_stats()
        .map(|m| m.physical_mem as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every field `packages/aggregator/scripts/bench.ts` reads.
    #[test]
    fn snapshot_has_the_fields_bench_reads() {
        let m = Metrics::new();
        m.record_ingest(3);
        m.push_many(3, Duration::from_micros(10));
        m.record_fanout(3, 100, Duration::from_micros(20));
        m.fanout_serialize.add(Duration::from_micros(5));
        m.fanout_broadcast.add(Duration::from_micros(5));
        let s = m.snapshot();
        for path in [
            "/uptimeSec",
            "/events/ingested",
            "/events/fannedOut",
            "/events/bytesFannedOut",
            "/pushMany/calls",
            "/pushMany/totalEvents",
            "/pushMany/avgBatchSize",
            "/pushMany/maxBatchSize",
            "/liveSeriesLength",
            "/arrivalQueueLength",
            "/latency/ingestToFanoutMs/p99",
            "/latency/pushManyTotalMs/p99",
            "/latency/fanoutSerializeMs/p99",
            "/latency/fanoutBroadcastMs/p99",
            "/ws/clientCount",
            "/memory/heapUsed",
            "/gc",
        ] {
            assert!(s.pointer(path).is_some(), "missing {path}");
        }
        assert!(s["memory"]["heapUsed"].as_u64().unwrap() > 0);
        assert_eq!(s["events"]["fannedOut"], 3);
    }

    #[test]
    fn percentiles_follow_node_rule() {
        let h = Histogram::new();
        for ms in 1..=10 {
            h.add(Duration::from_millis(ms));
        }
        let s = h.snapshot();
        // Node: sorted[min(n - 1, floor(n * p))] with n = 10.
        assert_eq!(s["p50"], 6.0);
        assert_eq!(s["p99"], 10.0);
        assert_eq!(s["count"], 10);
    }
}
