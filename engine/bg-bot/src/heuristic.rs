//! The club-strength static evaluator: [`ClubEvaluator`].
//!
//! # Classification
//!
//! [`classify`] sorts a position into one of three classes and each class
//! has its own model and weight set:
//!
//! * [`PositionClass::Bearoff`] — no contact and both sides have every
//!   checker home or off. A logistic on the difference in expected rolls to
//!   finish, `max(keith / 8.17, checkers / 2)` per side.
//! * [`PositionClass::Race`] — no contact otherwise. The Task 7 curve
//!   [`race::race_win_probability`] and [`race::race_gammon_probabilities`],
//!   symmetrised as described below.
//! * [`PositionClass::Contact`] — everything else, holding games included.
//!   A linear score over the hand-crafted [`features::Features`] with the
//!   [`CONTACT`] weight table; holding games (mutual anchors) deliberately
//!   use the same weights in this piece.
//!
//! # Symmetry
//!
//! `evaluate(pos).flipped()` must agree with `evaluate(&pos.flip())` to
//! within the small on-roll term ([`ON_ROLL_LOGIT`]). Every model here is
//! therefore built from *one* side-scoring function applied to both `pos`
//! and `pos.flip()` and combined antisymmetrically, so the only asymmetry
//! is the explicit on-roll constant.
//!
//! The Task 7 race curve credits the roller half a roll, so
//! `race_win_probability(pos)` and `1 − race_win_probability(&pos.flip())`
//! differ by that edge (≈ 0.07 at 100 pips). The evaluator averages the
//! two viewpoints in logit space, which cancels the credit and leaves only
//! [`ON_ROLL_LOGIT`] as the asymmetry; the evaluator's race scale is
//! therefore the curve's slope on the plain lead with no on-roll edge, and
//! Keith's 70%/75% cube anchors are *not* read off it — the money-game race
//! cube decision uses Keith's counts directly (see [`crate::cube`]). Gammon
//! estimates are averaged in probability space because one viewpoint can be
//! exactly zero.
//!
//! # Pricing exposure
//!
//! A blot costs its owner the *expected* damage of being hit, not just the
//! number of shots: each shot is weighted by the pips the hit checker would
//! lose (`25 − point`, see [`features::Features::direct_shot_pips_on_me`])
//! and by the strength of the opposing home board it would have to re-enter
//! against. A split back checker (hit costs 1–4 pips) is therefore cheap to
//! expose and a deep slot (≈ 20 pips) expensive, which is what lets the
//! standard opening splits and running plays compete with safe plays.
//!
//! # Gammons in contact positions
//!
//! `P(gammon | win)` is a logistic on the winner's containment (opposing
//! checkers back or on the bar, home-board points, checkers off) plus a
//! race term: the loser's rolls to get every checker home and one off minus
//! the winner's rolls to finish, the latter capped at
//! [`GAMMON_WINNER_HORIZON_ROLLS`] because a contact game is rarely decided
//! by a straight race from far away, and the margin clamped to
//! ±[`GAMMON_MARGIN_CLAMP`] rolls. A closed-out opponent whose other
//! checkers are already home is thus graded a modest gammon risk, one whose
//! checkers are stuck in the outfield a near-certain one.

use bg_core::Position;
use bg_core::board::SLOTS;
use bg_core::position::BAR;

use crate::evaluator::{Evaluator, Probs};
use crate::features::{self, Features};
use crate::race;

/// Checkers per side.
const CHECKERS: u8 = 15;
/// Average pips moved per roll (doubles counted twice): 49/6.
const AVG_PIPS_PER_ROLL: f64 = 49.0 / 6.0;
/// Average checkers borne off per roll in a bear-off.
const AVG_CHECKERS_OFF_PER_ROLL: f64 = 2.0;
/// Probabilities are kept this far from 0 and 1 before taking a logit.
const LOGIT_EPS: f64 = 1e-9;

/// Logit credit for being on roll, added once to every win estimate.
///
/// Being on roll is worth roughly half a roll, but the symmetry invariant
/// (component-wise 0.02 under flip) caps the term: the win gap between the
/// two viewpoints is at most `σ'(0)·2c = c/2`, so `0.03` keeps it ≤ 0.015.
/// The opening position therefore evaluates to `σ(0.03) ≈ 0.5075`.
pub const ON_ROLL_LOGIT: f64 = 0.03;

/// Bear-off win slope, logit per roll of expected-rolls lead. A one-roll
/// lead with the opponent to roll is a little under 80%.
const BEAROFF_SLOPE: f64 = 1.2;

/// Cap on the winner's rolls-to-finish in the contact gammon race term.
pub const GAMMON_WINNER_HORIZON_ROLLS: f64 = 10.0;
/// The contact gammon race margin is clamped to this many rolls either way.
pub const GAMMON_MARGIN_CLAMP: f64 = 6.0;
/// Shots on a blot are priced per pip of the hit's cost; this divides the
/// weighted pips so the weight is per (roll of 36 × pip lost).
const DICE_OUTCOMES: f64 = 36.0;

/// Coarse position class used to pick the evaluation model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PositionClass {
    /// No contact, and at least one side still has checkers outside home.
    Race,
    /// No contact and both sides have every checker home or off.
    Bearoff,
    /// Contact remains (holding games included).
    Contact,
}

/// Classifies `pos`; the result is the same for `pos` and `pos.flip()`.
#[must_use]
pub fn classify(pos: &Position) -> PositionClass {
    if !pos.is_race() {
        PositionClass::Contact
    } else if pos.all_home() && pos.flip().all_home() {
        PositionClass::Bearoff
    } else {
        PositionClass::Race
    }
}

/// Weights of the contact score for **one** side, applied to that side's
/// own features (the `*_mine` fields of [`Features`] for `pos`, and again
/// for `pos.flip()` to score the opponent). The position score is
/// `side(me) − side(them) + ON_ROLL_LOGIT` and `win = σ(score)`.
///
/// Signs: positive means good for the side owning the feature.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContactWeights {
    /// Per pip of my pip count (bar checkers count 25). Negative: fewer
    /// pips to go is better; 10 pips ≈ 0.2 logit ≈ 5% in a contact game.
    pub pip: f64,
    /// Per blot of mine. Negative: exposure, independent of shot count.
    pub blot: f64,
    /// Per roll (of 36) that hits one of my blots from 1–6 pips, regardless
    /// of where the blot is. Negative: the tempo lost to any hit.
    pub direct_shot: f64,
    /// Per roll (of 36) that hits one of my blots from 7–12 pips. Negative,
    /// weaker than a direct shot.
    pub indirect_shot: f64,
    /// Per pip a hit would cost, per hitting roll (of 36), i.e. applied to
    /// `direct_shot_pips_on_me / 36` (indirect shots count
    /// [`INDIRECT_HIT_COST_SHARE`] of a direct one). Negative: `−0.02` per
    /// pip is the plain pip value, so `−0.035` prices being hit at about one
    /// and three quarter times the pips lost (tempo, re-entry).
    pub hit_cost: f64,
    /// Relative increase of `hit_cost` per made point in the opposing home
    /// board the hit checker would have to re-enter against. Positive.
    pub hit_cost_per_home_point: f64,
    /// Per point I hold with two or more checkers. Positive: flexibility
    /// and landing spots.
    pub point_made: f64,
    /// Per point of my longest prime. Positive: blocking power.
    pub prime_len: f64,
    /// Per anchor (my made point in their home board). Positive: a safe
    /// landing spot for the back checkers, partly offsetting the
    /// `checker_back` penalty. Kept modest because the 24-point anchor, the
    /// weakest, counts the same as an advanced one, and a higher value made
    /// every opening split look like a blunder.
    pub anchor: f64,
    /// Per made point in my home board. Positive: containment after a hit.
    pub home_board_point: f64,
    /// Per checker of mine in their home board (bar excluded). Negative:
    /// those checkers still have to escape.
    pub checker_back: f64,
    /// Per checker of mine on the bar (on top of its 25 pips). Negative:
    /// tempo loss and closed-board risk.
    pub bar: f64,
    /// Per checker of mine borne off. Positive: irreversible progress.
    pub off: f64,
}

/// Share of a direct shot's hit cost charged for an indirect shot.
pub const INDIRECT_HIT_COST_SHARE: f64 = 0.5;

/// The contact weight table. Holding games use it unchanged in this piece.
///
/// Exposure example: a lone blot slotted on my 5-point with 11 direct shots
/// against a two-point board costs `11·0.003 + 11·20/36·0.035·1.5 ≈ 0.35`
/// logit; the same 11 shots at a split back checker on my 24-point cost
/// `0.033 + 11·1/36·0.0525 ≈ 0.05`.
pub const CONTACT: ContactWeights = ContactWeights {
    pip: -0.02,
    blot: -0.04,
    direct_shot: -0.003,
    indirect_shot: -0.0015,
    hit_cost: -0.035,
    hit_cost_per_home_point: 0.25,
    point_made: 0.05,
    prime_len: 0.10,
    anchor: 0.10,
    home_board_point: 0.15,
    checker_back: -0.08,
    bar: -0.40,
    off: 0.05,
};

/// Weights of the logistic for `P(gammon | I win)` in contact positions,
/// evaluated on the features of the side that wins. The loser can only be
/// gammoned while it has nothing off; that is a hard zero, not a weight.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GammonWeights {
    /// Intercept. Negative: gammons are the exception.
    pub bias: f64,
    /// Per opposing checker in my home board (bar excluded). Positive.
    pub back_checker: f64,
    /// Per opposing checker on the bar. Positive, stronger than a back
    /// checker because it has not even entered.
    pub bar_checker: f64,
    /// Per made point in my home board. Positive: containment.
    pub home_board_point: f64,
    /// Per checker I have borne off. Positive: the race to finish.
    pub off: f64,
    /// Per roll of race margin: the loser's rolls to bring every checker
    /// home and one off, minus my rolls to finish (capped at
    /// [`GAMMON_WINNER_HORIZON_ROLLS`]), clamped to ±[`GAMMON_MARGIN_CLAMP`].
    /// Positive: the further the loser's checkers are from home, the more
    /// of my wins are gammons.
    pub race_margin: f64,
}

/// Contact gammon weights. Opening: the loser needs ≈ 10.4 rolls to get a
/// checker off against the capped 10, so `σ(−2 + 2·0.35 + 0.35 + 0.4·0.4)
/// ≈ 0.31` of my wins are gammons, ≈ 0.16 absolute. A closed-out opponent
/// with two on the bar and the rest home: margin ≈ −2.4 rolls, share ≈ 0.5;
/// with the rest stuck in my outfield: margin clamped at +6, share ≈ 0.97.
pub const GAMMON: GammonWeights = GammonWeights {
    bias: -2.0,
    back_checker: 0.35,
    bar_checker: 0.45,
    home_board_point: 0.35,
    off: 0.10,
    race_margin: 0.4,
};

/// Weights of the logistic for `P(backgammon | I win a gammon)`: only the
/// loser's checkers in my home board or on the bar matter. If there are
/// none the share is a hard zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgammonWeights {
    /// Intercept. Strongly negative.
    pub bias: f64,
    /// Per opposing checker in my home board (bar excluded). Positive.
    pub back_checker: f64,
    /// Per opposing checker on the bar. Positive.
    pub bar_checker: f64,
}

/// Backgammon share weights. Opening: `σ(−4 + 2·0.5) ≈ 0.047` of gammons.
pub const BACKGAMMON: BackgammonWeights = BackgammonWeights {
    bias: -4.0,
    back_checker: 0.5,
    bar_checker: 0.7,
};

/// Club-strength heuristic evaluator (see the module docs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct ClubEvaluator;

impl Evaluator for ClubEvaluator {
    fn evaluate(&self, pos: &Position) -> Probs {
        if let Some(final_probs) = terminal(pos) {
            return final_probs;
        }
        let probs = match classify(pos) {
            PositionClass::Contact => contact_probs(pos),
            PositionClass::Race => race_probs(pos),
            PositionClass::Bearoff => bearoff_probs(pos),
        };
        probs.clamp()
    }
}

/// Exact probabilities for a finished game, `None` otherwise.
fn terminal(pos: &Position) -> Option<Probs> {
    let mine = features::extract(pos);
    if mine.off_mine >= CHECKERS {
        let gammon = mine.off_theirs == 0;
        let backgammon = gammon && mine.checkers_back_theirs + mine.bar_theirs > 0;
        return Some(Probs {
            win: 1.0,
            win_g: f64::from(u8::from(gammon)),
            win_bg: f64::from(u8::from(backgammon)),
            lose_g: 0.0,
            lose_bg: 0.0,
        });
    }
    if mine.off_theirs >= CHECKERS {
        let gammon = mine.off_mine == 0;
        let backgammon = gammon && mine.checkers_back_mine + mine.bar_mine > 0;
        return Some(Probs {
            win: 0.0,
            win_g: 0.0,
            win_bg: 0.0,
            lose_g: f64::from(u8::from(gammon)),
            lose_bg: f64::from(u8::from(backgammon)),
        });
    }
    None
}

/// Contact model: antisymmetric linear score plus conditional gammon and
/// backgammon logistics, each evaluated once per side.
fn contact_probs(pos: &Position) -> Probs {
    let me = features::extract(pos);
    let them = features::extract(&pos.flip());
    let score = side_score(&CONTACT, &me) - side_score(&CONTACT, &them) + ON_ROLL_LOGIT;
    let win = sigmoid(score);
    assemble(win, gammon_share(&me), gammon_share(&them), &me, &them)
}

/// `Σ wᵢ·fᵢ` over one side's own features, plus the hit-cost term (see the
/// module docs).
fn side_score(w: &ContactWeights, f: &Features) -> f64 {
    let weighted_shot_pips = f64::from(f.direct_shot_pips_on_me)
        + INDIRECT_HIT_COST_SHARE * f64::from(f.indirect_shot_pips_on_me);
    let board_factor = 1.0 + w.hit_cost_per_home_point * f64::from(f.home_board_points_theirs);
    w.pip * f64::from(f.pips_mine)
        + w.blot * f64::from(f.blots_mine)
        + w.direct_shot * f64::from(f.direct_shots_on_me)
        + w.indirect_shot * f64::from(f.indirect_shots_on_me)
        + w.hit_cost * board_factor * weighted_shot_pips / DICE_OUTCOMES
        + w.point_made * f64::from(f.points_made_mine)
        + w.prime_len * f64::from(f.prime_len_mine)
        + w.anchor * f64::from(f.anchors_mine)
        + w.home_board_point * f64::from(f.home_board_points_mine)
        + w.checker_back * f64::from(f.checkers_back_mine)
        + w.bar * f64::from(f.bar_mine)
        + w.off * f64::from(f.off_mine)
}

/// `P(gammon | this side wins)` from the winner's features; zero once the
/// loser has borne off a checker. See the module docs for the race term.
fn gammon_share(winner: &Features) -> f64 {
    if winner.off_theirs > 0 {
        return 0.0;
    }
    let loser_rolls_to_first_off = f64::from(winner.outside_pips_theirs) / AVG_PIPS_PER_ROLL + 1.0;
    let winner_on_board = f64::from(CHECKERS.saturating_sub(winner.off_mine));
    let winner_rolls_to_finish = (f64::from(winner.pips_mine) / AVG_PIPS_PER_ROLL)
        .max(winner_on_board / AVG_CHECKERS_OFF_PER_ROLL)
        .min(GAMMON_WINNER_HORIZON_ROLLS);
    let margin = (loser_rolls_to_first_off - winner_rolls_to_finish)
        .clamp(-GAMMON_MARGIN_CLAMP, GAMMON_MARGIN_CLAMP);
    sigmoid(
        GAMMON.bias
            + GAMMON.back_checker * f64::from(winner.checkers_back_theirs)
            + GAMMON.bar_checker * f64::from(winner.bar_theirs)
            + GAMMON.home_board_point * f64::from(winner.home_board_points_mine)
            + GAMMON.off * f64::from(winner.off_mine)
            + GAMMON.race_margin * margin,
    )
}

/// `P(backgammon | this side wins a gammon)` from the winner's features;
/// zero unless the loser has checkers in the winner's home board or on the
/// bar.
fn backgammon_share(winner: &Features) -> f64 {
    let trapped = winner.checkers_back_theirs;
    let on_bar = winner.bar_theirs;
    if trapped + on_bar == 0 {
        return 0.0;
    }
    sigmoid(
        BACKGAMMON.bias
            + BACKGAMMON.back_checker * f64::from(trapped)
            + BACKGAMMON.bar_checker * f64::from(on_bar),
    )
}

/// Race model: the Task 7 curve from both viewpoints, combined in logit
/// space (win) and probability space (gammons); see the module docs.
fn race_probs(pos: &Position) -> Probs {
    let flipped = pos.flip();
    let p_me = race::race_win_probability(pos);
    let p_them = race::race_win_probability(&flipped);
    let win = sigmoid(ON_ROLL_LOGIT + (logit(p_me) - logit(p_them)) / 2.0);
    race_with_win(pos, &flipped, win)
}

/// Bear-off model: logistic on the lead in expected rolls to finish, using
/// the un-bumped Keith counts (each side's count as `theirs` in one of the
/// two viewpoints) for wastage.
fn bearoff_probs(pos: &Position) -> Probs {
    let flipped = pos.flip();
    let (_, keith_them) = race::keith_count(pos);
    let (_, keith_me) = race::keith_count(&flipped);
    let rolls = |keith: u32, side: &[u8; SLOTS]| {
        let on_board: u32 = side[1..=BAR].iter().map(|&n| u32::from(n)).sum();
        (f64::from(keith) / AVG_PIPS_PER_ROLL).max(f64::from(on_board) / AVG_CHECKERS_OFF_PER_ROLL)
    };
    let lead = rolls(keith_them, &pos.theirs) - rolls(keith_me, &pos.mine);
    let win = sigmoid(ON_ROLL_LOGIT + BEAROFF_SLOPE * lead);
    race_with_win(pos, &flipped, win)
}

/// Gammon and backgammon estimates for a non-contact position given `win`.
/// Race gammons are absolute probabilities; they are averaged over the two
/// viewpoints and then expressed as shares of `win` / `1 − win` so the
/// ordering clamps hold.
fn race_with_win(pos: &Position, flipped: &Position, win: f64) -> Probs {
    let (my_g_a, their_g_a) = race::race_gammon_probabilities(pos);
    let (their_g_b, my_g_b) = race::race_gammon_probabilities(flipped);
    let my_g = f64::midpoint(my_g_a, my_g_b);
    let their_g = f64::midpoint(their_g_a, their_g_b);
    let me = features::extract(pos);
    let them = features::extract(flipped);
    let win_g = my_g.min(win);
    let lose_g = their_g.min(1.0 - win);
    Probs {
        win,
        win_g,
        win_bg: win_g * backgammon_share(&me),
        lose_g,
        lose_bg: lose_g * backgammon_share(&them),
    }
}

/// Builds the distribution from `win` and the two conditional gammon shares.
fn assemble(win: f64, my_share: f64, their_share: f64, me: &Features, them: &Features) -> Probs {
    let win_g = win * my_share;
    let lose_g = (1.0 - win) * their_share;
    Probs {
        win,
        win_g,
        win_bg: win_g * backgammon_share(me),
        lose_g,
        lose_bg: lose_g * backgammon_share(them),
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Logit of `p` after pulling it away from 0 and 1 by [`LOGIT_EPS`].
fn logit(p: f64) -> f64 {
    let p = if p.is_nan() {
        0.5
    } else {
        p.clamp(LOGIT_EPS, 1.0 - LOGIT_EPS)
    };
    (p / (1.0 - p)).ln()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logit_is_finite_at_the_extremes() {
        assert!(logit(0.0).is_finite());
        assert!(logit(1.0).is_finite());
        assert!(logit(f64::NAN).abs() < 1e-12);
        assert!((sigmoid(logit(0.3)) - 0.3).abs() < 1e-9);
    }
}
