//! JSON frames for `/live`, matching `packages/shared/src/wire.ts`:
//! `{"type":"snapshot","rows":[...]}` then `{"type":"append","rows":[...]}`,
//! each row `[time_ms, cpu, requests, host]` (pond-ts `toJsonRow` tuple
//! form). Written as text directly; building a `serde_json::Value` tree
//! per frame is slower.

use std::fmt::Write;

use pond_rs::Value;
use pond_rs::live::LiveEvent;

/// One event as `[time_ms, cpu, requests, host]`, cells in schema order.
fn push_row(out: &mut String, e: &LiveEvent) {
    let _ = write!(out, "[{}", e.begin());
    for cell in e.values() {
        out.push(',');
        match cell {
            Some(Value::Number(v)) => push_number(out, *v),
            // Host names are plain text; serde_json escapes anything unusual.
            Some(Value::String(s)) => {
                out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "null".into()))
            }
            // The schema has no other kinds; a gap is `null`.
            _ => out.push_str("null"),
        }
    }
    out.push(']');
}

/// JSON has no NaN/Infinity; pond-ts `toJsonRow` writes a gap as `null`.
fn push_number(out: &mut String, v: f64) {
    if v.is_finite() {
        // `{}` on f64 prints the shortest text that reads back exactly,
        // like JS `String(number)` for ordinary values (3.0 prints `3`).
        let _ = write!(out, "{v}");
    } else {
        out.push_str("null");
    }
}

fn frame<'a>(kind: &str, rows: impl Iterator<Item = &'a LiveEvent>, hint: usize) -> String {
    let mut out = String::with_capacity(32 + hint * 48);
    out.push_str("{\"type\":\"");
    out.push_str(kind);
    out.push_str("\",\"rows\":[");
    for (i, r) in rows.enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_row(&mut out, r);
    }
    out.push_str("]}");
    out
}

pub fn append_frame(rows: &[LiveEvent]) -> String {
    frame("append", rows.iter(), rows.len())
}

pub fn snapshot_frame<'a>(rows: impl ExactSizeIterator<Item = &'a LiveEvent>) -> String {
    let n = rows.len();
    frame("snapshot", rows, n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pond_rs::live::{LiveSeries, Output, OutputKind};
    use pond_rs::{ColumnDef, ColumnKind};

    fn events(rows: Vec<(i64, f64, f64, &str)>) -> Vec<LiveEvent> {
        let mut live = LiveSeries::new(
            "t",
            vec![
                ColumnDef::required("time", ColumnKind::Time),
                ColumnDef::optional("cpu", ColumnKind::Number),
                ColumnDef::required("requests", ColumnKind::Number),
                ColumnDef::required("host", ColumnKind::String),
            ],
        )
        .unwrap();
        let root = live.root();
        live.watch(root, OutputKind::Batch).unwrap();
        let out = live
            .push_many(rows.into_iter().map(|(t, cpu, req, host)| {
                let cpu = if cpu.is_nan() { None } else { Some(Value::Number(cpu)) };
                (t, vec![cpu, Some(Value::Number(req)), Some(Value::String(host.into()))])
            }))
            .unwrap();
        match out.into_iter().next() {
            Some(Output::Batch { events, .. }) => events,
            other => panic!("expected a batch, got {other:?}"),
        }
    }

    #[test]
    fn append_frame_is_valid_json_in_tuple_form() {
        let f = append_frame(&events(vec![
            (1_700_000_000_000, 0.25, 3.0, "api-1"),
            (1_700_000_000_001, 1.0, 0.0, "a\"b"),
        ]));
        let v: serde_json::Value = serde_json::from_str(&f).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "append",
                "rows": [[1_700_000_000_000i64, 0.25, 3, "api-1"], [1_700_000_000_001i64, 1, 0, "a\"b"]]
            })
        );
        // Whole numbers print as JS does: `3`, not `3.0`.
        assert!(f.contains("0.25,3,"));
    }

    #[test]
    fn gap_is_null() {
        let f = append_frame(&events(vec![(1, f64::NAN, 1.0, "h")]));
        assert_eq!(f, "{\"type\":\"append\",\"rows\":[[1,null,1,\"h\"]]}");
    }

    #[test]
    fn empty_snapshot() {
        let rows: Vec<LiveEvent> = vec![];
        assert_eq!(snapshot_frame(rows.iter()), "{\"type\":\"snapshot\",\"rows\":[]}");
    }
}
