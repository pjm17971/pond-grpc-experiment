//! Port of `packages/producer/src/simulator.ts`: per-host baseline, a
//! slow mean-reverting walk stepped once per wall-clock second, ~2%
//! per-host-per-second anomaly bursts, and per-event noise. Constants
//! and formulas match the Node file; the random source is a small
//! xorshift instead of `Math.random`, so values match in distribution,
//! not bit for bit.

use crate::proto::{Event, EventBatch};

const HOST_MEANS: [f64; 8] = [0.55, 0.45, 0.65, 0.5, 0.6, 0.4, 0.7, 0.35];
const WALK_INTERVAL_MS: i64 = 1000;
const WALK_REVERSION: f64 = 0.15;
const WALK_DRIFT: f64 = 0.025;
const WALK_LO: f64 = 0.15;
const WALK_HI: f64 = 0.9;
const BURST_PROB_PER_SEC: f64 = 0.02;
const BURST_AMP: f64 = 0.25;
const BURST_DURATION_MS: i64 = 4_000;

/// xorshift64*: uniform in [0, 1), like `Math.random()`.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }

    pub fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    }
}

pub struct Simulator {
    variability: f64,
    hosts: Vec<String>,
    host_means: Vec<f64>,
    burst_end_ms: Vec<i64>,
    last_walk_ms: i64,
    rng: Rng,
}

impl Simulator {
    pub fn new(host_count: usize, variability: f64, now_ms: i64, seed: u64) -> Self {
        Simulator {
            variability,
            // `HOSTS` in shared/src/hosts.ts is api-1..api-10, and the Node
            // simulator synthesises `api-${i + 1}` past it: the same names.
            hosts: (0..host_count).map(|i| format!("api-{}", i + 1)).collect(),
            host_means: (0..host_count)
                .map(|i| HOST_MEANS[i % HOST_MEANS.len()])
                .collect(),
            burst_end_ms: vec![0; host_count],
            last_walk_ms: now_ms,
            rng: Rng::new(seed),
        }
    }

    /// Restart the once-a-second walk clock at `now_ms`. Called when a
    /// subscriber arrives after an idle stretch (the simulator does not
    /// run with nobody listening), so the first tick does not treat the
    /// whole gap as elapsed walk time (a huge step, and a burst on every
    /// host at once).
    pub fn resume(&mut self, now_ms: i64) {
        self.last_walk_ms = now_ms;
    }

    /// One tick: one event per host, all stamped `now_ms`.
    pub fn tick(&mut self, now_ms: i64) -> EventBatch {
        let n = self.hosts.len();
        if now_ms - self.last_walk_ms >= WALK_INTERVAL_MS {
            let elapsed_sec = (now_ms - self.last_walk_ms) as f64 / 1000.0;
            self.last_walk_ms = now_ms;
            for i in 0..n {
                let baseline = HOST_MEANS[i % HOST_MEANS.len()];
                let reversion = WALK_REVERSION * elapsed_sec * (baseline - self.host_means[i]);
                let noise = (self.rng.next() - 0.5 + (self.rng.next() - 0.5))
                    * WALK_DRIFT
                    * elapsed_sec.sqrt();
                self.host_means[i] =
                    (self.host_means[i] + reversion + noise).clamp(WALK_LO, WALK_HI);
                if now_ms >= self.burst_end_ms[i]
                    && self.rng.next() < BURST_PROB_PER_SEC * elapsed_sec
                {
                    self.burst_end_ms[i] = now_ms + BURST_DURATION_MS;
                }
            }
        }
        let mut events = Vec::with_capacity(n);
        for i in 0..n {
            let burst = if now_ms < self.burst_end_ms[i] {
                BURST_AMP
            } else {
                0.0
            };
            let cpu = (self.host_means[i] + burst + (self.rng.next() - 0.5) * self.variability)
                .clamp(0.0, 1.0);
            events.push(Event {
                time_ms: now_ms,
                cpu,
                requests: (self.rng.next() * 200.0).floor() as i64,
                host: self.hosts[i].clone(),
            });
        }
        EventBatch { events }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_event_per_host_with_node_names() {
        let mut s = Simulator::new(12, 0.4, 0, 7);
        let b = s.tick(5);
        assert_eq!(b.events.len(), 12);
        assert_eq!(b.events[0].host, "api-1");
        assert_eq!(b.events[9].host, "api-10");
        assert_eq!(b.events[11].host, "api-12");
        for e in &b.events {
            assert_eq!(e.time_ms, 5);
            assert!((0.0..=1.0).contains(&e.cpu));
            assert!((0..200).contains(&e.requests));
        }
    }

    #[test]
    fn cpu_centres_on_host_baseline() {
        // Over many ticks inside one walk second, host 0's mean cpu sits
        // near its 0.55 baseline (noise is symmetric, ±0.2).
        let mut s = Simulator::new(1, 0.4, 0, 3);
        let n = 20_000;
        let sum: f64 = (0..n).map(|_| s.tick(0).events[0].cpu).sum();
        assert!((sum / n as f64 - 0.55).abs() < 0.01, "{}", sum / n as f64);
    }

    #[test]
    fn resume_after_idle_does_not_burst_every_host() {
        // Without `resume`, a 100 s gap makes the burst chance 0.02 * 100
        // = 2, so every host would start a burst on the first tick.
        let mut s = Simulator::new(1000, 0.4, 0, 11);
        s.resume(100_000);
        s.tick(100_000);
        assert!(s.burst_end_ms.iter().all(|&t| t == 0));
        // A real second later the walk steps as usual: ~2% of hosts burst.
        s.tick(101_000);
        let bursting = s.burst_end_ms.iter().filter(|&&t| t > 0).count();
        assert!((5..=50).contains(&bursting), "{bursting}");
    }

    #[test]
    fn rng_is_uniform_enough() {
        let mut r = Rng::new(1);
        let n = 100_000;
        let xs: Vec<f64> = (0..n).map(|_| r.next()).collect();
        assert!(xs.iter().all(|&x| (0.0..1.0).contains(&x)));
        let mean = xs.iter().sum::<f64>() / n as f64;
        assert!((mean - 0.5).abs() < 0.01);
    }
}
