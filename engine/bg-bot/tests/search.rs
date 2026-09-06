//! Search: levels, 1-ply ranking, noise, 2-ply refinement, rollouts on the
//! top candidates, match-normalised equities and determinism.
//!
//! The evaluator used here is a small deterministic stand-in (pip-count
//! logistic with a blot term), so these tests do not depend on the club
//! evaluator.

use bg_bot::search::{Candidate, DECISIVE_SIGMAS, Level, SearchParams, rank_plays, ranking_gap};
use bg_bot::{Evaluator, MatchContext, Probs, equity_for};
use bg_core::moves::{apply, legal_plays};
use bg_core::position::{BAR, OFF};
use bg_core::{Board, Dice, Play, Player, Position};

/// Pip-count logistic with a blot term; gammons only while the loser has
/// nothing off. Cheap and fully deterministic.
struct PipEval;

impl Evaluator for PipEval {
    fn evaluate(&self, pos: &Position) -> Probs {
        let (mine, theirs) = pos.pips();
        let blots = |side: &[u8; 26]| side[1..=24].iter().map(|&n| f64::from(n == 1)).sum::<f64>();
        let blot_term = 0.2 * (blots(&pos.theirs) - blots(&pos.mine));
        let s = (f64::from(theirs) - f64::from(mine)) / 12.0 + 0.3 + blot_term;
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

/// Always 50 %: proves terminal positions are scored by the rules, not the
/// evaluator.
struct Coin;

impl Evaluator for Coin {
    fn evaluate(&self, _pos: &Position) -> Probs {
        Probs {
            win: 0.5,
            ..Probs::default()
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

fn match_3_5() -> MatchContext {
    MatchContext {
        length: 7,
        my_away: 3,
        their_away: 5,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn opening() -> Position {
    Position::from_board(&Board::opening(), Player::White)
}

/// Opening position with one of their 8-point (my 17) checkers slotted on
/// my 18-point, where a 6 from my 24-point hits it.
fn opening_with_their_blot_on_18() -> Position {
    let mut p = opening();
    p.theirs[17] = 2;
    p.theirs[18] = 1;
    p
}

fn dice(hi: u8, lo: u8) -> Dice {
    Dice::new(hi, lo).expect("valid dice")
}

fn one_ply_params() -> SearchParams {
    SearchParams {
        keep_top: 5,
        two_ply: false,
        noise_sigma: 0.0,
        rollouts: 0,
        rollout_depth: 8,
    }
}

fn plays_of(cands: &[Candidate]) -> Vec<Play> {
    cands.iter().map(|c| c.play.clone()).collect()
}

fn sorted_plays(cands: &[Candidate]) -> Vec<String> {
    let mut v: Vec<String> = cands.iter().map(|c| c.play.to_string()).collect();
    v.sort();
    v
}

fn is_sorted_desc(values: &[f64]) -> bool {
    values.windows(2).all(|w| w[0] >= w[1])
}

fn approx(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() < tol
}

/// Reference 1-ply probs for me after `play` from `pos`.
fn reference_1ply(ev: &dyn Evaluator, pos: &Position, play: &Play) -> Probs {
    let next = apply(pos, play).expect("legal play applies");
    ev.evaluate(&next.flip()).flipped().clamp()
}

/// Reference 2-ply probs: expectation over the 21 rolls of the opponent's
/// best 1-ply reply, where "best" minimises my equity.
fn reference_2ply(ev: &dyn Evaluator, ctx: MatchContext, pos: &Position, play: &Play) -> Probs {
    let next = apply(pos, play).expect("legal play applies");
    let opp = next.flip();
    let mut acc = Probs::default();
    for roll in Dice::all() {
        let w = f64::from(roll.weight()) / 36.0;
        let mut best: Option<(f64, Probs)> = None;
        for reply in legal_plays(&opp, roll) {
            let after = apply(&opp, &reply).expect("legal reply applies");
            // `after` is on the opponent's axis with me to roll.
            let mine = ev.evaluate(&after.flip()).clamp();
            let e = equity_for(&ctx, &mine);
            if best.is_none_or(|(be, _)| e < be) {
                best = Some((e, mine));
            }
        }
        let (_, p) = best.expect("at least the empty reply");
        acc.win += w * p.win;
        acc.win_g += w * p.win_g;
        acc.win_bg += w * p.win_bg;
        acc.lose_g += w * p.lose_g;
        acc.lose_bg += w * p.lose_bg;
    }
    acc
}

#[test]
fn level_params_follow_the_plan() {
    let b = Level::Beginner.params();
    assert_eq!(b.keep_top, 5);
    assert!(!b.two_ply);
    assert!(approx(b.noise_sigma, 0.05, 1e-12));
    assert_eq!(b.rollouts, 0);

    let i = Level::Intermediate.params();
    assert_eq!(i.keep_top, 5);
    assert!(!i.two_ply);
    assert!(approx(i.noise_sigma, 0.0, 1e-12));
    assert_eq!(i.rollouts, 0);

    let c = Level::Club.params();
    assert_eq!(c.keep_top, 5);
    assert!(c.two_ply);
    assert!(approx(c.noise_sigma, 0.0, 1e-12));
    assert_eq!(c.rollouts, 100);
    assert_eq!(c.rollout_depth, 8);
}

#[test]
fn level_serialises_camel_case() {
    assert_eq!(
        serde_json::to_string(&Level::Club).expect("json"),
        r#""club""#
    );
    assert_eq!(
        serde_json::from_str::<Level>(r#""beginner""#).expect("json"),
        Level::Beginner
    );
    assert_eq!(
        serde_json::from_str::<Level>(r#""intermediate""#).expect("json"),
        Level::Intermediate
    );
}

#[test]
fn one_ply_ranks_every_legal_play_by_equity_descending() {
    let pos = opening();
    let d = dice(3, 1);
    let cands = rank_plays(&PipEval, &money(), &pos, d, &one_ply_params(), 1);
    let legal = legal_plays(&pos, d);
    assert_eq!(cands.len(), legal.len());
    let mut expected: Vec<String> = legal.iter().map(ToString::to_string).collect();
    expected.sort();
    assert_eq!(sorted_plays(&cands), expected);
    let eq: Vec<f64> = cands.iter().map(|c| c.equity).collect();
    assert!(is_sorted_desc(&eq), "{eq:?}");
    assert!(cands.iter().all(|c| c.rollout.is_none()));
}

#[test]
fn one_ply_equity_and_probs_match_the_flipped_evaluation() {
    let pos = opening_with_their_blot_on_18();
    let ctx = money();
    for d in [dice(6, 1), dice(4, 4), dice(2, 1)] {
        let cands = rank_plays(&PipEval, &ctx, &pos, d, &one_ply_params(), 9);
        for c in &cands {
            let p = reference_1ply(&PipEval, &pos, &c.play);
            assert!(approx(c.probs.win, p.win, 1e-12), "{}", c.play);
            assert!(approx(c.probs.win_g, p.win_g, 1e-12));
            assert!(approx(c.probs.lose_g, p.lose_g, 1e-12));
            assert!(approx(c.equity, equity_for(&ctx, &p), 1e-12), "{}", c.play);
        }
    }
}

#[test]
fn one_ply_top_candidate_is_the_hit_the_evaluator_prefers() {
    let pos = opening_with_their_blot_on_18();
    let cands = rank_plays(&PipEval, &money(), &pos, dice(6, 1), &one_ply_params(), 3);
    let top = &cands[0];
    assert!(
        top.play.moves.iter().any(|m| m.hit),
        "top play {} should hit",
        top.play
    );
    // `18/17` after the hit is blocked (their 8-point is made), so the
    // hitting plays differ only in the spare ace: `24/23` keeps the other
    // back checker off a blot count of three, which the blot term rewards.
    assert_eq!(top.play.to_string(), "24/23 24/18*");
}

#[test]
fn ties_keep_the_canonical_play_order() {
    // Coin gives every play the same equity, so the ranking must be the
    // canonical `legal_plays` order.
    let pos = opening();
    let d = dice(5, 2);
    let cands = rank_plays(&Coin, &money(), &pos, d, &one_ply_params(), 0);
    assert_eq!(plays_of(&cands), legal_plays(&pos, d));
}

#[test]
fn match_context_equities_are_normalised_with_equity_for() {
    let pos = opening_with_their_blot_on_18();
    let ctx = match_3_5();
    let cands = rank_plays(&PipEval, &ctx, &pos, dice(6, 1), &one_ply_params(), 5);
    for c in &cands {
        let p = reference_1ply(&PipEval, &pos, &c.play);
        assert!(approx(c.equity, equity_for(&ctx, &p), 1e-12), "{}", c.play);
        assert!(!approx(c.equity, p.cubeless_equity(), 1e-6) || approx(p.win, 0.5, 1e-9));
    }
    let eq: Vec<f64> = cands.iter().map(|c| c.equity).collect();
    assert!(is_sorted_desc(&eq));
}

#[test]
fn a_play_that_ends_the_game_scores_the_actual_result() {
    // Two checkers on my ace point, 13 off; 6-5 bears both off.
    let mut mine = [0u8; 26];
    mine[1] = 2;
    mine[OFF] = 13;
    let mut theirs = [0u8; 26];
    theirs[19] = 15; // their 6-point: nothing off, nothing in my home → gammon
    let pos = Position { mine, theirs };
    let ctx = money();
    let cands = rank_plays(&Coin, &ctx, &pos, dice(6, 5), &one_ply_params(), 0);
    assert_eq!(cands.len(), 1);
    let c = &cands[0];
    assert_eq!(c.play.to_string(), "1/off(2)");
    assert!(approx(c.probs.win, 1.0, 1e-12));
    assert!(approx(c.probs.win_g, 1.0, 1e-12));
    assert!(approx(c.probs.win_bg, 0.0, 1e-12));
    assert!(approx(c.equity, 2.0, 1e-12));

    // A checker on their bar makes it a backgammon.
    let mut bg = pos;
    bg.theirs[19] = 14;
    bg.theirs[BAR] = 1;
    let c = &rank_plays(&Coin, &ctx, &bg, dice(6, 5), &one_ply_params(), 0)[0];
    assert!(approx(c.probs.win_bg, 1.0, 1e-12));
    assert!(approx(c.equity, 3.0, 1e-12));

    // One of theirs off: single.
    let mut single = pos;
    single.theirs[19] = 14;
    single.theirs[OFF] = 1;
    let c = &rank_plays(&Coin, &ctx, &single, dice(6, 5), &one_ply_params(), 0)[0];
    assert!(approx(c.probs.win, 1.0, 1e-12));
    assert!(approx(c.probs.win_g, 0.0, 1e-12));
    assert!(approx(c.equity, 1.0, 1e-12));
}

#[test]
fn a_roll_that_cannot_be_played_yields_the_empty_play() {
    // I am on the bar against a closed board: my bar checker enters on my
    // points 19..=24 (their home board), so those are the points they hold.
    let mut mine = [0u8; 26];
    mine[BAR] = 1;
    mine[OFF] = 14;
    let mut theirs = [0u8; 26];
    for point in &mut theirs[19..=24] {
        *point = 2;
    }
    theirs[OFF] = 3;
    let pos = Position { mine, theirs };
    let cands = rank_plays(&PipEval, &money(), &pos, dice(4, 3), &one_ply_params(), 0);
    assert_eq!(cands.len(), 1);
    assert!(cands[0].play.is_empty());
    let p = reference_1ply(&PipEval, &pos, &Play::empty());
    assert!(approx(cands[0].probs.win, p.win, 1e-12));
}

#[test]
fn beginner_noise_changes_equities_but_not_plays_or_probs() {
    let pos = opening();
    let d = dice(6, 4);
    let ctx = money();
    let quiet = rank_plays(&PipEval, &ctx, &pos, d, &Level::Intermediate.params(), 1);
    let noisy = rank_plays(&PipEval, &ctx, &pos, d, &Level::Beginner.params(), 1);
    assert_eq!(sorted_plays(&quiet), sorted_plays(&noisy));
    // Probs are un-noised: identical per play.
    for c in &noisy {
        let q = quiet
            .iter()
            .find(|q| q.play == c.play)
            .expect("same play set");
        assert!(approx(c.probs.win, q.probs.win, 1e-12));
    }
    // Equities are noised: at least one differs.
    let differs = noisy.iter().any(|c| {
        let q = quiet
            .iter()
            .find(|q| q.play == c.play)
            .expect("same play set");
        !approx(c.equity, q.equity, 1e-9)
    });
    assert!(differs);
    let eq: Vec<f64> = noisy.iter().map(|c| c.equity).collect();
    assert!(is_sorted_desc(&eq));
    // Noise magnitude is plausible for σ = 0.05: no single deviation > 0.5.
    for c in &noisy {
        let q = quiet
            .iter()
            .find(|q| q.play == c.play)
            .expect("same play set");
        assert!((c.equity - q.equity).abs() < 0.5);
    }
}

#[test]
fn noise_is_deterministic_per_seed_and_differs_across_seeds() {
    let pos = opening();
    let d = dice(6, 4);
    let ctx = money();
    let params = Level::Beginner.params();
    let a = rank_plays(&PipEval, &ctx, &pos, d, &params, 42);
    let b = rank_plays(&PipEval, &ctx, &pos, d, &params, 42);
    assert_eq!(
        serde_json::to_string(&a).expect("json"),
        serde_json::to_string(&b).expect("json")
    );
    let c = rank_plays(&PipEval, &ctx, &pos, d, &params, 43);
    assert_eq!(sorted_plays(&a), sorted_plays(&c));
    assert_ne!(
        serde_json::to_string(&a).expect("json"),
        serde_json::to_string(&c).expect("json")
    );
}

#[test]
fn two_ply_refines_only_the_top_keep_top() {
    let pos = opening_with_their_blot_on_18();
    let d = dice(6, 1);
    let ctx = money();
    let params = SearchParams {
        keep_top: 2,
        two_ply: true,
        ..one_ply_params()
    };
    let cands = rank_plays(&PipEval, &ctx, &pos, d, &params, 0);
    let one_ply = rank_plays(&PipEval, &ctx, &pos, d, &one_ply_params(), 0);
    assert!(cands.len() > 3);
    // The same two plays are refined (the 1-ply top two), then re-sorted.
    let mut refined = sorted_plays(&cands[..2]);
    refined.sort();
    let mut top1 = sorted_plays(&one_ply[..2]);
    top1.sort();
    assert_eq!(refined, top1);
    for c in &cands[..2] {
        let p = reference_2ply(&PipEval, ctx, &pos, &c.play);
        assert!(approx(c.probs.win, p.win, 1e-9), "{}", c.play);
        assert!(approx(c.probs.win_g, p.win_g, 1e-9));
        assert!(approx(c.probs.lose_g, p.lose_g, 1e-9));
        assert!(approx(c.equity, equity_for(&ctx, &p), 1e-9), "{}", c.play);
        let stat = reference_1ply(&PipEval, &pos, &c.play);
        assert!(!approx(c.equity, equity_for(&ctx, &stat), 1e-6));
    }
    // The rest keep their 1-ply values and order.
    assert_eq!(plays_of(&cands[2..]), plays_of(&one_ply[2..]));
    for (c, o) in cands[2..].iter().zip(&one_ply[2..]) {
        assert!(approx(c.equity, o.equity, 1e-12));
    }
    let eq: Vec<f64> = cands[..2].iter().map(|c| c.equity).collect();
    assert!(is_sorted_desc(&eq));
}

#[test]
fn two_ply_against_a_dancing_opponent_is_the_static_value_of_my_position() {
    // My board is closed; the opponent has a checker on the bar and cannot
    // enter as long as it stays closed. Some plays of 1-1 (e.g. `6/5(2)`)
    // open a point, so the check is restricted to the plays that keep every
    // home point made: after them the opponent dances with every roll and
    // the 2-ply value is the static value of the position I left.
    let mut mine = [0u8; 26];
    for point in &mut mine[1..=6] {
        *point = 2;
    }
    mine[8] = 3;
    let mut theirs = [0u8; 26];
    theirs[BAR] = 1;
    theirs[19] = 14;
    let pos = Position { mine, theirs };
    let ctx = match_3_5();
    // 1-1 has well over a hundred legal plays here; refine all of them.
    let params = SearchParams {
        keep_top: usize::MAX,
        two_ply: true,
        ..one_ply_params()
    };
    let cands = rank_plays(&PipEval, &ctx, &pos, dice(1, 1), &params, 0);
    assert!(cands.len() > 1);
    let mut still_closed = 0;
    for c in &cands {
        let next = apply(&pos, &c.play).expect("legal");
        if next.mine[1..=6].iter().any(|&n| n < 2) {
            continue;
        }
        still_closed += 1;
        let p = PipEval.evaluate(&next).clamp();
        assert!(
            approx(c.probs.win, p.win, 1e-12),
            "{}: 2-ply win {} vs static {}",
            c.play,
            c.probs.win,
            p.win
        );
        assert!(
            approx(c.equity, equity_for(&ctx, &p), 1e-12),
            "{}: 2-ply equity {} vs static {}",
            c.play,
            c.equity,
            equity_for(&ctx, &p)
        );
    }
    assert!(
        still_closed >= 2,
        "only {still_closed} plays keep the board closed"
    );
}

#[test]
fn rollouts_cover_the_top_keep_top_and_re_order_only_when_decisive() {
    let pos = opening_with_their_blot_on_18();
    let d = dice(6, 1);
    let ctx = money();
    let params = SearchParams {
        keep_top: 3,
        two_ply: true,
        noise_sigma: 0.0,
        rollouts: 20,
        rollout_depth: 4,
    };
    let cands = rank_plays(&PipEval, &ctx, &pos, d, &params, 7);
    assert!(cands.len() > 3);
    for c in &cands[..3] {
        let r = c.rollout.as_ref().expect("rolled out");
        assert_eq!(r.trials, 20);
        assert!(r.std_err >= 0.0 && r.std_err.is_finite());
        assert!(approx(r.equity, equity_for(&ctx, &r.probs), 1e-9));
        let p = r.probs.clamp();
        assert!(approx(p.win, r.probs.win, 1e-12) && approx(p.win_g, r.probs.win_g, 1e-12));
    }
    assert!(cands[3..].iter().all(|c| c.rollout.is_none()));
    let rest: Vec<f64> = cands[3..].iter().map(|c| c.equity).collect();
    assert!(is_sorted_desc(&rest));
    // The rolled-out set is the 2-ply top three.
    let two_ply = rank_plays(
        &PipEval,
        &ctx,
        &pos,
        d,
        &SearchParams {
            rollouts: 0,
            ..params
        },
        7,
    );
    assert_eq!(sorted_plays(&cands[..3]), sorted_plays(&two_ply[..3]));
    // Search equities are kept alongside the rollout estimate.
    for c in &cands[..3] {
        let t = two_ply.iter().find(|t| t.play == c.play).expect("same set");
        assert!(approx(c.equity, t.equity, 1e-12));
    }
    // Ranking rule: the head keeps the 2-ply order unless a rollout gap is
    // decisive, so every adjacent pair satisfies the ranking comparator,
    // and a pair that is *not* decisive is in 2-ply order.
    for w in cands[..3].windows(2) {
        assert!(
            ranking_gap(&w[0], &w[1]) >= 0.0,
            "{} above {}",
            w[0].play,
            w[1].play
        );
        let (ra, rb) = (w[0].rollout.expect("rolled"), w[1].rollout.expect("rolled"));
        let decisive =
            (ra.equity - rb.equity).abs() > DECISIVE_SIGMAS * ra.std_err.hypot(rb.std_err);
        if !decisive {
            assert!(
                w[0].equity >= w[1].equity,
                "non-decisive pair must keep 2-ply order"
            );
        }
    }
    // With one trial the standard error is zero, so any rollout difference
    // is decisive and the head is then sorted by rollout equity.
    let one_trial = rank_plays(
        &PipEval,
        &ctx,
        &pos,
        d,
        &SearchParams {
            rollouts: 1,
            ..params
        },
        7,
    );
    let ro: Vec<f64> = one_trial[..3]
        .iter()
        .map(|c| c.rollout.as_ref().map_or(f64::NAN, |r| r.equity))
        .collect();
    assert!(is_sorted_desc(&ro), "{ro:?}");
}

#[test]
fn two_ply_does_not_let_the_opponent_move_in_a_finished_game() {
    // 6-5 bears off my last two checkers: a certain gammon (they have
    // nothing off, nothing in my home board). Before the terminal check the
    // opponent "bore off" in 17/36 of the replies and winG came out 19/36.
    let mut mine = [0u8; 26];
    mine[6] = 1;
    mine[5] = 1;
    mine[OFF] = 13;
    let mut theirs = [0u8; 26];
    theirs[19] = 15;
    let pos = Position { mine, theirs };
    let params = SearchParams {
        two_ply: true,
        ..one_ply_params()
    };
    let cands = rank_plays(&Coin, &money(), &pos, dice(6, 5), &params, 0);
    let c = &cands[0];
    assert_eq!(c.play.to_string(), "6/off 5/off");
    assert!(approx(c.probs.win, 1.0, 1e-12));
    assert!(
        approx(c.probs.win_g, 1.0, 1e-12),
        "winG = {}",
        c.probs.win_g
    );
    assert!(approx(c.equity, 2.0, 1e-12), "equity = {}", c.equity);
    // Club parameters: the wire values agree with the rollout.
    let club = rank_plays(&Coin, &money(), &pos, dice(6, 5), &Level::Club.params(), 0);
    let c = &club[0];
    assert!(approx(c.equity, 2.0, 1e-12));
    let r = c.rollout.expect("rolled out");
    assert!(approx(r.equity, 2.0, 1e-12));
}

#[test]
fn rollout_seeds_are_per_candidate_and_deterministic() {
    let pos = opening();
    let d = dice(3, 1);
    let ctx = money();
    let params = SearchParams {
        keep_top: 2,
        two_ply: false,
        noise_sigma: 0.0,
        rollouts: 10,
        rollout_depth: 3,
    };
    let a = rank_plays(&PipEval, &ctx, &pos, d, &params, 100);
    let b = rank_plays(&PipEval, &ctx, &pos, d, &params, 100);
    assert_eq!(
        serde_json::to_string(&a).expect("json"),
        serde_json::to_string(&b).expect("json")
    );
    let c = rank_plays(&PipEval, &ctx, &pos, d, &params, 101);
    assert_eq!(sorted_plays(&a), sorted_plays(&c));
    assert_ne!(
        serde_json::to_string(&a).expect("json"),
        serde_json::to_string(&c).expect("json")
    );
}

#[test]
fn club_level_is_deterministic_json() {
    let pos = opening_with_their_blot_on_18();
    let d = dice(6, 1);
    let ctx = match_3_5();
    let params = Level::Club.params();
    let a = rank_plays(&PipEval, &ctx, &pos, d, &params, 2026);
    let b = rank_plays(&PipEval, &ctx, &pos, d, &params, 2026);
    let ja = serde_json::to_string(&a).expect("json");
    assert_eq!(ja, serde_json::to_string(&b).expect("json"));
    assert!(
        a.iter()
            .take(5)
            .all(|c| c.rollout.as_ref().is_some_and(|r| r.trials == 100))
    );
    assert!(a.iter().skip(5).all(|c| c.rollout.is_none()));
}

#[test]
fn candidate_json_shape() {
    let pos = opening();
    let cands = rank_plays(&PipEval, &money(), &pos, dice(3, 1), &one_ply_params(), 0);
    let v = serde_json::to_value(&cands[0]).expect("json");
    let obj = v.as_object().expect("object");
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    assert_eq!(keys, ["equity", "play", "probs", "rollout"]);
    assert!(obj["rollout"].is_null());
    assert!(obj["play"]["notation"].is_string());
    assert!(obj["probs"]["winG"].is_number());
    let back: Candidate = serde_json::from_value(v).expect("round trip");
    assert_eq!(back.play, cands[0].play);
}
