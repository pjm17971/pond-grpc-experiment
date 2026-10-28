//! The `/live-agg` pipeline: per-host rolling stats every 200 ms, as
//! `packages/aggregator/src/aggregate.ts` builds them.
//!
//! Node runs one partitioned fused rolling:
//! `live.partitionBy('host').rolling({ '1m': {...}, '200ms': {...} },
//! { trigger: Trigger.clock(every 200ms) })`. pond-rs has no live
//! partitions yet (R3 step 6), so this splits by host by hand: one small
//! `LiveSeries` per host with the same fused rolling on it. Each gRPC
//! batch is grouped by host and pushed host by host.
//!
//! Two differences follow (see `friction-notes/pond-rs-live-agg.md`):
//! - Node's partitions all emit when the first host's event crosses a
//!   tick, before the other hosts' events at that time are added; here
//!   each host emits after its own event, so its row holds one more.
//! - Node still emits a host that has gone quiet; here a quiet host
//!   emits nothing until its next event.
//!
//! Globals (`events_per_sec`, running totals) come from the main series,
//! as in Node: a 1 s count rolling on the same clock, and the root's
//! batch and evict outputs.

use std::collections::{HashMap, VecDeque};

use pond_rs::live::{
    History, LiveOptions, LiveRolling, LiveSeries, Node, Output, OutputKind, RollingOptions,
    RollingWindow, Trigger,
};
use pond_rs::{Agg, ColumnDef, ColumnKind, Reducer, Scalar, Sequence, Value};

use crate::agg_wire::{GlobalsTick, HostTick};

/// `DEFAULT_AGGREGATE_THRESHOLDS` in `shared/src/wire.ts`.
pub const THRESHOLDS: [f64; 5] = [1.0, 1.5, 2.0, 2.5, 3.0];
const BASELINE_WINDOW_SEC: f64 = 60.0;

pub struct AggOptions {
    pub tick_ms: i64,
    pub sample_stride: u64,
    pub history_max_age_ms: i64,
}

impl Default for AggOptions {
    fn default() -> Self {
        AggOptions {
            tick_ms: 200,
            sample_stride: 1,
            history_max_age_ms: 5 * 60 * 1000,
        }
    }
}

struct Host {
    live: LiveSeries,
    rolling: Node<LiveRolling>,
    /// Stride-sample counter, pond-ts `sample({ stride })`: keeps the
    /// stride-th, 2·stride-th, … event.
    seen: u64,
}

/// One host's rows for this batch: (time, cpu, requests).
pub type HostRows = Vec<(i64, f64, f64)>;

pub struct Aggregate {
    opts: AggOptions,
    trigger: Trigger,
    hosts: HashMap<String, Host>,
    events_per_sec: Option<Node<LiveRolling>>,
    latest_events_per_sec: f64,
    events_ingested: u64,
    evicted: u64,
    requests_ingested: f64,
    first_event_ts: Option<i64>,
    pending: Vec<HostTick>,
    last_emitted_ts: i64,
    late_rows: u64,
    history_rows: VecDeque<HostTick>,
    history_globals: VecDeque<GlobalsTick>,
}

/// A tick ready to send: every host's row for one `ts`, and the globals.
pub struct Tick {
    pub rows: Vec<HostTick>,
    pub globals: GlobalsTick,
}

impl Aggregate {
    pub fn new(opts: AggOptions) -> Self {
        let trigger = Trigger::clock(
            &Sequence::every(&format!("{}ms", opts.tick_ms)).expect("tick sequence"),
        )
        .expect("clock trigger");
        Aggregate {
            opts,
            trigger,
            hosts: HashMap::new(),
            events_per_sec: None,
            latest_events_per_sec: 0.0,
            events_ingested: 0,
            evicted: 0,
            requests_ingested: 0.0,
            first_event_ts: None,
            pending: Vec::new(),
            last_emitted_ts: i64::MIN,
            late_rows: 0,
            history_rows: VecDeque::new(),
            history_globals: VecDeque::new(),
        }
    }

    /// Build the globals rolling on the main series and watch what the
    /// totals need (root batch and evict, rolling events).
    pub fn attach(&mut self, live: &mut LiveSeries) -> pond_rs::Result<()> {
        let root = live.root();
        let eps = live.rolling_windows(
            root,
            &[RollingWindow::new(
                "1s",
                &[Agg::new("events_per_sec", "cpu", Reducer::Count)],
            )],
            &RollingOptions::new()
                .trigger(self.trigger)
                .history(History::Off),
        )?;
        live.watch(eps, OutputKind::Event)?;
        live.watch(root, OutputKind::Evict)?;
        self.events_per_sec = Some(eps);
        Ok(())
    }

    /// Read the main series' outputs for one push: totals and the latest
    /// events-per-second. `Batch` outputs are read here too (the `/live`
    /// fan-out reads them separately).
    pub fn observe_main(&mut self, outputs: &[Output]) {
        for out in outputs {
            match out {
                Output::Batch { events, .. } => {
                    self.events_ingested += events.len() as u64;
                    if self.first_event_ts.is_none() {
                        self.first_event_ts = events.first().map(|e| e.begin());
                    }
                }
                Output::Evict { events, .. } => self.evicted += events.len() as u64,
                Output::Event { node, event }
                    if Some(*node) == self.events_per_sec.map(|n| n.id()) =>
                {
                    if let Ok(Some(v)) = event.number("events_per_sec") {
                        self.latest_events_per_sec = v;
                    }
                }
                _ => {}
            }
        }
    }

    /// `requests` summed over a batch (Node adds `e.get('requests')` per
    /// event in its batch listener).
    pub fn add_requests(&mut self, sum: f64) {
        self.requests_ingested += sum;
    }

    fn new_host(&self) -> pond_rs::Result<Host> {
        // The rolling keeps its own window, so the host series only needs
        // to hold the event being pushed.
        let mut live = LiveSeries::with_options(
            "host",
            vec![
                ColumnDef::required("time", ColumnKind::Time),
                ColumnDef::required("cpu", ColumnKind::Number),
                ColumnDef::required("requests", ColumnKind::Number),
            ],
            LiveOptions::new().max_events(1),
        )?;
        let root = live.root();
        let tick = format!("{}ms", self.opts.tick_ms);
        let rolling = live.rolling_windows(
            root,
            &[
                RollingWindow::new(
                    "1m",
                    &[
                        Agg::new("cpu_avg", "cpu", Reducer::Avg),
                        Agg::new("cpu_sd", "cpu", Reducer::Stdev),
                        Agg::new("cpu_n", "cpu", Reducer::Count),
                        Agg::new("requests_avg", "requests", Reducer::Avg),
                        Agg::new("requests_sum", "requests", Reducer::Sum),
                        Agg::new("requests_n", "requests", Reducer::Count),
                    ],
                ),
                RollingWindow::new(
                    &tick,
                    &[
                        Agg::new("cpu_samples", "cpu", Reducer::Samples),
                        Agg::new("cpu_min", "cpu", Reducer::Min),
                        Agg::new("cpu_max", "cpu", Reducer::Max),
                        Agg::new("current_avg", "cpu", Reducer::Avg),
                        Agg::new("current_sd", "cpu", Reducer::Stdev),
                    ],
                ),
            ],
            &RollingOptions::new()
                .trigger(self.trigger)
                .history(History::Off),
        )?;
        live.watch(rolling, OutputKind::Event)?;
        Ok(Host {
            live,
            rolling,
            seen: 0,
        })
    }

    /// Push one batch, already grouped by host in first-seen order, into
    /// the per-host rollings, and collect the rows they emit.
    pub fn push_hosts(&mut self, by_host: Vec<(String, HostRows)>) {
        let stride = self.opts.sample_stride.max(1);
        for (name, rows) in by_host {
            if !self.hosts.contains_key(&name) {
                match self.new_host() {
                    Ok(h) => {
                        self.hosts.insert(name.clone(), h);
                    }
                    Err(e) => {
                        eprintln!("host pipeline for {name}: {e}");
                        continue;
                    }
                }
            }
            let host = self.hosts.get_mut(&name).expect("just inserted");
            let mut kept = Vec::with_capacity(rows.len());
            for (t, cpu, req) in rows {
                host.seen += 1;
                if host.seen.is_multiple_of(stride) {
                    kept.push((t, vec![Some(Value::Number(cpu)), Some(Value::Number(req))]));
                }
            }
            if kept.is_empty() {
                continue;
            }
            let outputs = match host.live.push_many(kept) {
                Ok(o) => o,
                // The main series already accepted these rows, so this
                // would be a pond-rs bug; skip the host's rows for this batch.
                Err(e) => {
                    eprintln!("host {name} push refused: {e}");
                    continue;
                }
            };
            let rolling = host.rolling.id();
            for out in outputs {
                if let Output::Event { node, event } = out {
                    if node == rolling {
                        let row = self.host_tick(&name, &event);
                        self.pending.push(row);
                    }
                }
            }
        }
    }

    fn host_tick(&self, host: &str, e: &pond_rs::live::LiveEvent) -> HostTick {
        let ts = e.begin();
        let num = |name: &str| e.number(name).ok().flatten();
        let samples: Vec<f64> = match e.array("cpu_samples") {
            Ok(Some(s)) => s
                .iter()
                .filter_map(|x| match x {
                    Scalar::Number(v) => Some(*v),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let window_age_seconds = match self.first_event_ts {
            None => 0.0,
            Some(first) => BASELINE_WINDOW_SEC.min((ts - first) as f64 / 1000.0),
        };
        let cpu_avg = num("cpu_avg");
        let cpu_sd = num("cpu_sd");
        let (above, below) = anomalies(cpu_avg, cpu_sd, &samples, &THRESHOLDS);
        HostTick {
            ts,
            host: host.to_string(),
            cpu_avg,
            cpu_sd,
            cpu_n: num("cpu_n").unwrap_or(0.0),
            n_current: samples.len() as u64,
            anomalies_above: above,
            anomalies_below: below,
            requests_avg: num("requests_avg"),
            requests_sum: num("requests_sum").unwrap_or(0.0),
            requests_n: num("requests_n").unwrap_or(0.0),
            window_age_seconds,
            cpu_min: num("cpu_min"),
            cpu_max: num("cpu_max"),
            current_avg: num("current_avg"),
            current_sd: num("current_sd"),
        }
    }

    /// Ticks completed by the last push, oldest first (Node's `tryEmit`):
    /// rows grouped by `ts`; each tick also goes into the snapshot history.
    ///
    /// A row for a `ts` at or before the last tick sent is dropped, as
    /// Node drops it. In Node that never happens (every partition emits
    /// at once). Split by hand it can: a host whose crossing event comes
    /// in a later gRPC batch than the others' (split batches, or a host
    /// whose `SAMPLE_STRIDE` count is out of step). Those rows are
    /// counted in [`Aggregate::late_rows`] (`/metrics`), first one logged.
    pub fn drain_ticks(&mut self) -> Vec<Tick> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let mut rows = std::mem::take(&mut self.pending);
        // Stable: hosts keep their push order within a tick.
        rows.sort_by_key(|r| r.ts);
        let mut ticks: Vec<Tick> = Vec::new();
        for row in rows {
            if row.ts <= self.last_emitted_ts {
                self.late_rows += 1;
                if self.late_rows == 1 {
                    eprintln!(
                        "/live-agg: row for {} at {} came after that tick was sent; dropped \
                         (further ones counted in /metrics only)",
                        row.host, row.ts
                    );
                }
                continue;
            }
            match ticks.last_mut() {
                Some(t) if t.globals.ts == row.ts => t.rows.push(row),
                _ => {
                    let globals = GlobalsTick {
                        ts: row.ts,
                        events_ingested_total: self.events_ingested,
                        events_per_sec: self.latest_events_per_sec.round(),
                        evicted_total: self.evicted,
                        requests_ingested_total: self.requests_ingested,
                    };
                    ticks.push(Tick {
                        rows: vec![row],
                        globals,
                    });
                }
            }
        }
        if let Some(last) = ticks.last() {
            self.last_emitted_ts = last.globals.ts;
        }
        if self.opts.history_max_age_ms > 0 {
            for t in &ticks {
                self.history_rows.extend(t.rows.iter().cloned());
                self.history_globals.push_back(t.globals.clone());
                // Append, then evict (Node keeps a tick right at the edge).
                let cutoff = t.globals.ts - self.opts.history_max_age_ms;
                while self.history_rows.front().is_some_and(|r| r.ts < cutoff) {
                    self.history_rows.pop_front();
                }
                while self.history_globals.front().is_some_and(|g| g.ts < cutoff) {
                    self.history_globals.pop_front();
                }
            }
        }
        ticks
    }

    /// Rows dropped because their tick had already been sent.
    pub fn late_rows(&self) -> u64 {
        self.late_rows
    }

    pub fn history(&self) -> (Vec<HostTick>, Vec<GlobalsTick>) {
        (
            self.history_rows.iter().cloned().collect(),
            self.history_globals.iter().cloned().collect(),
        )
    }
}

/// Node's `assembleTick` anomaly counts: per threshold, samples above
/// `avg + t·sd` and below `avg − t·sd`. Zeros when there is no baseline
/// or no sample.
pub fn anomalies(
    avg: Option<f64>,
    sd: Option<f64>,
    samples: &[f64],
    thresholds: &[f64],
) -> (Vec<u64>, Vec<u64>) {
    let mut above = vec![0u64; thresholds.len()];
    let mut below = vec![0u64; thresholds.len()];
    if let (Some(mean), Some(sd)) = (avg, sd) {
        for &v in samples {
            let diff = v - mean;
            for (i, t) in thresholds.iter().enumerate() {
                let cutoff = t * sd;
                if diff > cutoff {
                    above[i] += 1;
                } else if -diff > cutoff {
                    below[i] += 1;
                }
            }
        }
    }
    (above, below)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anomalies_match_node_rule() {
        let (a, b) = anomalies(
            Some(0.5),
            Some(0.1),
            &[0.5, 0.62, 0.71, 0.36, 0.2],
            &THRESHOLDS,
        );
        // diffs: 0, +0.12, +0.21, -0.14, -0.3
        assert_eq!(a, vec![2, 1, 1, 0, 0]);
        // -0.3 vs 3 * 0.1 = 0.30000000000000004: not below.
        assert_eq!(b, vec![2, 1, 1, 1, 0]);
        let (a, b) = anomalies(None, Some(0.1), &[0.9], &THRESHOLDS);
        assert_eq!((a, b), (vec![0; 5], vec![0; 5]));
    }

    fn main_series() -> LiveSeries {
        LiveSeries::with_options(
            "metrics",
            vec![
                ColumnDef::required("time", ColumnKind::Time),
                ColumnDef::required("cpu", ColumnKind::Number),
                ColumnDef::required("requests", ColumnKind::Number),
                ColumnDef::required("host", ColumnKind::String),
            ],
            LiveOptions::new().max_age("30s"),
        )
        .unwrap()
    }

    /// Feed `ticks` producer ticks (every host, one time) through the
    /// main series and the per-host rollings, as `on_batch` does.
    fn run(agg: &mut Aggregate, live: &mut LiveSeries, hosts: &[&str], times: &[i64]) -> Vec<Tick> {
        let root = live.root();
        live.watch(root, OutputKind::Batch).unwrap();
        let mut out = Vec::new();
        for (k, &t) in times.iter().enumerate() {
            let rows: Vec<(i64, Vec<Option<Value>>)> = hosts
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    let cpu = 0.1 * (i + 1) as f64 + 0.01 * (k % 3) as f64;
                    (
                        t,
                        vec![
                            Some(Value::Number(cpu)),
                            Some(Value::Number(10.0)),
                            Some(Value::String(h.to_string())),
                        ],
                    )
                })
                .collect();
            let outputs = live.push_many(rows).unwrap();
            agg.observe_main(&outputs);
            agg.add_requests(10.0 * hosts.len() as f64);
            let by_host = hosts
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    let cpu = 0.1 * (i + 1) as f64 + 0.01 * (k % 3) as f64;
                    (h.to_string(), vec![(t, cpu, 10.0)])
                })
                .collect();
            agg.push_hosts(by_host);
            out.extend(agg.drain_ticks());
        }
        out
    }

    #[test]
    fn one_tick_per_boundary_with_every_host() {
        let mut live = main_series();
        let mut agg = Aggregate::new(AggOptions::default());
        agg.attach(&mut live).unwrap();
        // Ticks every 50 ms for 1 s: boundaries at 200, 400, 600, 800, 1000.
        let times: Vec<i64> = (0..=20).map(|i| 1_000_000 + i * 50).collect();
        let ticks = run(&mut agg, &mut live, &["api-1", "api-2"], &times);
        let ts: Vec<i64> = ticks.iter().map(|t| t.globals.ts).collect();
        assert_eq!(
            ts,
            vec![1_000_200, 1_000_400, 1_000_600, 1_000_800, 1_001_000]
        );
        for t in &ticks {
            let hosts: Vec<&str> = t.rows.iter().map(|r| r.host.as_str()).collect();
            assert_eq!(hosts, vec!["api-1", "api-2"]);
        }
        let last = &ticks[4];
        // 1m window holds all 21 events by the last boundary.
        assert_eq!(last.rows[0].cpu_n, 21.0);
        assert_eq!(last.rows[0].requests_sum, 210.0);
        // The 200 ms slice: events inside it when the boundary fires.
        assert!(last.rows[0].n_current >= 4, "{}", last.rows[0].n_current);
        assert_eq!(last.globals.events_ingested_total, 42);
        assert_eq!(last.globals.requests_ingested_total, 420.0);
        assert_eq!(last.rows[0].window_age_seconds, 1.0);
        // Snapshot history has every row.
        let (rows, globals) = agg.history();
        assert_eq!(rows.len(), 10);
        assert_eq!(globals.len(), 5);
    }

    #[test]
    fn a_row_after_its_tick_was_sent_is_counted_and_dropped() {
        let mut live = main_series();
        let mut agg = Aggregate::new(AggOptions::default());
        agg.attach(&mut live).unwrap();
        // Both hosts at 0 and 100; at 250 only api-1 arrives (tick 200
        // goes out with api-1 alone), then api-2's 250 in the next batch.
        agg.push_hosts(vec![
            ("api-1".into(), vec![(0, 0.5, 1.0), (100, 0.5, 1.0)]),
            ("api-2".into(), vec![(0, 0.5, 1.0), (100, 0.5, 1.0)]),
        ]);
        assert!(agg.drain_ticks().is_empty());
        agg.push_hosts(vec![("api-1".into(), vec![(250, 0.5, 1.0)])]);
        let ticks = agg.drain_ticks();
        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0].rows.len(), 1);
        agg.push_hosts(vec![("api-2".into(), vec![(250, 0.5, 1.0)])]);
        assert!(agg.drain_ticks().is_empty());
        assert_eq!(agg.late_rows(), 1);
    }

    #[test]
    fn stride_keeps_every_nth_event_per_host() {
        let mut live = main_series();
        let mut agg = Aggregate::new(AggOptions {
            sample_stride: 3,
            ..AggOptions::default()
        });
        agg.attach(&mut live).unwrap();
        let times: Vec<i64> = (0..=20).map(|i| 1_000_000 + i * 50).collect();
        let ticks = run(&mut agg, &mut live, &["api-1"], &times);
        let last = ticks.last().unwrap();
        // 21 events, every 3rd kept: 7.
        assert_eq!(last.rows[0].cpu_n, 7.0);
        // Totals see every event.
        assert_eq!(last.globals.events_ingested_total, 21);
    }

    #[test]
    fn history_drops_old_ticks() {
        let mut live = main_series();
        let mut agg = Aggregate::new(AggOptions {
            history_max_age_ms: 400,
            ..AggOptions::default()
        });
        agg.attach(&mut live).unwrap();
        let times: Vec<i64> = (0..=20).map(|i| 1_000_000 + i * 50).collect();
        run(&mut agg, &mut live, &["api-1"], &times);
        let (rows, globals) = agg.history();
        // Last tick 1_001_000, cutoff 1_000_600: ticks 600, 800, 1000 stay.
        assert_eq!(
            globals.iter().map(|g| g.ts).collect::<Vec<_>>(),
            vec![1_000_600, 1_000_800, 1_001_000]
        );
        assert_eq!(rows.len(), 3);
    }
}
