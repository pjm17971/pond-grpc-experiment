# Producer backpressure (2026-10-28)

Before: both producers gave every subscriber an unbounded queue. The
Rust producer used one `mpsc::unbounded_channel` per subscriber; the
Node producer called `call.write` and ignored its return value. A
subscriber slower than the producer (the Node aggregator at 1000 × 1000) built a backlog in producer memory that no metric showed.

Now:

- **Rust producer:** every subscriber reads from one tokio `broadcast`
  channel of 64 batches. tonic takes the next batch for a stream only
  when HTTP/2 flow control lets it send, so a slow subscriber falls
  behind in the channel; once it is more than 64 batches behind, its
  oldest batches are skipped (`Lagged(n)`) and counted. Sending never
  blocks, so one slow subscriber can't hold up the others. A stalled
  subscriber's drops are counted when it next reads.
- **Node producer:** `boundedWriter` (`packages/producer/src/grpc.ts`)
  writes straight through while `call.write` returns true. After it
  returns false, batches wait in a queue of 64 until `'drain'`, and the
  oldest waiting batch is dropped and counted when the queue is full.
  grpc-js keeps up to 16 more batches in its own stream buffer.
- **Metrics:** with `METRICS_PORT` set, both serve `GET /metrics`:
  `uptimeSec`, `subscribers`, `queueBatches`, `batchesProduced`,
  `rowsProduced`, `droppedBatches`, `droppedRows` (drops summed over
  subscribers).
- **`bench:dev`** shows `Dropped/s` next to `Achieved/s` (`n/a` for a
  producer without `/metrics`).

Not built: a "ready for N" credit protocol between aggregator and
producer.

## Slow subscriber check (`scripts/slow-subscriber.ts`)

Two subscribers on one producer (100 hosts × 200/s); one stops reading
(its stream is paused) for 10 s, then resumes.

| Producer | Produced (batches) | Dropped for the slow one | Fast one received   | Producer memory |
| -------- | ------------------ | ------------------------ | ------------------- | --------------- |
| Rust     | 2,429              | 1,898                    | all but 8 in flight | 5–6 MB flat     |
| Node     | 2,316              | 1,791                    | all but 4 in flight | 57–60 MB flat   |

At 100 hosts × 1000/s the Node test client itself can't decode two
streams of 100k rows/s, so the "fast" subscriber falls behind too and
the Rust producer drops batches for it as well. That's the policy
working, not a fault, but it means this check has to run at a rate the
client can keep up with.

## Bench (1000 × 1000, 20 s, alternated in one batch)

Same batch, `main`'s Rust producer against this one:

| Producer         | Aggregator | Achieved/s        | Dropped/s         |
| ---------------- | ---------- | ----------------- | ----------------- |
| main (unbounded) | Node       | 33,973 / 32,385   | not measured      |
| bounded          | Node       | 39,473 / 38,581   | 961,301 / 963,329 |
| main (unbounded) | Rust       | 251,077 / 258,195 | not measured      |
| bounded          | Rust       | 292,486 / 321,031 | 707,436 / 678,616 |

An earlier batch also ran the Node producer into the Node aggregator:
54,350 / 58,368 achieved, 612,087 / 599,274 dropped.

So no aggregator got slower, and both drop most of a 1M rows/s stream:
the Rust aggregator (with `/live-agg`) takes ~250–320k here, the Node
one ~35–40k. Achieved + dropped comes to ~1M with the Rust producer;
with the Node producer it's ~660k, its own rate limit. I have not
looked into why both aggregators measured a little faster with the
bounded producer. This machine was slower than in earlier batches
(the Rust → Node row was 51k on main before), so compare within a
batch only.
