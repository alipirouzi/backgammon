//! Race (non-contact) evaluation.
//!
//! * [`keith_count`]: Tom Keith's adjusted pip count, from "Cube Handling in
//!   Noncontact Positions", <https://bkgm.com/articles/CubeHandlingInRaces/>.
//! * [`race_win_probability`]: a logistic curve on the un-bumped Keith lead
//!   with an explicit on-roll credit, calibrated so that Keith's published
//!   cube thresholds come out at the usual win probabilities (see the
//!   function docs). [`keith_lead`] exposes Keith's bumped difference for
//!   the cube decision itself.
//! * [`race_gammon_probabilities`]: a simple bear-off heuristic for the
//!   chance that a race ends in a gammon.
//!
//! Nothing here depends on the evaluator trait; the heuristic evaluator
//! consumes these numbers when it classifies a position as a race.

use bg_core::Position;
use bg_core::board::SLOTS;
use bg_core::position::{BAR, OFF};

/// Checkers per side.
const CHECKERS: u32 = 15;

/// Average pips moved per roll (doubles counted twice): 49/6.
const AVG_PIPS_PER_ROLL: f64 = 49.0 / 6.0;

/// Average checkers borne off per roll once wastage is accounted for.
const AVG_CHECKERS_OFF_PER_ROLL: f64 = 2.0;

/// Number of points in a home board.
const HOME_POINTS: usize = 6;

/// Keith: a player may double when his (bumped) count exceeds the
/// opponent's by no more than 4. At that borderline the roller wins about
/// 70%.
pub const DOUBLE_POINT_LEAD: i64 = 4;
/// Keith: a player who owns the cube may redouble when his (bumped) count
/// exceeds the opponent's by no more than 3.
pub const REDOUBLE_POINT_LEAD: i64 = 3;
/// Keith: the opponent may take when the doubler's (bumped) count exceeds
/// his by at least 2. At that borderline the taker has about 25%.
pub const TAKE_POINT_LEAD: i64 = 2;
/// Win probability of the roller at Keith's marginal double.
const DOUBLE_POINT_WIN: f64 = 0.70;
/// Race length (the roller's un-bumped Keith count) the win curve is
/// calibrated at: Keith's bump there is `⌊75 / 7⌋ = 10`, so his marginal
/// double (`D = 4`) is an un-bumped lead of [`REFERENCE_DOUBLE_LEAD`].
const REFERENCE_COUNT: f64 = 75.0;
/// Un-bumped lead of the marginal double at [`REFERENCE_COUNT`].
const REFERENCE_DOUBLE_LEAD: f64 = 6.0;
/// Turn-order credit in pips for the side on roll: half a roll.
pub const ON_ROLL_PIPS: f64 = AVG_PIPS_PER_ROLL / 2.0;

/// Steepness of the gammon logistic per roll of margin.
const GAMMON_SLOPE: f64 = 2.5;
/// Turn-order credit, in rolls, for the side on roll.
const ON_ROLL_ROLLS: f64 = 0.5;

/// Keith count `(mine, theirs)` where `mine` is the player on roll.
///
/// For each side: pip count, plus 2 for each checker beyond 1 on the ace
/// point, plus 1 for each checker beyond 1 on the 2-point, plus 1 for each
/// checker beyond 3 on the 3-point, plus 1 for each empty point among the
/// 4-, 5- and 6-points. The player on roll then adds one seventh of his
/// count, rounded down. Points are each side's own points: the opponent's
/// point `q` is my point `25 - q`.
#[must_use]
pub fn keith_count(pos: &Position) -> (u32, u32) {
    let (mine, theirs) = adjusted_counts(pos);
    (mine + mine / 7, theirs)
}

/// Keith's wastage-adjusted counts `(mine, theirs)` **without** the roller's
/// one-seventh bump.
fn adjusted_counts(pos: &Position) -> (u32, u32) {
    let (my_pips, their_pips) = pos.pips();
    (
        my_pips + wastage(&pos.mine, |own| own),
        their_pips + wastage(&pos.theirs, their_index),
    )
}

/// Keith's bumped lead `D = mine − theirs` from [`keith_count`], as a signed
/// number: Keith doubles iff `D ≤ 4` (redoubles iff `D ≤ 3`) and the
/// opponent takes iff `D ≥ 2`.
#[must_use]
pub fn keith_lead(pos: &Position) -> i64 {
    let (mine, theirs) = keith_count(pos);
    i64::from(mine) - i64::from(theirs)
}

/// Keith's wastage adjustment for one side; `index_of` maps that side's own
/// point number (1 = ace) to its index in the relative array.
fn wastage(side: &[u8; SLOTS], index_of: impl Fn(usize) -> usize) -> u32 {
    let at = |own: usize| u32::from(side[index_of(own)]);
    let beyond = |own: usize, keep: u32| at(own).saturating_sub(keep);
    let empty_high_points: u32 = (4..=HOME_POINTS).map(|own| u32::from(at(own) == 0)).sum();
    2 * beyond(1, 1) + beyond(2, 1) + beyond(3, 3) + empty_high_points
}

/// Probability that the player on roll wins a pure race.
///
/// A logistic on the **un-bumped** Keith lead `L = theirs − mine` (wastage
/// adjustments included, no one-seventh bump) plus an explicit turn-order
/// credit of half a roll ([`ON_ROLL_PIPS`]):
///
/// ```text
/// logit p = slope(len) · (L + ON_ROLL_PIPS)
/// slope(len) = slope₇₅ · √(75 / len),   len = (mine + theirs) / 2
/// ```
///
/// `slope₇₅` is fixed by Keith's marginal double at a 75-pip race: his bump
/// is 10 there, so `D = 4` is an un-bumped lead of 6 and `p(6) = 0.70`;
/// his marginal take (`D = 2`, lead 8) then comes out at ≈ 0.73 (Keith:
/// 0.75). The slope shrinks with the square root of the race length, as a
/// pip is worth less in a longer race, which keeps Keith's window
/// approximately right from 30 to 120 pips.
///
/// Feeding the *bumped* count into a fixed two-point logistic (the previous
/// curve) made the roller's credit grow with race length while the
/// intercept stayed put, so both sides of an even 100-pip race came out
/// below 50%. Here an even race is always an edge for the roller (≈ 0.57
/// at 100 pips, ≈ 0.63 at 30) and `p(pos)` decreases monotonically as my
/// count grows. Finished races return exactly `1.0` or `0.0`.
#[must_use]
pub fn race_win_probability(pos: &Position) -> f64 {
    if u32::from(pos.mine[OFF]) >= CHECKERS {
        return 1.0;
    }
    if u32::from(pos.theirs[OFF]) >= CHECKERS {
        return 0.0;
    }
    let (mine, theirs) = adjusted_counts(pos);
    let lead = f64::from(theirs) - f64::from(mine);
    let length = f64::midpoint(f64::from(mine), f64::from(theirs)).max(1.0);
    let slope_reference = logit(DOUBLE_POINT_WIN) / (REFERENCE_DOUBLE_LEAD + ON_ROLL_PIPS);
    let slope = slope_reference * (REFERENCE_COUNT / length).sqrt();
    sigmoid(slope * (lead + ON_ROLL_PIPS))
}

/// Gammon chances `(my_gammon, their_gammon)` in a race, for the player on
/// roll.
///
/// A side can only be gammoned while it has borne off nothing. The winner
/// needs about `max(pips / 8.17, checkers / 2)` rolls to finish; the loser
/// needs `outside_pips / 8.17 + 1` rolls to get every checker home and one
/// off. The gammon probability is a logistic on the difference in rolls,
/// with half a roll credited to the side on roll. It is exactly `0` when the
/// loser has borne off a checker, or is already home while the winner
/// cannot finish this very roll (more than four checkers or more than 24
/// pips left, or not on roll).
#[must_use]
pub fn race_gammon_probabilities(pos: &Position) -> (f64, f64) {
    let me = Side::of(&pos.mine, |own| own);
    let them = Side::of(&pos.theirs, their_index);
    (
        gammon_chance(&me, &them, true),
        gammon_chance(&them, &me, false),
    )
}

/// Bear-off summary of one side.
struct Side {
    /// Pip count.
    pips: u32,
    /// Checkers still on the board (including the bar).
    on_board: u32,
    /// Checkers borne off.
    off: u32,
    /// Pips needed to bring every checker into the home board.
    outside_pips: u32,
}

impl Side {
    /// Summarises `side`; `index_of` maps its own point number (1 = ace, 25
    /// = bar) to its index in the relative array.
    fn of(side: &[u8; SLOTS], index_of: impl Fn(usize) -> usize) -> Self {
        let at = |own: usize| u32::from(side[index_of(own)]);
        let pips = (1..=24).map(|own| at(own) * to_u32(own)).sum::<u32>() + at(BAR) * to_u32(BAR);
        let on_board = (1..=BAR).map(at).sum();
        let outside_pips = (HOME_POINTS + 1..=BAR)
            .map(|own| at(own) * to_u32(own - HOME_POINTS))
            .sum();
        Self {
            pips,
            on_board,
            off: u32::from(side[OFF]),
            outside_pips,
        }
    }

    fn all_home(&self) -> bool {
        self.outside_pips == 0
    }

    /// Expected rolls to bear everything off.
    fn rolls_to_finish(&self) -> f64 {
        let by_pips = f64::from(self.pips) / AVG_PIPS_PER_ROLL;
        let by_checkers = f64::from(self.on_board) / AVG_CHECKERS_OFF_PER_ROLL;
        by_pips.max(by_checkers)
    }

    /// Expected rolls until the first checker comes off.
    fn rolls_to_first_off(&self) -> f64 {
        f64::from(self.outside_pips) / AVG_PIPS_PER_ROLL + 1.0
    }

    /// `true` when the side can bear off everything with a single roll.
    fn can_finish_in_one_roll(&self) -> bool {
        self.on_board <= 4 && self.pips <= 4 * to_u32(HOME_POINTS)
    }
}

/// Probability that `winner` bears off all checkers before `loser` bears
/// off any.
fn gammon_chance(winner: &Side, loser: &Side, winner_on_roll: bool) -> f64 {
    if loser.off >= 1 {
        return 0.0;
    }
    if winner.on_board == 0 {
        return 1.0;
    }
    if loser.all_home() && !(winner_on_roll && winner.can_finish_in_one_roll()) {
        return 0.0;
    }
    let turn_order = if winner_on_roll {
        ON_ROLL_ROLLS
    } else {
        -ON_ROLL_ROLLS
    };
    let margin = loser.rolls_to_first_off() - winner.rolls_to_finish() + turn_order;
    sigmoid(GAMMON_SLOPE * margin)
}

/// Index in `theirs` of the opponent's own point `own` (1 = their ace, 25 =
/// their bar): points are mirrored onto my axis, the bar stays at 25.
fn their_index(own: usize) -> usize {
    if own == BAR { BAR } else { 25 - own }
}

fn logit(p: f64) -> f64 {
    (p / (1.0 - p)).ln()
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Widens a small slot index; indices never exceed 25.
fn to_u32(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}
