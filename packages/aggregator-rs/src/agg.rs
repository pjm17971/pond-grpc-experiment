//! The `/live-agg` pipeline: per-host rolling stats every 200 ms, as
//! `packages/aggregator/src/aggregate.ts` builds them.
//!
//! Node runs one partitioned fused rolling:
//! `live.partitionBy('host')[.sample({ stride })].rolling({ '1m': {...},
//! '200ms': {...} }, { trigger: Trigger.clock(every 200ms) })`. pond-rs
//! builds the same on the main series: `partition_by("host")`, an optional
//! `sample` per partition, then `partition_rolling_windows`. As in pond-ts,
//! when any host's event crosses into a new 200 ms bucket every host known
//! so far emits a row for it (quiet hosts included), all in one push.
//!
//! Globals (`events_per_sec`, running totals) come from the main series,
//! as in Node: a 1 s count rolling on the same clock, and the root's
//! batch and evict outputs.

use std::collections::VecDeque;

use pond_rs::live::{
    History, LivePartitionedRolling, LiveRolling, LiveSeries, Node, Output, OutputKind,
    PartitionOptions, RollingOptions, RollingWindow, Trigger,
};
use pond_rs::{Agg, Reducer, Sample, Scalar, Sequence};

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

pub struct Aggregate {
    opts: AggOptions,
    trigger: Trigger,
    events_per_sec: Option<Node<LiveRolling>>,
    hosts: Option<Node<LivePartitionedRolling>>,
    latest_events_per_sec: f64,
    events_ingested: u64,
    evicted: u64,
    requests_ingested: f64,
    first_event_ts: Option<i64>,
    pending: Vec<HostTick>,
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
            events_per_sec: None,
            hosts: None,
            latest_events_per_sec: 0.0,
            events_ingested: 0,
            evicted: 0,
            requests_ingested: 0.0,
            first_event_ts: None,
            pending: Vec::new(),
            history_rows: VecDeque::new(),
            history_globals: VecDeque::new(),
        }
    }

    /// Build the globals rolling and the per-host rolling on the main
    /// series (which needs a string `host` column), and watch what the
    /// totals need (root batch and evict, rolling events).
    pub fn attach(&mut self, live: &mut LiveSeries) -> pond_rs::Result<()> {
        let root = live.root();
        let opts = RollingOptions::new()
            .trigger(self.trigger)
            .history(History::Off);
        let eps = live.rolling_windows(
            root,
            &[RollingWindow::new(
                "1s",
                &[Agg::new("events_per_sec", "cpu", Reducer::Count)],
            )],
            &opts,
        )?;
        live.watch(eps, OutputKind::Event)?;
        live.watch(root, OutputKind::Evict)?;

        // The rolling keeps its own windows, so each partition only needs
        // to hold the event being routed (the main series keeps 30 s for
        // `/live`; a partition would otherwise copy it).
        let by_host = live.partition_by(root, "host", &PartitionOptions::new().max_events(1))?;
        let tick = format!("{}ms", self.opts.tick_ms);
        let windows = [
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
        ];
        let stride = self.opts.sample_stride.max(1) as usize;
        let hosts = if stride > 1 {
            let sampled = live.per_partition(by_host, move |live, part| {
                Ok(live.sample(part, Sample::Stride(stride))?.id())
            })?;
            live.partition_rolling_windows(sampled, &windows, &opts)?
        } else {
            live.partition_rolling_windows(by_host, &windows, &opts)?
        };
        live.watch(hosts, OutputKind::Event)?;
        self.events_per_sec = Some(eps);
        self.hosts = Some(hosts);
        Ok(())
    }

    /// Read the main series' outputs for one push: totals, the latest
    /// events-per-second, and the per-host rows. `Batch` outputs are read
    /// here too (the `/live` fan-out reads them separately). Totals are
    /// read first, so a tick's globals include the whole push, as before.
    pub fn observe_main(&mut self, outputs: &[Output]) {
        let eps = self.events_per_sec.map(|n| n.id());
        let hosts = self.hosts.map(|n| n.id());
        let mut host_rows = Vec::new();
        for out in outputs {
            match out {
                Output::Batch { events, .. } => {
                    self.events_ingested += events.len() as u64;
                    if self.first_event_ts.is_none() {
                        self.first_event_ts = events.first().map(|e| e.begin());
                    }
                }
                Output::Evict { events, .. } => self.evicted += events.len() as u64,
                Output::Event { node, event } if Some(*node) == eps => {
                    if let Ok(Some(v)) = event.number("events_per_sec") {
                        self.latest_events_per_sec = v;
                    }
                }
                Output::Event { node, event } if Some(*node) == hosts => host_rows.push(event),
                _ => {}
            }
        }
        for e in host_rows {
            let row = self.host_tick(e);
            self.pending.push(row);
        }
    }

    /// `requests` summed over a batch (Node adds `e.get('requests')` per
    /// event in its batch listener).
    pub fn add_requests(&mut self, sum: f64) {
        self.requests_ingested += sum;
    }

    fn host_tick(&self, e: &pond_rs::live::LiveEvent) -> HostTick {
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
            host: e
                .string("host")
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
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
    /// Every host's row for a tick comes out of the same push.
    pub fn drain_ticks(&mut self) -> Vec<Tick> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let rows = std::mem::take(&mut self.pending);
        let mut ticks: Vec<Tick> = Vec::new();
        for row in rows {
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
    use pond_rs::live::LiveOptions;
    use pond_rs::{ColumnDef, ColumnKind, Value};

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

    /// Push one producer tick per time (every host listed, one row each)
    /// through the main series, as `on_batch` does.
    fn push(
        agg: &mut Aggregate,
        live: &mut LiveSeries,
        t: i64,
        k: usize,
        hosts: &[&str],
    ) -> Vec<Tick> {
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
        agg.drain_ticks()
    }

    fn run(agg: &mut Aggregate, live: &mut LiveSeries, hosts: &[&str], times: &[i64]) -> Vec<Tick> {
        let root = live.root();
        live.watch(root, OutputKind::Batch).unwrap();
        let mut out = Vec::new();
        for (k, &t) in times.iter().enumerate() {
            out.extend(push(agg, live, t, k, hosts));
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
    fn every_host_emits_when_the_first_one_crosses_a_tick() {
        let mut live = main_series();
        let mut agg = Aggregate::new(AggOptions::default());
        agg.attach(&mut live).unwrap();
        let root = live.root();
        live.watch(root, OutputKind::Batch).unwrap();
        assert!(push(&mut agg, &mut live, 0, 0, &["api-1", "api-2"]).is_empty());
        assert!(push(&mut agg, &mut live, 100, 0, &["api-1", "api-2"]).is_empty());
        // Only api-1 at 250: the 200 tick still has a row for both, and
        // api-2's comes from its window as of 250 (as pond-ts).
        let ticks = push(&mut agg, &mut live, 250, 0, &["api-1"]);
        assert_eq!(ticks.len(), 1);
        let hosts: Vec<&str> = ticks[0].rows.iter().map(|r| r.host.as_str()).collect();
        assert_eq!(hosts, vec!["api-1", "api-2"]);
        // api-1's crossing event is in its 1m window; api-2 has its two.
        assert_eq!(ticks[0].rows[0].cpu_n, 3.0);
        assert_eq!(ticks[0].rows[1].cpu_n, 2.0);
        // api-2's late 250 goes into the next tick, not dropped.
        assert!(push(&mut agg, &mut live, 250, 0, &["api-2"]).is_empty());
        let ticks = push(&mut agg, &mut live, 400, 0, &["api-1"]);
        assert_eq!(ticks[0].rows[1].cpu_n, 3.0);
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
