//! JSON frames for `/live`, matching `packages/shared/src/wire.ts`:
//! `{"type":"snapshot","rows":[...]}` then `{"type":"append","rows":[...]}`,
//! each row `[time_ms, cpu, requests, host]` (pond-ts `toJsonRow` tuple
//! form). Written as text directly; building a `serde_json::Value` tree
//! per frame is slower.

use std::fmt::Write;

use crate::proto;

#[derive(Clone, Debug)]
pub struct Row {
    pub time_ms: i64,
    pub cpu: f64,
    pub requests: i64,
    pub host: String,
}

impl From<proto::Event> for Row {
    fn from(e: proto::Event) -> Self {
        Row {
            time_ms: e.time_ms,
            cpu: e.cpu,
            requests: e.requests,
            host: e.host,
        }
    }
}

fn push_row(out: &mut String, r: &Row) {
    out.push('[');
    let _ = write!(out, "{},", r.time_ms);
    push_number(out, r.cpu);
    let _ = write!(out, ",{},", r.requests);
    // Host names are plain text; serde_json escapes anything unusual.
    out.push_str(&serde_json::to_string(&r.host).unwrap_or_else(|_| "null".into()));
    out.push(']');
}

/// JSON has no NaN/Infinity; pond-ts `toJsonRow` writes a gap as `null`.
fn push_number(out: &mut String, v: f64) {
    if v.is_finite() {
        // `{}` on f64 prints the shortest text that reads back exactly,
        // like JS `String(number)` for ordinary values.
        let _ = write!(out, "{v}");
    } else {
        out.push_str("null");
    }
}

fn frame<'a>(kind: &str, rows: impl Iterator<Item = &'a Row>, hint: usize) -> String {
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

pub fn append_frame(rows: &[Row]) -> String {
    frame("append", rows.iter(), rows.len())
}

pub fn snapshot_frame<'a>(rows: impl ExactSizeIterator<Item = &'a Row>) -> String {
    let n = rows.len();
    frame("snapshot", rows, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(t: i64, cpu: f64, req: i64, host: &str) -> Row {
        Row {
            time_ms: t,
            cpu,
            requests: req,
            host: host.into(),
        }
    }

    #[test]
    fn append_frame_is_valid_json_in_tuple_form() {
        let f = append_frame(&[row(1_700_000_000_000, 0.25, 3, "api-1"), row(1_700_000_000_001, 1.0, 0, "a\"b")]);
        let v: serde_json::Value = serde_json::from_str(&f).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "append",
                "rows": [[1_700_000_000_000i64, 0.25, 3, "api-1"], [1_700_000_000_001i64, 1, 0, "a\"b"]]
            })
        );
    }

    #[test]
    fn non_finite_cpu_is_null() {
        let f = append_frame(&[row(1, f64::NAN, 1, "h")]);
        assert_eq!(f, "{\"type\":\"append\",\"rows\":[[1,null,1,\"h\"]]}");
    }

    #[test]
    fn empty_snapshot() {
        let rows: Vec<Row> = vec![];
        assert_eq!(snapshot_frame(rows.iter()), "{\"type\":\"snapshot\",\"rows\":[]}");
    }
}
