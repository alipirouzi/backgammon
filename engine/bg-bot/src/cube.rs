//! Cube decisions: a **doubling window** on top of the **dead-cube MET
//! model**.
//!
//! # Equities (plan, Task 10; Janowski cube-life index `x = 0`)
//!
//! Let `p` be the outcome probabilities for the player considering a double
//! ("me", `pos.mine`, on roll before rolling). Three equities are compared,
//! all on the equity scale of the *current* match context (see the
//! normalisation in [`met`](mod@crate::met): a single win at the current cube is
//! `+1`, a single loss `−1`):
//!
//! * **No double** (`ND`): the game is played to the end at the current cube
//!   value with no further cube action — [`equity_for`] of `p`.
//! * **Double/take** (`DT`): the cube is doubled and the game is then played
//!   cubeless at the doubled value. Money: `2·E` where `E` is the cubeless
//!   money equity. Match: [`cubeless_mwc`] at the doubled cube, mapped back
//!   onto the current cube's scale.
//! * **Double/drop** (`DP`): I win the current cube value — exactly `+1` on
//!   this scale, by construction.
//!
//! The equities are "dead cube" because all future cube leverage (mine if I
//! wait, the taker's redoubles if I double) is ignored. On their own they
//! are not a doubling rule: with `DT = 2·E` and `ND = E` in a money game,
//! *any* positive cubeless equity would call for a double — the model would
//! double from the opening position (`E ≈ 0.02`). A real doubling point
//! needs a substantial advantage, because doubling gives the cube away and
//! not doubling keeps the option to double later (market-loser logic).
//!
//! # The doubling window (threshold approximation of a live-cube model)
//!
//! The window is a **threshold approximation of a live-cube model**: instead
//! of pricing cube ownership (Janowski `x ≈ 0.7`), it gates the dead-cube
//! arithmetic with the classic money-game win-probability landmarks of a
//! gammonless live cube. With `w = p.win` and `g = p.win_g` for the side on
//! roll:
//!
//! * **Doubling point** [`DOUBLE_POINT`] `= 0.68`: an initial double is
//!   recommended only when `w ≥ 0.68`. **Redoubling point**
//!   [`REDOUBLE_POINT`] `= 0.70` when I own the cube (giving up ownership
//!   costs more).
//! * **Take point**: the opponent takes iff `DT < DP` — the dead-cube
//!   arithmetic with gammons. Gammonless this is the taker's
//!   `w ≥ 0.25` in a money game ([`MONEY_TAKE_POINT`]) and, in a match, the
//!   win probability where taking equals dropping under the dead-cube model
//!   (below), computed from the match equity table.
//! * **Too good** ([`TOO_GOOD_WIN`], [`TOO_GOOD_GAMMON`]): with `w ≥ 0.85`
//!   and `g ≥ 0.25` playing on for the gammon beats cashing, provided a
//!   gammon is worth more than a single win at the current stake and the
//!   opponent would pass the double (otherwise the double branch decides).
//!   Independently, `ND > DP` is always too good: cubeless play-on is a
//!   lower bound on the value of playing on while I control the cube.
//!
//! The same thresholds gate **match play**. The equities and the take point
//! are converted through match equity by the MET helpers, so the take side
//! is score-dependent; the doubling side is bounded below by the money
//! landmarks: a double is never recommended below `w = 0.68` (`0.70`
//! owning the cube), even at scores where the dead-cube arithmetic alone
//! would double earlier (2-away/2-away, where the doubled cube is dead and
//! the dead-cube arithmetic is exact, is the notable case). Within the
//! window the dead-cube gain check still applies: a double must also
//! satisfy `min(DT, DP) > ND`, which is what stops the post-Crawford leader
//! or a 2-away cube owner from turning a cube that can only hurt.
//!
//! # Money-game races: Keith's window
//!
//! In a pure race the dead-cube arithmetic is not merely early, it is
//! wrong: with no gammons `DT = 4w − 2` exceeds `ND = 2w − 1` for every
//! `w > 0.5`, so the model would double a dead-even race. For a **race in a
//! money game** [`cube_analysis_for`] therefore takes the action from Tom
//! Keith's count (<https://bkgm.com/articles/CubeHandlingInRaces/>, the
//! same counts as [`crate::race::keith_count`]): with `D` = the roller's
//! bumped count minus the opponent's, double iff `D ≤ 4`, redouble iff
//! `D ≤ 3`, and the opponent takes iff `D ≥ 2`. "Too good" still applies
//! as above. The three equities are still the dead-cube ones, reported for
//! information; the action is Keith's. Keith's thresholds are money
//! thresholds, so match-play races use the doubling window above (a known
//! approximation), as do contact positions everywhere.
//!
//! # Decision rules
//!
//! * The cube cannot be turned in the Crawford game or when the opponent
//!   owns it ([`can_double`] is `false`): the action is always
//!   [`CubeAction::NoDouble`].
//! * Otherwise, if the position is too good (above), the action is
//!   [`CubeAction::TooGood`].
//! * Otherwise I double iff `w` is at or above the doubling (redoubling)
//!   point **and** the opponent's best reply, `min(DT, DP)`, strictly beats
//!   `ND` (ties favour not doubling). If I double, the opponent takes iff
//!   `DT < DP` (strictly; at exactly the take point the analysis says drop).
//! * Otherwise [`CubeAction::NoDouble`], or [`CubeAction::NoRedouble`] when
//!   I own the cube. "Redouble" variants are reported when I own the cube.
//!
//! [`CubeAnalysis::take_point`] is the classic *gammonless* take point: the
//! taker's winning probability at which taking and dropping are equal under
//! the dead-cube model (money: `0.25`; match: `(W2 − W1) / (W2 − L2)` in
//! MWC terms, where `W1` is my MWC after winning the current cube and
//! `W2`/`L2` my MWC after winning/losing the doubled cube).

use bg_core::Position;
use serde::{Deserialize, Serialize};

use crate::race::{DOUBLE_POINT_LEAD, REDOUBLE_POINT_LEAD, TAKE_POINT_LEAD, keith_lead};
use crate::{MatchContext, Probs, cubeless_mwc, equity_for, mwc_after};

/// Equity of winning the current cube value (double/drop) on the current
/// context's scale: the `+1` anchor of [`equity_for`].
const DROP_EQUITY: f64 = 1.0;
/// Gammonless dead-cube take point in a money game: the taker takes with a
/// winning probability of at least this (module docs).
pub const MONEY_TAKE_POINT: f64 = 0.25;
/// Doubling point: an initial double is recommended only when the doubler's
/// cubeless winning probability is at least this (module docs).
pub const DOUBLE_POINT: f64 = 0.68;
/// Redoubling point: the doubling point when I already own the cube.
pub const REDOUBLE_POINT: f64 = 0.70;
/// "Too good" needs at least this winning probability ...
pub const TOO_GOOD_WIN: f64 = 0.85;
/// ... together with at least this gammon probability (module docs).
pub const TOO_GOOD_GAMMON: f64 = 0.25;

/// The three dead-cube equities a decision compares (module docs).
#[derive(Debug, Clone, Copy)]
struct Equities {
    /// No double: play on at the current cube.
    nd: f64,
    /// Double/take: play on cubeless at the doubled cube.
    dt: f64,
    /// Double/drop: cash the current cube.
    dp: f64,
}

/// Recommended cube action for the side on roll before rolling.
///
/// Wire format (`camelCase`): `"noDouble" | "doubleTake" | "doubleDrop" |
/// "tooGood" | "redoubleTake" | "redoubleDrop" | "noRedouble"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeAction {
    /// Do not double (cube centred, or the cube cannot be turned at all).
    NoDouble,
    /// Double; the opponent should take.
    DoubleTake,
    /// Double; the opponent should drop.
    DoubleDrop,
    /// Playing on is worth more than cashing: do not double.
    TooGood,
    /// Redouble (I own the cube); the opponent should take.
    RedoubleTake,
    /// Redouble (I own the cube); the opponent should drop.
    RedoubleDrop,
    /// I own the cube and should not redouble.
    NoRedouble,
}

/// The cube decision a player actually made, for grading with
/// [`cube_error`]. `NoDouble`/`Double` are the doubler's choices, `Take`/
/// `Drop` the opponent's answer to a double.
///
/// Wire format (`camelCase`): `"noDouble" | "double" | "take" | "drop"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CubeChoice {
    /// The player on roll rolled without doubling.
    NoDouble,
    /// The player on roll doubled.
    Double,
    /// The opponent took the double.
    Take,
    /// The opponent dropped the double.
    Drop,
}

/// Cube analysis for the side on roll before rolling. All equities are on
/// the current context's scale (a single win at the current cube is `+1`).
///
/// Wire format (`camelCase`): `{ "action", "canDouble", "equityNoDouble",
/// "equityDoubleTake", "equityDoubleDrop", "takePoint" }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CubeAnalysis {
    /// The recommended action.
    pub action: CubeAction,
    /// `false` in the Crawford game or when the opponent owns the cube; the
    /// action is then always [`CubeAction::NoDouble`].
    pub can_double: bool,
    /// Equity of playing on at the current cube (`ND`).
    pub equity_no_double: f64,
    /// Equity after double/take, played cubeless at the doubled value (`DT`).
    pub equity_double_take: f64,
    /// Equity of cashing the current cube (`DP`); always `1.0` on this scale.
    pub equity_double_drop: f64,
    /// Gammonless take point: the taker's winning probability at which take
    /// and drop are equal under this model.
    pub take_point: f64,
}

/// `true` when the side on roll may turn the cube: not the Crawford game
/// and the cube is centred or mine.
#[must_use]
pub fn can_double(ctx: &MatchContext) -> bool {
    !ctx.crawford && ctx.cube_owner_is_me != Some(false)
}

/// The analysis of `p` (probabilities for the side on roll, before rolling)
/// in `ctx`: the dead-cube equities and the windowed action; see the
/// [module docs](self) for the model and rules.
#[must_use]
pub fn cube_analysis(ctx: &MatchContext, p: &Probs) -> CubeAnalysis {
    let p = p.clamp();
    let e = Equities {
        nd: equity_for(ctx, &p),
        dt: double_take_equity(*ctx, &p),
        dp: DROP_EQUITY,
    };
    let can_double = can_double(ctx);
    let action = decide(
        can_double,
        ctx.cube_owner_is_me == Some(true),
        gammons_matter(*ctx),
        &p,
        e,
    );
    CubeAnalysis {
        action,
        can_double,
        equity_no_double: e.nd,
        equity_double_take: e.dt,
        equity_double_drop: e.dp,
        take_point: take_point(*ctx),
    }
}

/// The cube analysis of `pos` for the side on roll: Keith's race window when
/// `pos` is a race in a money game (module docs), else [`cube_analysis`].
#[must_use]
pub fn cube_analysis_for(ctx: &MatchContext, pos: &Position, p: &Probs) -> CubeAnalysis {
    let analysis = cube_analysis(ctx, p);
    if !(ctx.is_money() && pos.is_race()) {
        return analysis;
    }
    let action = decide_race(
        analysis.can_double,
        ctx.cube_owner_is_me == Some(true),
        analysis.action == CubeAction::TooGood,
        keith_lead(pos),
    );
    CubeAnalysis { action, ..analysis }
}

/// Keith's race decision for the bumped lead `d` (module docs).
fn decide_race(can_double: bool, i_own_cube: bool, too_good: bool, d: i64) -> CubeAction {
    if !can_double {
        return CubeAction::NoDouble;
    }
    if too_good {
        return CubeAction::TooGood;
    }
    let window = if i_own_cube {
        REDOUBLE_POINT_LEAD
    } else {
        DOUBLE_POINT_LEAD
    };
    let taken = d >= TAKE_POINT_LEAD;
    match (d <= window, i_own_cube, taken) {
        (false, false, _) => CubeAction::NoDouble,
        (false, true, _) => CubeAction::NoRedouble,
        (true, false, true) => CubeAction::DoubleTake,
        (true, false, false) => CubeAction::DoubleDrop,
        (true, true, true) => CubeAction::RedoubleTake,
        (true, true, false) => CubeAction::RedoubleDrop,
    }
}

/// The equity lost by `choice` against the recommended `analysis.action`,
/// on the same scale (never negative). A choice that agrees with the
/// recommendation costs `0`; one that disagrees costs the size of the
/// model's gap: `|min(DT, DP) − ND|` for the doubler's choices and
/// `|DT − DP|` for the taker's (the doubler's `DT` above `DP` is the taker's
/// loss for taking, and vice versa). Grading against the *action* rather
/// than re-deriving it from the equities keeps a Keith-gated race decision
/// ([`cube_analysis_for`]) and its grade consistent; for the dead-cube
/// model the two coincide. Every choice costs `0` when the cube could not
/// be turned.
#[must_use]
pub fn cube_error(analysis: &CubeAnalysis, choice: CubeChoice) -> f64 {
    if !analysis.can_double {
        return 0.0;
    }
    let nd = analysis.equity_no_double;
    let dt = analysis.equity_double_take;
    let dp = analysis.equity_double_drop;
    let recommends_double = matches!(
        analysis.action,
        CubeAction::DoubleTake
            | CubeAction::DoubleDrop
            | CubeAction::RedoubleTake
            | CubeAction::RedoubleDrop
    );
    let recommends_take = match analysis.action {
        CubeAction::DoubleTake | CubeAction::RedoubleTake => true,
        CubeAction::DoubleDrop | CubeAction::RedoubleDrop => false,
        // No double recommended: the taker's answer follows the model.
        CubeAction::NoDouble | CubeAction::TooGood | CubeAction::NoRedouble => dt < dp,
    };
    let agrees = match choice {
        CubeChoice::NoDouble => !recommends_double,
        CubeChoice::Double => recommends_double,
        CubeChoice::Take => recommends_take,
        CubeChoice::Drop => !recommends_take,
    };
    if agrees {
        return 0.0;
    }
    match choice {
        CubeChoice::NoDouble | CubeChoice::Double => (dt.min(dp) - nd).abs(),
        CubeChoice::Take | CubeChoice::Drop => (dt - dp).abs(),
    }
}

/// The action for the (clamped) probabilities `p` and the three equities,
/// per the decision rules in the module docs. `gammons_matter` is
/// [`gammons_matter`] of the context.
fn decide(
    can_double: bool,
    i_own_cube: bool,
    gammons_matter: bool,
    p: &Probs,
    e: Equities,
) -> CubeAction {
    if !can_double {
        return CubeAction::NoDouble;
    }
    let opponent_passes = e.dt >= e.dp;
    let too_good_for_gammon =
        p.win >= TOO_GOOD_WIN && p.win_g >= TOO_GOOD_GAMMON && gammons_matter && opponent_passes;
    if e.nd > e.dp || too_good_for_gammon {
        return CubeAction::TooGood;
    }
    let doubling_point = if i_own_cube {
        REDOUBLE_POINT
    } else {
        DOUBLE_POINT
    };
    let in_window = p.win >= doubling_point && e.dt.min(e.dp) > e.nd;
    match (in_window, i_own_cube, opponent_passes) {
        (false, false, _) => CubeAction::NoDouble,
        (false, true, _) => CubeAction::NoRedouble,
        (true, false, false) => CubeAction::DoubleTake,
        (true, false, true) => CubeAction::DoubleDrop,
        (true, true, false) => CubeAction::RedoubleTake,
        (true, true, true) => CubeAction::RedoubleDrop,
    }
}

/// `true` when a gammon at the current stake is worth more to me than a
/// single win: always in a money game; in a match, when winning twice the
/// stake improves my MWC over winning it once (it does not when a single
/// win already wins the match).
fn gammons_matter(ctx: MatchContext) -> bool {
    if ctx.is_money() {
        return true;
    }
    let stake = ctx.cube.max(1);
    mwc_after(&ctx, true, stake.saturating_mul(2)) > mwc_after(&ctx, true, stake)
}

/// `DT`: the game played cubeless at the doubled cube, on the current scale.
fn double_take_equity(ctx: MatchContext, p: &Probs) -> f64 {
    if ctx.is_money() {
        return 2.0 * p.cubeless_equity();
    }
    let doubled = MatchContext {
        cube: doubled_cube(ctx),
        cube_owner_is_me: Some(false),
        ..ctx
    };
    mwc_to_equity(ctx, cubeless_mwc(&doubled, p))
}

/// The cube value after a double (saturating, so a runaway cube stays a
/// valid `u8`).
fn doubled_cube(ctx: MatchContext) -> u8 {
    ctx.cube.max(1).saturating_mul(2)
}

/// Maps a match winning chance onto `ctx`'s equity scale, exactly as
/// [`equity_for`] does: `2·(mwc − L1)/(W1 − L1) − 1` with `W1`/`L1` my MWC
/// after a single win/loss at the current cube. For a degenerate span
/// (only possible for clamped, beyond-table contexts) it falls back to
/// `2·mwc − 1` so the result stays finite.
fn mwc_to_equity(ctx: MatchContext, mwc: f64) -> f64 {
    let stake = ctx.cube.max(1);
    let win1 = mwc_after(&ctx, true, stake);
    let lose1 = mwc_after(&ctx, false, stake);
    let span = win1 - lose1;
    if span <= f64::EPSILON {
        return 2.0 * mwc - 1.0;
    }
    2.0 * (mwc - lose1) / span - 1.0
}

/// Gammonless take point for the opponent (see the module docs).
fn take_point(ctx: MatchContext) -> f64 {
    if ctx.is_money() {
        return MONEY_TAKE_POINT;
    }
    let win1 = mwc_after(&ctx, true, ctx.cube.max(1));
    let win2 = mwc_after(&ctx, true, doubled_cube(ctx));
    let lose2 = mwc_after(&ctx, false, doubled_cube(ctx));
    let span = win2 - lose2;
    if span <= f64::EPSILON {
        return 0.0;
    }
    ((win2 - win1) / span).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gammonless money equities for the roller's win probability `w`.
    fn money(w: f64) -> (Probs, Equities) {
        let p = Probs {
            win: w,
            ..Probs::default()
        };
        let e = Equities {
            nd: 2.0 * w - 1.0,
            dt: 4.0 * w - 2.0,
            dp: 1.0,
        };
        (p, e)
    }

    fn money_decide(i_own_cube: bool, w: f64) -> CubeAction {
        let (p, e) = money(w);
        decide(true, i_own_cube, true, &p, e)
    }

    #[test]
    fn decide_is_total_and_follows_the_rules() {
        let (p, e) = money(0.9);
        assert_eq!(decide(false, false, true, &p, e), CubeAction::NoDouble);
        assert_eq!(decide(false, true, true, &p, e), CubeAction::NoDouble);
        // Below the doubling window the arithmetic alone does not double.
        assert_eq!(money_decide(false, 0.51), CubeAction::NoDouble);
        assert_eq!(money_decide(false, 0.65), CubeAction::NoDouble);
        assert_eq!(money_decide(true, 0.69), CubeAction::NoRedouble);
        // Inside it: take below the cash point, drop at and above it.
        assert_eq!(money_decide(false, 0.68), CubeAction::DoubleTake);
        assert_eq!(money_decide(false, 0.74), CubeAction::DoubleTake);
        assert_eq!(money_decide(false, 0.75), CubeAction::DoubleDrop);
        assert_eq!(money_decide(false, 0.80), CubeAction::DoubleDrop);
        assert_eq!(money_decide(true, 0.70), CubeAction::RedoubleTake);
        assert_eq!(money_decide(true, 0.80), CubeAction::RedoubleDrop);
        assert_eq!(money_decide(false, 0.45), CubeAction::NoDouble);
        assert_eq!(money_decide(false, 0.5), CubeAction::NoDouble);
        assert_eq!(money_decide(true, 0.40), CubeAction::NoRedouble);
        // Gammonless there is no "too good": a near-certain win is a cash
        // (at exactly w = 1 cashing and playing on tie, and ties do not
        // double).
        assert_eq!(money_decide(false, 0.99), CubeAction::DoubleDrop);
        assert_eq!(money_decide(false, 1.0), CubeAction::NoDouble);
    }

    #[test]
    fn decide_too_good_by_threshold_by_arithmetic_and_its_guards() {
        // Threshold (0.85 / 0.25) with cubeless equity 0.95 < DP.
        let p = Probs {
            win: 0.85,
            win_g: 0.25,
            ..Probs::default()
        };
        let e = Equities {
            nd: 0.95,
            dt: 1.9,
            dp: 1.0,
        };
        assert_eq!(decide(true, false, true, &p, e), CubeAction::TooGood);
        assert_eq!(decide(true, true, true, &p, e), CubeAction::TooGood);
        // Just short of either threshold: cash.
        let short_win = Probs { win: 0.84, ..p };
        assert_eq!(
            decide(true, false, true, &short_win, e),
            CubeAction::DoubleDrop
        );
        let short_gammon = Probs { win_g: 0.24, ..p };
        assert_eq!(
            decide(true, false, true, &short_gammon, e),
            CubeAction::DoubleDrop
        );
        // Gammons worth nothing at this score: cash.
        assert_eq!(decide(true, false, false, &p, e), CubeAction::DoubleDrop);
        // The opponent would take: the double branch decides.
        let taken = Equities { dt: 0.98, ..e };
        assert_eq!(decide(true, false, true, &p, taken), CubeAction::DoubleTake);
        // Arithmetic: playing on cubeless already beats cashing.
        let big = Probs {
            win: 0.84,
            win_g: 0.4,
            ..Probs::default()
        };
        let e = Equities {
            nd: 1.08,
            dt: 2.16,
            dp: 1.0,
        };
        assert_eq!(decide(true, false, true, &big, e), CubeAction::TooGood);
        assert_eq!(decide(true, false, false, &big, e), CubeAction::TooGood);
    }

    #[test]
    fn decide_race_follows_keith_thresholds() {
        assert_eq!(decide_race(false, false, false, 0), CubeAction::NoDouble);
        assert_eq!(decide_race(true, false, true, 0), CubeAction::TooGood);
        assert_eq!(decide_race(true, false, false, 14), CubeAction::NoDouble);
        assert_eq!(decide_race(true, false, false, 5), CubeAction::NoDouble);
        assert_eq!(decide_race(true, false, false, 4), CubeAction::DoubleTake);
        assert_eq!(decide_race(true, false, false, 2), CubeAction::DoubleTake);
        assert_eq!(decide_race(true, false, false, 1), CubeAction::DoubleDrop);
        assert_eq!(decide_race(true, false, false, -10), CubeAction::DoubleDrop);
        assert_eq!(decide_race(true, true, false, 4), CubeAction::NoRedouble);
        assert_eq!(decide_race(true, true, false, 3), CubeAction::RedoubleTake);
        assert_eq!(decide_race(true, true, false, 1), CubeAction::RedoubleDrop);
    }

    #[test]
    fn cube_error_is_zero_for_the_recommended_action_even_when_gated() {
        // A Keith-gated race: the model says double, the action says not.
        let a = CubeAnalysis {
            action: CubeAction::NoDouble,
            can_double: true,
            equity_no_double: 0.3,
            equity_double_take: 0.6,
            equity_double_drop: 1.0,
            take_point: 0.25,
        };
        assert!(cube_error(&a, CubeChoice::NoDouble).abs() < 1e-12);
        assert!((cube_error(&a, CubeChoice::Double) - 0.3).abs() < 1e-12);
        let drop = CubeAnalysis {
            action: CubeAction::DoubleDrop,
            ..a
        };
        assert!(cube_error(&drop, CubeChoice::Drop).abs() < 1e-12);
        assert!((cube_error(&drop, CubeChoice::Take) - 0.4).abs() < 1e-12);
    }

    #[test]
    fn mwc_to_equity_anchors_single_win_and_loss() {
        let ctx = MatchContext {
            length: 7,
            my_away: 4,
            their_away: 6,
            crawford: false,
            post_crawford: false,
            cube: 2,
            cube_owner_is_me: Some(true),
        };
        let win1 = mwc_after(&ctx, true, 2);
        let lose1 = mwc_after(&ctx, false, 2);
        assert!((mwc_to_equity(ctx, win1) - 1.0).abs() < 1e-12);
        assert!((mwc_to_equity(ctx, lose1) + 1.0).abs() < 1e-12);
        let p = Probs {
            win: 0.6,
            win_g: 0.1,
            ..Probs::default()
        };
        assert!((mwc_to_equity(ctx, cubeless_mwc(&ctx, &p)) - equity_for(&ctx, &p)).abs() < 1e-12);
    }

    #[test]
    fn take_point_is_clamped_and_finite_for_extreme_cubes() {
        let ctx = MatchContext {
            length: 3,
            my_away: 1,
            their_away: 3,
            crawford: false,
            post_crawford: true,
            cube: 255,
            cube_owner_is_me: None,
        };
        let tp = take_point(ctx);
        assert!(tp.is_finite());
        assert!((0.0..=1.0).contains(&tp));
        assert_eq!(doubled_cube(ctx), u8::MAX);
    }
}
