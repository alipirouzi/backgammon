//! Truncated rollouts: determinism per seed, terminal handling, statistics.

use bg_bot::rollout::{RolloutStats, rollout};
use bg_bot::{Evaluator, MatchContext, Probs, equity_for};
use bg_core::position::{BAR, OFF};
use bg_core::{Board, Player, Position};

/// Pip-count logistic; gammons only while the loser has nothing off.
struct PipEval;

impl Evaluator for PipEval {
    fn evaluate(&self, pos: &Position) -> Probs {
        let (mine, theirs) = pos.pips();
        let s = (f64::from(theirs) - f64::from(mine)) / 12.0 + 0.3;
        let win = 1.0 / (1.0 + (-s).exp());
        Probs {
            win,
            win_g: if pos.theirs[OFF] == 0 {
                0.15 * win
            } else {
                0.0
            },
            win_bg: 0.0,
            lose_g: if pos.mine[OFF] == 0 {
                0.15 * (1.0 - win)
            } else {
                0.0
            },
            lose_bg: 0.0,
        }
    }
}

fn money() -> MatchContext {
    MatchContext {
        length: 0,
        my_away: 0,
        their_away: 0,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn match_2_4() -> MatchContext {
    MatchContext {
        length: 5,
        my_away: 2,
        their_away: 4,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn opening() -> Position {
    Position::from_board(&Board::opening(), Player::White)
}

fn approx(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

fn json(s: &RolloutStats) -> String {
    serde_json::to_string(s).expect("json")
}

fn assert_valid(p: &Probs) {
    let c = p.clamp();
    for (a, b) in [
        (c.win, p.win),
        (c.win_g, p.win_g),
        (c.win_bg, p.win_bg),
        (c.lose_g, p.lose_g),
        (c.lose_bg, p.lose_bg),
    ] {
        assert!(approx(a, b, 1e-12), "probs violate ordering: {p:?}");
    }
}

#[test]
fn same_seed_gives_identical_stats_and_other_seeds_differ() {
    let pos = opening();
    let ctx = money();
    let a = rollout(&PipEval, &ctx, &pos, 30, 6, 11);
    let b = rollout(&PipEval, &ctx, &pos, 30, 6, 11);
    assert_eq!(json(&a), json(&b));
    let c = rollout(&PipEval, &ctx, &pos, 30, 6, 12);
    assert_ne!(json(&a), json(&c));
    assert_eq!(a.trials, 30);
}

#[test]
fn equity_is_equity_for_of_the_mean_probs_and_std_err_is_finite() {
    let pos = opening();
    for ctx in [money(), match_2_4()] {
        let s = rollout(&PipEval, &ctx, &pos, 40, 6, 3);
        assert_eq!(s.trials, 40);
        assert_valid(&s.probs);
        assert!(approx(s.equity, equity_for(&ctx, &s.probs), 1e-9));
        assert!(s.std_err.is_finite() && s.std_err > 0.0);
        // 40 trials of a depth-6 opening rollout scatter well below 1 point.
        assert!(s.std_err < 0.5, "{}", s.std_err);
    }
}

#[test]
fn depth_zero_is_the_static_evaluation() {
    let pos = opening();
    let ctx = money();
    let s = rollout(&PipEval, &ctx, &pos, 5, 0, 1);
    let p = PipEval.evaluate(&pos).clamp();
    assert!(approx(s.probs.win, p.win, 1e-12));
    assert!(approx(s.probs.win_g, p.win_g, 1e-12));
    assert!(approx(s.probs.lose_g, p.lose_g, 1e-12));
    assert!(approx(s.equity, equity_for(&ctx, &p), 1e-12));
    assert!(approx(s.std_err, 0.0, 1e-12));
}

#[test]
fn a_finished_position_is_scored_by_the_rules_without_rolling() {
    let mut mine = [0u8; 26];
    mine[OFF] = 15;
    let mut theirs = [0u8; 26];
    theirs[19] = 15;
    let won = Position { mine, theirs };
    let s = rollout(&PipEval, &money(), &won, 7, 8, 5);
    assert_eq!(s.trials, 7);
    assert!(approx(s.probs.win, 1.0, 1e-12));
    assert!(approx(s.probs.win_g, 1.0, 1e-12));
    assert!(approx(s.probs.win_bg, 0.0, 1e-12));
    assert!(approx(s.equity, 2.0, 1e-12));
    assert!(approx(s.std_err, 0.0, 1e-12));

    // Lost: they have everything off, I have borne off nothing and still
    // have a checker in their home board (my point 24) → backgammon loss.
    let mut mine = [0u8; 26];
    mine[24] = 1;
    mine[6] = 14;
    let mut theirs = [0u8; 26];
    theirs[OFF] = 15;
    let lost = Position { mine, theirs };
    let s = rollout(&PipEval, &money(), &lost, 3, 8, 5);
    assert!(approx(s.probs.win, 0.0, 1e-12));
    assert!(approx(s.probs.lose_g, 1.0, 1e-12));
    assert!(approx(s.probs.lose_bg, 1.0, 1e-12));
    assert!(approx(s.equity, -3.0, 1e-12));
}

#[test]
fn a_game_that_ends_inside_the_horizon_uses_the_actual_result() {
    // My last checker on the ace point: any roll bears it off. They have
    // nothing off, so every trial is a gammon win.
    let mut mine = [0u8; 26];
    mine[1] = 1;
    mine[OFF] = 14;
    let mut theirs = [0u8; 26];
    theirs[19] = 15;
    let pos = Position { mine, theirs };
    let s = rollout(&PipEval, &money(), &pos, 12, 8, 9);
    assert!(approx(s.probs.win, 1.0, 1e-12));
    assert!(approx(s.probs.win_g, 1.0, 1e-12));
    assert!(approx(s.equity, 2.0, 1e-12));
    assert!(approx(s.std_err, 0.0, 1e-12));

    // Their last checker on their ace point (my 24); I cannot finish this
    // roll (5 checkers on my 6-point), so after my play they bear off: every
    // trial is a single loss (I have checkers off).
    let mut mine = [0u8; 26];
    mine[6] = 5;
    mine[OFF] = 10;
    let mut theirs = [0u8; 26];
    theirs[24] = 1;
    theirs[OFF] = 14;
    let pos = Position { mine, theirs };
    let s = rollout(&PipEval, &money(), &pos, 12, 8, 9);
    assert!(approx(s.probs.win, 0.0, 1e-12));
    assert!(approx(s.probs.lose_g, 0.0, 1e-12));
    assert!(approx(s.equity, -1.0, 1e-12));
    assert!(approx(s.std_err, 0.0, 1e-12));
}

#[test]
fn a_backgammon_inside_the_horizon_is_recognised() {
    // I bear off my last checker while they still have one on the bar.
    let mut mine = [0u8; 26];
    mine[1] = 1;
    mine[OFF] = 14;
    let mut theirs = [0u8; 26];
    theirs[BAR] = 1;
    theirs[19] = 14;
    let pos = Position { mine, theirs };
    let s = rollout(&PipEval, &money(), &pos, 4, 2, 1);
    assert!(approx(s.probs.win_bg, 1.0, 1e-12));
    assert!(approx(s.equity, 3.0, 1e-12));
}

#[test]
fn single_trial_has_zero_std_err() {
    let s = rollout(&PipEval, &money(), &opening(), 1, 4, 2);
    assert_eq!(s.trials, 1);
    assert!(approx(s.std_err, 0.0, 1e-12));
    assert_valid(&s.probs);
}

#[test]
fn zero_trials_yields_the_static_evaluation_and_no_spread() {
    let pos = opening();
    let s = rollout(&PipEval, &money(), &pos, 0, 8, 2);
    assert_eq!(s.trials, 0);
    let p = PipEval.evaluate(&pos).clamp();
    assert!(approx(s.probs.win, p.win, 1e-12));
    assert!(approx(s.std_err, 0.0, 1e-12));
    assert!(s.equity.is_finite());
}

#[test]
fn flipped_negates_equity_and_flips_probs() {
    let s = RolloutStats {
        trials: 10,
        equity: 0.25,
        std_err: 0.05,
        probs: Probs {
            win: 0.6,
            win_g: 0.2,
            win_bg: 0.05,
            lose_g: 0.1,
            lose_bg: 0.01,
        },
    };
    let f = s.flipped();
    assert_eq!(f.trials, 10);
    assert!(approx(f.equity, -0.25, 1e-12));
    assert!(approx(f.std_err, 0.05, 1e-12));
    assert!(approx(f.probs.win, 0.4, 1e-12));
    assert!(approx(f.probs.win_g, 0.1, 1e-12));
    assert!(approx(f.probs.lose_bg, 0.05, 1e-12));
}

#[test]
fn stats_json_is_camel_case() {
    let s = rollout(&PipEval, &money(), &opening(), 2, 2, 1);
    let v = serde_json::to_value(s).expect("json");
    let mut keys: Vec<&String> = v.as_object().expect("object").keys().collect();
    keys.sort();
    assert_eq!(keys, ["equity", "probs", "stdErr", "trials"]);
    let back: RolloutStats = serde_json::from_value(v).expect("round trip");
    assert_eq!(back.trials, 2);
}
