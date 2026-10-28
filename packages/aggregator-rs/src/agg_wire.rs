//! `/live-agg` frames and per-client top-N projection, matching
//! `packages/shared/src/wire.ts` (`HostTick`, `GlobalsTick`,
//! `aggregate-snapshot`, `aggregate-append`) and the projection rules in
//! `packages/aggregator/src/server.ts` (`projectAppend`,
//! `parseControlMessage`, `parseConnectQuery`,
//! `projectSnapshotHistory`).
//!
//! JSON is written as text, numbers as JavaScript prints them (`60`, not
//! `60.0`), fields in the order Node's object literals give them.

use std::collections::HashSet;
use std::fmt::Write;

use crate::wire::push_number;

#[derive(Debug, Clone, PartialEq)]
pub struct HostTick {
    pub ts: i64,
    pub host: String,
    pub cpu_avg: Option<f64>,
    pub cpu_sd: Option<f64>,
    pub cpu_n: f64,
    pub n_current: u64,
    pub anomalies_above: Vec<u64>,
    pub anomalies_below: Vec<u64>,
    pub requests_avg: Option<f64>,
    pub requests_sum: f64,
    pub requests_n: f64,
    pub window_age_seconds: f64,
    pub cpu_min: Option<f64>,
    pub cpu_max: Option<f64>,
    pub current_avg: Option<f64>,
    pub current_sd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlobalsTick {
    pub ts: i64,
    pub events_ingested_total: u64,
    pub events_per_sec: f64,
    pub evicted_total: u64,
    pub requests_ingested_total: f64,
}

/// `RankKey` in `shared/src/wire.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RankKey {
    CpuAvg,
    CpuSd,
    RequestsSum,
}

impl RankKey {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "cpu_avg" => Some(RankKey::CpuAvg),
            "cpu_sd" => Some(RankKey::CpuSd),
            "requests_sum" => Some(RankKey::RequestsSum),
            _ => None,
        }
    }

    /// Null sorts last (Node coerces it to -Infinity).
    fn of(self, r: &HostTick) -> f64 {
        match self {
            RankKey::CpuAvg => r.cpu_avg,
            RankKey::CpuSd => r.cpu_sd,
            RankKey::RequestsSum => Some(r.requests_sum),
        }
        .filter(|v| !v.is_nan())
        .unwrap_or(f64::NEG_INFINITY)
    }
}

/// Node's `TOP_N_HYSTERESIS_MARGIN`.
const MARGIN: usize = 1;

#[derive(Debug, Clone, PartialEq)]
pub struct ClientPrefs {
    pub top_n: Option<usize>,
    pub rank_by: RankKey,
    pub last_top_hosts: Option<HashSet<String>>,
}

impl Default for ClientPrefs {
    fn default() -> Self {
        ClientPrefs {
            top_n: None,
            rank_by: RankKey::CpuAvg,
            last_top_hosts: None,
        }
    }
}

/// `projectAppend`: `None` means "send the rows unchanged" (no filter,
/// or everyone fits); otherwise the kept rows, highest rank first.
/// Updates the client's hysteresis state either way.
pub fn project<'a>(rows: &'a [HostTick], prefs: &mut ClientPrefs) -> Option<Vec<&'a HostTick>> {
    let n = match prefs.top_n {
        None => {
            prefs.last_top_hosts = None;
            return None;
        }
        Some(n) => n,
    };
    if rows.len() <= n {
        prefs.last_top_hosts = Some(rows.iter().map(|r| r.host.clone()).collect());
        return None;
    }
    let key = prefs.rank_by;
    let mut sorted: Vec<&HostTick> = rows.iter().collect();
    // Stable, descending; equal (including both null) keep their order,
    // as JS sort does with a comparator that returns NaN or 0.
    sorted.sort_by(|a, b| {
        key.of(b)
            .partial_cmp(&key.of(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep: HashSet<String> = sorted.iter().take(n).map(|r| r.host.clone()).collect();
    if let Some(last) = &prefs.last_top_hosts {
        let upper = (n + MARGIN).min(sorted.len());
        for r in &sorted[n..upper] {
            if last.contains(&r.host) {
                keep.insert(r.host.clone());
            }
        }
    }
    let out = sorted
        .into_iter()
        .filter(|r| keep.contains(&r.host))
        .collect();
    prefs.last_top_hosts = Some(keep);
    Some(out)
}

/// `projectSnapshotHistory`: project tick by tick (rows grouped by `ts`,
/// ascending), carrying hysteresis across ticks.
pub fn project_history(rows: &[HostTick], prefs: &mut ClientPrefs) -> Vec<HostTick> {
    if prefs.top_n.is_none() {
        return rows.to_vec();
    }
    let mut sorted: Vec<&HostTick> = rows.iter().collect();
    sorted.sort_by_key(|r| r.ts);
    let mut out = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let ts = sorted[i].ts;
        let mut j = i;
        while j < sorted.len() && sorted[j].ts == ts {
            j += 1;
        }
        let tick: Vec<HostTick> = sorted[i..j].iter().map(|r| (*r).clone()).collect();
        match project(&tick, prefs) {
            None => out.extend(tick.iter().cloned()),
            Some(kept) => out.extend(kept.into_iter().cloned()),
        }
        i = j;
    }
    out
}

/// `parseControlMessage`: `{ "type": "set-top-n", "n": number | null,
/// "by"?: RankKey }`. `None` for anything else. `Some((top_n, by))`,
/// where `by: None` keeps the client's current key.
pub fn parse_control(text: &str, host_count: usize) -> Option<(Option<usize>, Option<RankKey>)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = v.as_object()?;
    if obj.get("type")?.as_str()? != "set-top-n" {
        return None;
    }
    let by = match obj.get("by") {
        None => None,
        Some(b) => Some(RankKey::parse(b.as_str()?)?),
    };
    match obj.get("n") {
        Some(serde_json::Value::Null) => Some((None, by)),
        Some(n) => {
            let n = n.as_f64()?;
            if !n.is_finite() {
                return None;
            }
            let upper = host_count.max(1000) as f64;
            Some((Some(n.floor().min(upper).max(1.0) as usize), by))
        }
        // JS reads a missing `n` as undefined, which is not a number.
        None => None,
    }
}

/// `parseConnectQuery`: `?n=<int>&by=<RankKey>` on the WebSocket URL.
/// Bad values fall back to no filter / `cpu_avg`.
pub fn parse_connect_query(query: Option<&str>) -> ClientPrefs {
    let mut prefs = ClientPrefs::default();
    let Some(q) = query else { return prefs };
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "n" if !v.is_empty() => {
                if let Ok(n) = v.trim().parse::<f64>() {
                    if n.is_finite() {
                        prefs.top_n = Some(n.floor().clamp(1.0, 1000.0) as usize);
                    }
                }
            }
            "by" => {
                if let Some(k) = RankKey::parse(v) {
                    prefs.rank_by = k;
                }
            }
            _ => {}
        }
    }
    prefs
}

fn push_opt(out: &mut String, v: Option<f64>) {
    match v {
        Some(v) => push_number(out, v),
        None => out.push_str("null"),
    }
}

fn push_counts(out: &mut String, xs: &[u64]) {
    out.push('[');
    for (i, x) in xs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "{x}");
    }
    out.push(']');
}

fn push_host_tick(out: &mut String, r: &HostTick) {
    let _ = write!(out, "{{\"ts\":{},\"host\":", r.ts);
    out.push_str(&serde_json::to_string(&r.host).unwrap_or_else(|_| "null".into()));
    out.push_str(",\"cpu_avg\":");
    push_opt(out, r.cpu_avg);
    out.push_str(",\"cpu_sd\":");
    push_opt(out, r.cpu_sd);
    out.push_str(",\"cpu_n\":");
    push_number(out, r.cpu_n);
    let _ = write!(out, ",\"n_current\":{},\"anomalies_above\":", r.n_current);
    push_counts(out, &r.anomalies_above);
    out.push_str(",\"anomalies_below\":");
    push_counts(out, &r.anomalies_below);
    out.push_str(",\"requests_avg\":");
    push_opt(out, r.requests_avg);
    out.push_str(",\"requests_sum\":");
    push_number(out, r.requests_sum);
    out.push_str(",\"requests_n\":");
    push_number(out, r.requests_n);
    out.push_str(",\"window_age_seconds\":");
    push_number(out, r.window_age_seconds);
    out.push_str(",\"cpu_min\":");
    push_opt(out, r.cpu_min);
    out.push_str(",\"cpu_max\":");
    push_opt(out, r.cpu_max);
    out.push_str(",\"current_avg\":");
    push_opt(out, r.current_avg);
    out.push_str(",\"current_sd\":");
    push_opt(out, r.current_sd);
    out.push('}');
}

fn push_globals(out: &mut String, g: &GlobalsTick) {
    let _ = write!(
        out,
        "{{\"ts\":{},\"events_ingested_total\":{},\"events_per_sec\":",
        g.ts, g.events_ingested_total
    );
    push_number(out, g.events_per_sec);
    let _ = write!(
        out,
        ",\"evicted_total\":{},\"requests_ingested_total\":",
        g.evicted_total
    );
    push_number(out, g.requests_ingested_total);
    out.push('}');
}

fn push_rows<'a>(out: &mut String, rows: impl Iterator<Item = &'a HostTick>) {
    out.push('[');
    for (i, r) in rows.enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_host_tick(out, r);
    }
    out.push(']');
}

pub fn append_frame<'a>(rows: impl Iterator<Item = &'a HostTick>, globals: &GlobalsTick) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("{\"type\":\"aggregate-append\",\"rows\":");
    push_rows(&mut out, rows);
    out.push_str(",\"globals\":");
    push_globals(&mut out, globals);
    out.push('}');
    out
}

pub fn snapshot_frame(thresholds: &[f64], rows: &[HostTick], globals: &[GlobalsTick]) -> String {
    let mut out = String::with_capacity(64 + rows.len() * 400);
    out.push_str("{\"type\":\"aggregate-snapshot\",\"thresholds\":[");
    for (i, t) in thresholds.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_number(&mut out, *t);
    }
    out.push_str("],\"rows\":");
    push_rows(&mut out, rows.iter());
    out.push_str(",\"globals\":[");
    for (i, g) in globals.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_globals(&mut out, g);
    }
    out.push_str("]}");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(host: &str, cpu_avg: Option<f64>, ts: i64) -> HostTick {
        HostTick {
            ts,
            host: host.into(),
            cpu_avg,
            cpu_sd: Some(0.1),
            cpu_n: 60.0,
            n_current: 2,
            anomalies_above: vec![1, 0, 0, 0, 0],
            anomalies_below: vec![0; 5],
            requests_avg: Some(100.0),
            requests_sum: 6000.0,
            requests_n: 60.0,
            window_age_seconds: 12.5,
            cpu_min: Some(0.4),
            cpu_max: None,
            current_avg: Some(0.45),
            current_sd: None,
        }
    }

    #[test]
    fn host_tick_json_matches_node_shape() {
        let g = GlobalsTick {
            ts: 1000,
            events_ingested_total: 5,
            events_per_sec: 3.0,
            evicted_total: 0,
            requests_ingested_total: 420.0,
        };
        let f = append_frame([row("api-1", Some(0.5), 1000)].iter(), &g);
        assert_eq!(
            f,
            "{\"type\":\"aggregate-append\",\"rows\":[{\"ts\":1000,\"host\":\"api-1\",\"cpu_avg\":0.5,\
             \"cpu_sd\":0.1,\"cpu_n\":60,\"n_current\":2,\"anomalies_above\":[1,0,0,0,0],\
             \"anomalies_below\":[0,0,0,0,0],\"requests_avg\":100,\"requests_sum\":6000,\
             \"requests_n\":60,\"window_age_seconds\":12.5,\"cpu_min\":0.4,\"cpu_max\":null,\
             \"current_avg\":0.45,\"current_sd\":null}],\"globals\":{\"ts\":1000,\
             \"events_ingested_total\":5,\"events_per_sec\":3,\"evicted_total\":0,\
             \"requests_ingested_total\":420}}"
        );
        let s = snapshot_frame(&[1.0, 1.5], &[], &[g]);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "aggregate-snapshot");
        assert_eq!(v["thresholds"], serde_json::json!([1, 1.5]));
        assert_eq!(v["globals"][0]["ts"], 1000);
    }

    fn hosts(v: &[&HostTick]) -> Vec<String> {
        v.iter().map(|r| r.host.clone()).collect()
    }

    #[test]
    fn projection_cuts_with_one_rank_of_hysteresis() {
        let mut prefs = ClientPrefs {
            top_n: Some(2),
            ..ClientPrefs::default()
        };
        let t1 = vec![
            row("a", Some(0.9), 1),
            row("b", Some(0.8), 1),
            row("c", Some(0.7), 1),
            row("d", None, 1),
        ];
        assert_eq!(hosts(&project(&t1, &mut prefs).unwrap()), vec!["a", "b"]);
        // b drops to rank 3: kept one more tick (margin 1); d (rank 4) not.
        let t2 = vec![
            row("a", Some(0.9), 2),
            row("b", Some(0.6), 2),
            row("c", Some(0.7), 2),
            row("d", Some(0.5), 2),
        ];
        assert_eq!(
            hosts(&project(&t2, &mut prefs).unwrap()),
            vec!["a", "c", "b"]
        );
        // b drops to rank 4: gone.
        let t3 = vec![
            row("a", Some(0.9), 3),
            row("b", Some(0.1), 3),
            row("c", Some(0.7), 3),
            row("d", Some(0.5), 3),
        ];
        assert_eq!(hosts(&project(&t3, &mut prefs).unwrap()), vec!["a", "c"]);
        // Everyone fits: unchanged, hysteresis set to the full host set.
        prefs.top_n = Some(10);
        assert!(project(&t3, &mut prefs).is_none());
        assert_eq!(prefs.last_top_hosts.as_ref().unwrap().len(), 4);
        // No filter: unchanged, hysteresis cleared.
        prefs.top_n = None;
        assert!(project(&t3, &mut prefs).is_none());
        assert!(prefs.last_top_hosts.is_none());
    }

    #[test]
    fn rank_by_requests_sum_and_null_last() {
        let mut prefs = ClientPrefs {
            top_n: Some(1),
            rank_by: RankKey::CpuSd,
            last_top_hosts: None,
        };
        let mut a = row("a", Some(0.9), 1);
        a.cpu_sd = None;
        let b = row("b", Some(0.1), 1);
        assert_eq!(
            hosts(&project(&[a.clone(), b.clone()], &mut prefs).unwrap()),
            vec!["b"]
        );
        prefs.rank_by = RankKey::RequestsSum;
        prefs.last_top_hosts = None;
        let mut c = row("c", None, 1);
        c.requests_sum = 9000.0;
        assert_eq!(hosts(&project(&[a, c], &mut prefs).unwrap()), vec!["c"]);
    }

    #[test]
    fn history_projects_tick_by_tick() {
        let mut prefs = ClientPrefs {
            top_n: Some(1),
            ..ClientPrefs::default()
        };
        let rows = vec![
            row("a", Some(0.9), 1),
            row("b", Some(0.8), 1),
            row("a", Some(0.1), 2),
            row("b", Some(0.8), 2),
        ];
        let out = project_history(&rows, &mut prefs);
        // Tick 2: b is rank 1, a (rank 2) carried over by hysteresis.
        let got: Vec<(i64, &str)> = out.iter().map(|r| (r.ts, r.host.as_str())).collect();
        assert_eq!(got, vec![(1, "a"), (2, "b"), (2, "a")]);
        assert_eq!(prefs.last_top_hosts.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn control_messages_parse_like_node() {
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":5}"#, 10),
            Some((Some(5), None))
        );
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":null,"by":"cpu_sd"}"#, 10),
            Some((None, Some(RankKey::CpuSd)))
        );
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":0}"#, 10),
            Some((Some(1), None))
        );
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":5000}"#, 10),
            Some((Some(1000), None))
        );
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":2.7}"#, 10),
            Some((Some(2), None))
        );
        assert_eq!(
            parse_control(r#"{"type":"set-top-n","n":5,"by":"cpu_argh"}"#, 10),
            None
        );
        assert_eq!(parse_control(r#"{"type":"other","n":5}"#, 10), None);
        assert_eq!(parse_control(r#"{"type":"set-top-n","n":"5"}"#, 10), None);
        assert_eq!(parse_control("garbage", 10), None);
    }

    #[test]
    fn connect_query_parses_like_node() {
        let p = parse_connect_query(Some("n=5&by=requests_sum"));
        assert_eq!((p.top_n, p.rank_by), (Some(5), RankKey::RequestsSum));
        let p = parse_connect_query(Some("n=abc&by=nope"));
        assert_eq!((p.top_n, p.rank_by), (None, RankKey::CpuAvg));
        let p = parse_connect_query(Some("n=99999"));
        assert_eq!(p.top_n, Some(1000));
        assert_eq!(parse_connect_query(None), ClientPrefs::default());
    }
}
