//! Match equity: the Kazaross-XG2 table and the helpers that turn outcome
//! probabilities into match winning chances (MWC) and normalised equity.
//!
//! # Conventions
//!
//! * `away` counts are points still needed to win the match (`1..=25`).
//!   Values outside that range are clamped: `0` is treated as `1` (a player
//!   who needs nothing has effectively reached match point) and anything
//!   above `25` as `25` (the table's extrapolation limit, as in GNU
//!   Backgammon).
//! * The pre-Crawford table's 1-away entries are the values **with the
//!   Crawford game still to be played**. The post-Crawford table applies once
//!   the Crawford game has been played.
//! * A [`MatchContext`] with `length == 0` is a money game: MWC is not a
//!   meaningful notion there, so [`mwc_after`] degenerates to a win
//!   indicator (`1.0` win, `0.0` loss) and [`equity_for`] returns the
//!   cubeless money equity unchanged.
//!
//! # Normalisation of [`equity_for`]
//!
//! In a match, `equity_for` is the "equivalent to money game" (EMG)
//! equity: MWC is mapped affinely so that **losing a single game at the
//! current cube value is `−1` and winning one is `+1`**:
//!
//! ```text
//! r = (cubeless_mwc − mwc_after(lose, cube)) / (mwc_after(win, cube) − mwc_after(lose, cube))
//! equity_for = 2·r − 1
//! ```
//!
//! On this scale match equities are directly comparable with cubeless money
//! equities (a coin flip without gammons is `0`, gammons push beyond `±1`),
//! so the error thresholds in `analysis::thresholds` apply to both.

use serde::{Deserialize, Serialize};

use crate::evaluator::Probs;
use crate::met_data::{MAX_AWAY, POST_CRAWFORD, PRE_CRAWFORD};

/// Match situation from the perspective of the player on roll ("me").
///
/// Wire format (`camelCase`): `{ "length", "myAway", "theirAway",
/// "crawford", "postCrawford", "cube", "cubeOwnerIsMe" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchContext {
    /// Match length in points; `0` means a money game.
    pub length: u8,
    /// Points I still need to win the match.
    pub my_away: u8,
    /// Points the opponent still needs to win the match.
    pub their_away: u8,
    /// The current game is the Crawford game (no cube; the next game, if
    /// any, is post-Crawford).
    pub crawford: bool,
    /// The Crawford game has already been played.
    pub post_crawford: bool,
    /// Current cube value (`1` when centred or in a Crawford game).
    pub cube: u8,
    /// `Some(true)` if I own the cube, `Some(false)` if the opponent does,
    /// `None` if it is centred.
    pub cube_owner_is_me: Option<bool>,
}

impl MatchContext {
    /// `true` for a money game (`length == 0`).
    #[must_use]
    pub fn is_money(&self) -> bool {
        self.length == 0
    }
}

/// Clamps an away count into the table range `1..=25` and converts it to a
/// zero-based index.
fn index(away: u8) -> usize {
    usize::from(away).clamp(1, MAX_AWAY) - 1
}

/// Pre-Crawford match winning chances for the player who is `my_away`
/// points from winning against an opponent `their_away` points from
/// winning (Kazaross-XG2). Symmetric: `met(a, b) + met(b, a) == 1`,
/// `met(a, a) == 0.5`. Away counts are clamped to `1..=25`.
#[must_use]
pub fn met(my_away: u8, their_away: u8) -> f64 {
    PRE_CRAWFORD[index(my_away)][index(their_away)]
}

/// Post-Crawford match winning chances for the **trailer** who is
/// `trailer_away` points from winning while the leader is 1-away and the
/// Crawford game has been played. `met_post_crawford(1) == 0.5` (double
/// match point). Away counts are clamped to `1..=25`.
#[must_use]
pub fn met_post_crawford(trailer_away: u8) -> f64 {
    POST_CRAWFORD[index(trailer_away)]
}

/// My match winning chances after the current game ends with `points` for
/// the winner (`points` is the total awarded, i.e. single/gammon/backgammon
/// **already multiplied by the cube value**).
///
/// * Match won or lost outright → `1.0` / `0.0`.
/// * Otherwise, when the current game is pre-Crawford (both flags `false`),
///   the pre-Crawford table is used; if a side reaches 1-away the next game
///   is the Crawford game, whose value is that table's 1-away entry.
/// * When the current game is the Crawford game or later, the next game is
///   post-Crawford and the post-Crawford table is used for the trailer.
/// * Money game (`length == 0`) → `1.0` if I win, `0.0` otherwise.
#[must_use]
pub fn mwc_after(ctx: &MatchContext, i_win: bool, points: u8) -> f64 {
    if ctx.is_money() {
        return if i_win { 1.0 } else { 0.0 };
    }
    let (my_away, their_away) = if i_win {
        (ctx.my_away.saturating_sub(points), ctx.their_away)
    } else {
        (ctx.my_away, ctx.their_away.saturating_sub(points))
    };
    if my_away == 0 {
        return 1.0;
    }
    if their_away == 0 {
        return 0.0;
    }
    if ctx.crawford || ctx.post_crawford {
        // The leader is 1-away; the table is expressed for the trailer.
        if my_away <= their_away {
            1.0 - met_post_crawford(their_away)
        } else {
            met_post_crawford(my_away)
        }
    } else {
        met(my_away, their_away)
    }
}

/// Points awarded for each terminal outcome, before the cube.
const SINGLE: u8 = 1;
const GAMMON: u8 = 2;
const BACKGAMMON: u8 = 3;

/// Probability-weighted match winning chances if the game is played to the
/// end at the current cube value with no further cube action (the
/// "cubeless" or dead-cube MWC):
/// `Σ P(outcome) · mwc_after(outcome)` over single/gammon/backgammon wins
/// and losses. `p` is clamped first so the six outcome probabilities are
/// non-negative and sum to one.
#[must_use]
pub fn cubeless_mwc(ctx: &MatchContext, p: &Probs) -> f64 {
    let p = p.clamp();
    let lose = 1.0 - p.win;
    let stake = |kind: u8| kind.saturating_mul(ctx.cube.max(1));
    (p.win - p.win_g) * mwc_after(ctx, true, stake(SINGLE))
        + (p.win_g - p.win_bg) * mwc_after(ctx, true, stake(GAMMON))
        + p.win_bg * mwc_after(ctx, true, stake(BACKGAMMON))
        + (lose - p.lose_g) * mwc_after(ctx, false, stake(SINGLE))
        + (p.lose_g - p.lose_bg) * mwc_after(ctx, false, stake(GAMMON))
        + p.lose_bg * mwc_after(ctx, false, stake(BACKGAMMON))
}

/// Equity of `p` in the context `ctx`, on the money scale.
///
/// * Money game: [`Probs::cubeless_equity`].
/// * Match: the EMG normalisation described in the [module docs](self):
///   `2·(cubeless_mwc − mwc_lose) / (mwc_win − mwc_lose) − 1`, where
///   `mwc_win`/`mwc_lose` are [`mwc_after`] for a single game at the current
///   cube value. If that denominator is not positive (only possible for
///   degenerate, clamped contexts) the cubeless money equity is returned
///   instead so the result is always finite.
#[must_use]
pub fn equity_for(ctx: &MatchContext, p: &Probs) -> f64 {
    if ctx.is_money() {
        return p.cubeless_equity();
    }
    let stake = SINGLE.saturating_mul(ctx.cube.max(1));
    let mwc_win = mwc_after(ctx, true, stake);
    let mwc_lose = mwc_after(ctx, false, stake);
    let span = mwc_win - mwc_lose;
    if span <= f64::EPSILON {
        return p.cubeless_equity();
    }
    2.0 * (cubeless_mwc(ctx, p) - mwc_lose) / span - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_clamps_into_table_range() {
        assert_eq!(index(0), 0);
        assert_eq!(index(1), 0);
        assert_eq!(index(25), 24);
        assert_eq!(index(255), 24);
    }

    #[test]
    fn cubeless_mwc_sums_to_mwc_of_certain_outcome() {
        let ctx = MatchContext {
            length: 5,
            my_away: 5,
            their_away: 5,
            crawford: false,
            post_crawford: false,
            cube: 1,
            cube_owner_is_me: None,
        };
        let certain_loss = Probs::default();
        assert!((cubeless_mwc(&ctx, &certain_loss) - met(5, 4)).abs() < 1e-12);
    }

    #[test]
    fn equity_for_degenerate_context_falls_back_to_money_equity() {
        // Both sides beyond the table's 25-away limit: after clamping, a
        // single win and a single loss both map to met(25, 25) == 0.5, so
        // the EMG span is zero and the money equity is returned instead.
        let ctx = MatchContext {
            length: 40,
            my_away: 30,
            their_away: 30,
            crawford: false,
            post_crawford: false,
            cube: 1,
            cube_owner_is_me: None,
        };
        let p = Probs {
            win: 0.7,
            win_g: 0.2,
            ..Probs::default()
        };
        assert!((equity_for(&ctx, &p) - p.cubeless_equity()).abs() < 1e-12);
    }

    #[test]
    fn equity_for_when_every_outcome_ends_the_match_is_two_win_minus_one() {
        // Cube so large that every outcome ends the match: mwc_win == 1,
        // mwc_lose == 0, span == 1, gammons cannot add anything.
        let ctx = MatchContext {
            length: 3,
            my_away: 3,
            their_away: 3,
            crawford: false,
            post_crawford: false,
            cube: 4,
            cube_owner_is_me: Some(true),
        };
        let p = Probs {
            win: 0.7,
            ..Probs::default()
        };
        assert!((equity_for(&ctx, &p) - (2.0 * 0.7 - 1.0)).abs() < 1e-12);
    }
}
