//! Native timing of club-level decisions (plan, Task 11).
//!
//! Ignored by default; CI runs it (together with the release-only
//! decision-vector drift test) with
//! `cargo test --release -p bg-bot --test perf --test vectors -- --include-ignored --show-output`
//! and checks that this test actually ran. `--show-output` (or
//! `--nocapture`) prints the per-decision timings and the mean.

use std::time::Instant;

use bg_bot::{Bot, Level};

#[path = "../examples/gen_decisions.rs"]
#[allow(dead_code)]
mod gen_decisions;

/// Mean wall-clock budget per club decision, natively (the browser target is
/// about three times slower; the plan budgets 2 s there).
const MEAN_BUDGET_MS: f64 = 700.0;
const DECISIONS: usize = 10;

#[test]
#[ignore = "timing test; run natively in --release with `-- --ignored perf`"]
fn perf_mean_club_decision_from_middlegame_is_under_budget() {
    let bot = Bot::new(Level::Club);
    let ctx = gen_decisions::money();
    let samples = gen_decisions::perf_positions(DECISIONS);
    assert_eq!(samples.len(), DECISIONS);

    let mut total_ms = 0.0;
    for (i, sample) in samples.iter().enumerate() {
        let started = Instant::now();
        let (play, candidates) = bot.choose_play(&ctx, &sample.pos, sample.dice, sample.seed);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        total_ms += ms;
        println!(
            "decision {i:2}: {:?} {} candidates -> {play} in {ms:.1} ms",
            sample.dice,
            candidates.len()
        );
    }
    #[allow(clippy::cast_precision_loss)]
    let mean_ms = total_ms / DECISIONS as f64;
    println!("mean over {DECISIONS} club decisions: {mean_ms:.1} ms (budget {MEAN_BUDGET_MS} ms)");
    assert!(
        mean_ms < MEAN_BUDGET_MS,
        "mean club decision took {mean_ms:.1} ms, budget {MEAN_BUDGET_MS} ms"
    );
}
