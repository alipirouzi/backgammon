//! Contact and holding-game features extracted from a relative
//! [`Position`] (see `bg_core::position` for the coordinate system).
//!
//! Everything is counted from the point of view of the player on roll
//! ("me"). A *point* is made when it holds two or more checkers; a *blot* is
//! a single checker. Shots are counted only against my blots.

use bg_core::Position;
use bg_core::board::SLOTS;
use bg_core::position::{BAR, OFF};

use serde::{Deserialize, Serialize};

/// Longest distance a single die can cover.
const DIE_MAX: usize = 6;
/// Longest distance a non-double roll can cover in one move sequence.
const INDIRECT_MAX: usize = 12;
/// Moves available with a double.
const DOUBLE_MOVES: usize = 4;
/// My points that lie in the opponent's home board.
const THEIR_HOME: std::ops::RangeInclusive<usize> = 19..=24;
/// My home board.
const MY_HOME: std::ops::RangeInclusive<usize> = 1..=6;
/// Highest point of a home board on its owner's axis.
const HOME_TOP: usize = 6;

/// Hand-crafted position features for the heuristic evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// My pip count (bar checkers count 25).
    pub pips_mine: u32,
    /// The opponent's pip count.
    pub pips_theirs: u32,
    /// Number of my points holding exactly one checker.
    pub blots_mine: u8,
    /// Number of the opponent's points holding exactly one checker.
    pub blots_theirs: u8,
    /// Rolls (of 36) that hit one of my blots from an opposing checker 1–6
    /// pips away, ignoring blocks; distinct rolls per blot, summed over blots.
    pub direct_shots_on_me: u32,
    /// Rolls (of 36) that hit one of my blots from an opposing checker 7–12
    /// pips away, ignoring blocks; distinct rolls per blot, summed over blots.
    pub indirect_shots_on_me: u32,
    /// Direct shots weighted by the cost of the hit: `Σ direct_shots(b) ·
    /// (25 − b)` over my blots `b`, where `25 − b` is the pips a checker on
    /// my point `b` loses when it is sent to the bar. A back-checker blot
    /// (my 24-point) contributes one pip per shot, a blot slotted on my
    /// 5-point twenty.
    pub direct_shot_pips_on_me: u32,
    /// Indirect shots weighted by the cost of the hit, as for
    /// `direct_shot_pips_on_me`.
    pub indirect_shot_pips_on_me: u32,
    /// Number of my points holding two or more checkers.
    pub points_made_mine: u8,
    /// Number of the opponent's points holding two or more checkers.
    pub points_made_theirs: u8,
    /// Length of my longest run of consecutive made points.
    pub prime_len_mine: u8,
    /// Length of the opponent's longest run of consecutive made points.
    pub prime_len_theirs: u8,
    /// My made points inside the opponent's home board (my points 19–24).
    pub anchors_mine: u8,
    /// My made points inside my home board (points 1–6).
    pub home_board_points_mine: u8,
    /// The opponent's made points inside their home board (my points 19–24).
    pub home_board_points_theirs: u8,
    /// My checkers in the opponent's home board (bar excluded).
    pub checkers_back_mine: u8,
    /// The opponent's checkers in my home board (bar excluded).
    pub checkers_back_theirs: u8,
    /// My checkers on the bar.
    pub bar_mine: u8,
    /// The opponent's checkers on the bar.
    pub bar_theirs: u8,
    /// My checkers borne off.
    pub off_mine: u8,
    /// The opponent's checkers borne off.
    pub off_theirs: u8,
    /// Pips I need to bring every checker into my home board: `Σ n · (p − 6)`
    /// over my checkers on points `7..=24` and the bar (`25`). Zero when I am
    /// all home.
    pub outside_pips_mine: u32,
    /// Pips the opponent needs to bring every checker into their home board
    /// (their points `7..=25`, i.e. my points `1..=18` and their bar).
    pub outside_pips_theirs: u32,
}

/// Extracts [`Features`] from `pos` for the player on roll.
#[must_use]
pub fn extract(pos: &Position) -> Features {
    let (pips_mine, pips_theirs) = pos.pips();
    let shots = shots_on(&pos.mine, &pos.theirs);
    Features {
        pips_mine,
        pips_theirs,
        blots_mine: count_points(&pos.mine, 1..=24, |n| n == 1),
        blots_theirs: count_points(&pos.theirs, 1..=24, |n| n == 1),
        direct_shots_on_me: shots.direct,
        indirect_shots_on_me: shots.indirect,
        direct_shot_pips_on_me: shots.direct_pips,
        indirect_shot_pips_on_me: shots.indirect_pips,
        points_made_mine: count_points(&pos.mine, 1..=24, is_made),
        points_made_theirs: count_points(&pos.theirs, 1..=24, is_made),
        prime_len_mine: prime_len(&pos.mine),
        prime_len_theirs: prime_len(&pos.theirs),
        anchors_mine: count_points(&pos.mine, THEIR_HOME, is_made),
        home_board_points_mine: count_points(&pos.mine, MY_HOME, is_made),
        home_board_points_theirs: count_points(&pos.theirs, THEIR_HOME, is_made),
        checkers_back_mine: pos.mine[THEIR_HOME].iter().sum(),
        checkers_back_theirs: pos.theirs[MY_HOME].iter().sum(),
        bar_mine: pos.mine[BAR],
        bar_theirs: pos.theirs[BAR],
        off_mine: pos.mine[OFF],
        off_theirs: pos.theirs[OFF],
        outside_pips_mine: outside_pips(&pos.mine, |own| own),
        outside_pips_theirs: outside_pips(
            &pos.theirs,
            |own| if own == BAR { BAR } else { 25 - own },
        ),
    }
}

/// Pips one side needs to bring every checker home; `index_of` maps that
/// side's own point number (1 = ace, 25 = bar) to its index in the array.
fn outside_pips(side: &[u8; SLOTS], index_of: impl Fn(usize) -> usize) -> u32 {
    (HOME_TOP + 1..=BAR)
        .map(|own| u32::from(side[index_of(own)]) * to_u32(own - HOME_TOP))
        .sum()
}

/// Shot totals against my blots (see [`shots_on`]).
#[derive(Debug, Default, Clone, Copy)]
struct Shots {
    direct: u32,
    indirect: u32,
    direct_pips: u32,
    indirect_pips: u32,
}

fn is_made(n: u8) -> bool {
    n >= 2
}

/// Number of indices in `range` whose count satisfies `pred`.
fn count_points(
    side: &[u8; SLOTS],
    range: std::ops::RangeInclusive<usize>,
    pred: impl Fn(u8) -> bool,
) -> u8 {
    range.map(|i| u8::from(pred(side[i]))).sum()
}

/// Longest run of consecutive made points.
fn prime_len(side: &[u8; SLOTS]) -> u8 {
    let (best, _) = side[1..=24].iter().fold((0u8, 0u8), |(best, run), &n| {
        let run = if is_made(n) { run + 1 } else { 0 };
        (best.max(run), run)
    });
    best
}

/// Direct and indirect shots against my blots, plain and weighted by the
/// pips a hit costs (`25 − b` for a blot on my point `b`). The opponent
/// moves up my axis, so a checker of theirs on my point `i` (or on their
/// bar, location 0) is `b - i` pips away from my blot on point `b`.
fn shots_on(mine: &[u8; SLOTS], theirs: &[u8; SLOTS]) -> Shots {
    let attackers: Vec<usize> = (1..=24)
        .filter(|&i| theirs[i] > 0)
        .chain((theirs[BAR] > 0).then_some(0))
        .collect();
    (1..=24)
        .filter(|&b| mine[b] == 1)
        .fold(Shots::default(), |acc, b| {
            let distances: Vec<usize> = attackers
                .iter()
                .filter(|&&i| i < b)
                .map(|&i| b - i)
                .collect();
            let direct = rolls_hitting(&distances, 1..=DIE_MAX);
            let indirect = rolls_hitting(&distances, DIE_MAX + 1..=INDIRECT_MAX);
            let pips_lost = to_u32(BAR - b);
            Shots {
                direct: acc.direct + direct,
                indirect: acc.indirect + indirect,
                direct_pips: acc.direct_pips + direct * pips_lost,
                indirect_pips: acc.indirect_pips + indirect * pips_lost,
            }
        })
}

/// Number of rolls (of 36) that cover at least one of `distances` inside
/// `range`, ignoring blocks. Non-doubles count twice, doubles once.
fn rolls_hitting(distances: &[usize], range: std::ops::RangeInclusive<usize>) -> u32 {
    let mut total = 0;
    for hi in 1..=DIE_MAX {
        for lo in 1..=hi {
            let hits = distances
                .iter()
                .any(|&d| range.contains(&d) && roll_reaches(hi, lo, d));
            if hits {
                total += if hi == lo { 1 } else { 2 };
            }
        }
    }
    total
}

/// Widens a small slot index; indices never exceed 25.
fn to_u32(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}

/// `true` when a roll of `hi`/`lo` can move one checker exactly `d` pips:
/// either die, their sum, or one to four steps of a double.
fn roll_reaches(hi: usize, lo: usize, d: usize) -> bool {
    if hi == lo {
        d.is_multiple_of(hi) && d / hi <= DOUBLE_MOVES
    } else {
        d == hi || d == lo || d == hi + lo
    }
}
