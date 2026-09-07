//! The committed decision vectors in `engine/vectors/decisions.json` match
//! the generator and the bot.

use std::collections::BTreeSet;

use bg_bot::Level;
use bg_core::moves::legal_plays;
use bg_core::{Board, Dice, Player, Position};

#[path = "../examples/gen_decisions.rs"]
#[allow(dead_code)]
mod gen_decisions;

use gen_decisions::{
    BEAROFF_POSITIONS, DecisionVector, MIDDLEGAME_POSITIONS, OPENING_ROLLS, RACE_POSITIONS,
};

const DECISIONS_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/decisions.json");

const REGENERATE: &str = "regenerate with `cargo run --release -p bg-bot --example gen_decisions -- decisions vectors/decisions.json`";

/// Opening rolls + middlegame + race + bear-off = 30 entries (plan, Task 11).
const EXPECTED_ENTRIES: usize = 30;

/// In the debug profile the drift guard regenerates every non-rollout entry
/// and every `DEBUG_CLUB_STRIDE`-th club-level entry (a club decision costs
/// about 1.2 s unoptimised); the full byte-for-byte comparison runs in
/// release (`cargo test --release -p bg-bot --test vectors -- --include-ignored`,
/// part of the CI perf step).
const DEBUG_CLUB_STRIDE: usize = 4;

/// Adjacent head equities that are not exact ties must differ by at least
/// this much: ten orders of magnitude above a last-ulp `libm` difference
/// (≈ 1e-16 on equities of order one), so such a difference cannot flip the
/// order. The actual minimum in the committed file is quoted in
/// `engine/vectors/README.md`.
const MIN_HEAD_GAP: f64 = 1e-5;

fn committed_text() -> String {
    std::fs::read_to_string(DECISIONS_JSON)
        .unwrap_or_else(|e| panic!("cannot read {DECISIONS_JSON}: {e}; {REGENERATE}"))
}

fn committed_vectors() -> Vec<DecisionVector> {
    serde_json::from_str(&committed_text()).expect("decisions.json parses")
}

fn position(v: &DecisionVector) -> Position {
    Position::from_board(&v.board, v.on_roll)
}

fn is_bearoff(pos: &Position) -> bool {
    pos.is_race() && pos.all_home() && pos.flip().all_home()
}

#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "full regeneration is release-only: cargo test --release -p bg-bot --test vectors -- --include-ignored"
)]
fn committed_decisions_json_equals_regenerated_output() {
    assert!(
        committed_text() == gen_decisions::render_decisions(),
        "engine/vectors/decisions.json is out of date; {REGENERATE}"
    );
}

#[test]
fn committed_decisions_match_regeneration_of_the_cheap_subset() {
    let committed = committed_vectors();
    let samples = gen_decisions::decision_samples();
    assert_eq!(samples.len(), committed.len(), "entry count; {REGENERATE}");
    let mut checked = 0;
    for (i, ((sample, ctx, level), expected)) in samples.iter().zip(&committed).enumerate() {
        let params = level.params();
        let cheap = params.rollouts == 0 && !params.two_ply;
        if !cheap && !i.is_multiple_of(DEBUG_CLUB_STRIDE) {
            continue;
        }
        let actual = gen_decisions::decide(sample, *ctx, *level);
        assert_eq!(actual, *expected, "entry {i} drifted; {REGENERATE}");
        checked += 1;
    }
    assert!(checked >= OPENING_ROLLS, "checked only {checked} entries");
}

#[test]
fn layout_is_thirty_entries_in_the_documented_order() {
    let vectors = committed_vectors();
    assert_eq!(
        OPENING_ROLLS + MIDDLEGAME_POSITIONS + RACE_POSITIONS + BEAROFF_POSITIONS,
        EXPECTED_ENTRIES
    );
    assert_eq!(vectors.len(), EXPECTED_ENTRIES);

    let opening = Board::opening();
    let non_doubles: Vec<Dice> = Dice::all().into_iter().filter(|d| !d.is_double()).collect();
    assert_eq!(non_doubles.len(), OPENING_ROLLS);
    for (i, (v, dice)) in vectors.iter().zip(&non_doubles).enumerate() {
        assert_eq!(v.board, opening, "entry {i}: opening position");
        assert_eq!(v.on_roll, Player::White, "entry {i}");
        assert_eq!(
            v.dice, *dice,
            "entry {i}: opening rolls in Dice::all() order"
        );
    }
    for level in [Level::Beginner, Level::Intermediate, Level::Club] {
        assert!(
            vectors[..OPENING_ROLLS].iter().any(|v| v.level == level),
            "opening entries cover {level:?}"
        );
    }

    let mut rest = vectors[OPENING_ROLLS..].iter().enumerate();
    for (i, v) in rest.by_ref().take(MIDDLEGAME_POSITIONS) {
        let pos = position(v);
        assert!(
            !pos.is_race(),
            "entry {}: middlegame is contact",
            i + OPENING_ROLLS
        );
        assert_eq!(v.level, Level::Club);
    }
    for (i, v) in rest.by_ref().take(RACE_POSITIONS) {
        let pos = position(v);
        assert!(
            pos.is_race() && !is_bearoff(&pos),
            "entry {}: race",
            i + OPENING_ROLLS
        );
        assert_eq!(v.level, Level::Club);
    }
    for (i, v) in rest {
        let pos = position(v);
        assert!(is_bearoff(&pos), "entry {}: bear-off", i + OPENING_ROLLS);
        assert_eq!(v.level, Level::Club);
    }
}

#[test]
fn committed_decisions_are_consistent_with_the_rules() {
    let vectors = committed_vectors();
    for (i, v) in vectors.iter().enumerate() {
        v.board
            .validate()
            .unwrap_or_else(|e| panic!("entry {i}: invalid board: {e}"));
        let pos = position(v);
        let legal: BTreeSet<String> = legal_plays(&pos, v.dice)
            .iter()
            .map(ToString::to_string)
            .collect();
        let listed: BTreeSet<String> = v.candidates.iter().map(|c| c.notation.clone()).collect();
        assert_eq!(
            listed, legal,
            "entry {i}: every legal play is a candidate exactly once"
        );
        assert_eq!(
            listed.len(),
            v.candidates.len(),
            "entry {i}: no duplicate candidates"
        );
        assert_eq!(
            v.chosen, v.candidates[0].notation,
            "entry {i}: the chosen play is the top candidate"
        );
        // `rank_plays` re-scores and re-sorts only the top `keep_top`
        // candidates at 2-ply; the tail keeps 1-ply equities in 1-ply
        // order, so only the head is comparable. A rolled-out head keeps
        // its 2-ply order unless a rollout gap is decisive (search.rs), and
        // the file carries no rollout statistics, so for those levels the
        // order is guarded by the drift tests alone and only the gaps of
        // in-order pairs are checked here.
        let params = v.level.params();
        let ranked = if params.two_ply || params.rollouts > 0 {
            params.keep_top.min(v.candidates.len())
        } else {
            v.candidates.len()
        };
        for w in v.candidates[..ranked].windows(2) {
            if params.rollouts == 0 {
                assert!(
                    w[0].equity >= w[1].equity,
                    "entry {i}: ranked candidates are sorted by equity, best first ({} < {})",
                    w[0].equity,
                    w[1].equity
                );
            }
            let gap = (w[0].equity - w[1].equity).abs();
            assert!(
                gap == 0.0 || gap >= MIN_HEAD_GAP,
                "entry {i}: near-tie {} vs {} (gap {gap:e} < {MIN_HEAD_GAP:e}) would make the order fragile",
                w[0].equity,
                w[1].equity
            );
        }
        for c in &v.candidates {
            assert!(c.equity.is_finite(), "entry {i}: finite equity");
            assert!(
                (c.equity * 1e6 - (c.equity * 1e6).round()).abs() < 1e-6,
                "entry {i}: equity {} is rounded to six decimals",
                c.equity
            );
        }
    }
}

#[test]
fn match_contexts_cover_money_and_match_play() {
    let vectors = committed_vectors();
    assert!(vectors.iter().any(|v| v.match_ctx.is_money()));
    assert!(vectors.iter().any(|v| !v.match_ctx.is_money()));
    assert!(vectors.iter().any(|v| v.match_ctx.crawford));
    assert!(vectors.iter().any(|v| v.match_ctx.post_crawford));
    assert!(vectors.iter().any(|v| v.match_ctx.cube > 1));
    assert!(vectors.iter().any(|v| v.on_roll == Player::Black));
}
