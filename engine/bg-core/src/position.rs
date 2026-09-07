//! The relative position: the coordinate system of the rules and the bot.
//!
//! # Coordinates (binding for Tasks 2–10)
//!
//! Everything is expressed on the axis of the player on roll ("me"):
//!
//! ```text
//!  index:   0      1  2  3  4  5  6   7 … 18   19 20 21 22 23 24     25
//!  mine:    my off │ my home board  │ outfield │ their home board │ my bar
//!           ◀── I move this way (24 → 1 → off)
//!
//!  theirs:  their  │ their checkers standing on MY point i, i = 1..=24  │ their
//!           off    │ (their own point number for my point i is 25 − i)  │ bar
//!           ───────────────── they move this way (my 1 → my 24 → off) ──▶
//! ```
//!
//! * `mine[0]` = checkers I have borne off, `mine[1..=24]` = my checkers on my
//!   point `i` (1 = my ace point), `mine[25]` = my checkers on the bar.
//! * `theirs[i]` for `i` in `1..=24` = the opponent's checkers standing on
//!   **my** point `i`. That is the same physical point, so a move to `to`
//!   is blocked when `theirs[to] >= 2` and hits when `theirs[to] == 1`.
//! * `theirs[0]` = the opponent's borne-off checkers and `theirs[25]` = the
//!   opponent's bar: the **same index convention as `mine`**, deliberately, so
//!   both arrays read "0 = off, 25 = bar". Physically the opponent's bar
//!   checkers enter on my points 1–6 (they sit "below" my point 1) and they
//!   bear off past my point 24; [`Position::is_race`] and
//!   [`Position::pips`] account for that.
//!
//! Relationship to the absolute [`Board`] (index 0 = bar, 25 = off):
//!
//! * White on roll: `mine[i] = white[i]`, `theirs[i] = black[i]` for
//!   `i` in `1..=24`; the bar/off slots swap (`mine[0] = white[25]`,
//!   `mine[25] = white[0]`, likewise for `theirs`/`black`).
//! * Black on roll: `mine[i] = black[25 − i]` and `theirs[i] = white[25 − i]`
//!   for **every** `i` in `0..=25` (the point mirror also maps bar ↔ off).
//!
//! [`Position::flip`] mirrors the points (`i ↔ 25 − i` for `1..=24`), keeps
//! indices 0 and 25 in place and swaps the two arrays, so
//! `from_board(b, White).flip() == from_board(b, Black)`.

use serde::{Deserialize, Serialize};

use crate::Player;
use crate::board::{Board, SLOTS};

/// Index of the off slot in a relative array.
pub const OFF: usize = 0;
/// Index of the bar slot in a relative array.
pub const BAR: usize = 25;

/// Checker counts relative to the player on roll. See the module docs for
/// the exact coordinate convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// My checkers: `0` = off, `1..=24` = my points, `25` = my bar.
    pub mine: [u8; SLOTS],
    /// Opponent's checkers on my axis: `0` = their off, `i` = on my point `i`,
    /// `25` = their bar.
    pub theirs: [u8; SLOTS],
}

impl Position {
    /// The relative view of `b` for `on_roll`.
    #[must_use]
    pub fn from_board(b: &Board, on_roll: Player) -> Self {
        let (me, them) = match on_roll {
            Player::White => (&b.white, &b.black),
            Player::Black => (&b.black, &b.white),
        };
        let relative = Self {
            mine: swap_bar_off(me),
            theirs: swap_bar_off(them),
        };
        match on_roll {
            Player::White => relative,
            Player::Black => Self {
                mine: mirror(&relative.mine),
                theirs: mirror(&relative.theirs),
            },
        }
    }

    /// The absolute board, given that `on_roll` is "me".
    #[must_use]
    pub fn to_board(&self, on_roll: Player) -> Board {
        let (mine, theirs) = match on_roll {
            Player::White => (self.mine, self.theirs),
            Player::Black => (mirror(&self.mine), mirror(&self.theirs)),
        };
        let (me, them) = (swap_bar_off(&mine), swap_bar_off(&theirs));
        match on_roll {
            Player::White => Board {
                white: me,
                black: them,
            },
            Player::Black => Board {
                white: them,
                black: me,
            },
        }
    }

    /// The same position seen by the opponent (they are now on roll).
    #[must_use]
    pub fn flip(&self) -> Self {
        Self {
            mine: mirror(&self.theirs),
            theirs: mirror(&self.mine),
        }
    }

    /// `true` when there is no contact: every one of my checkers is past
    /// every one of theirs (bar checkers count as the farthest back).
    #[must_use]
    pub fn is_race(&self) -> bool {
        // My farthest-back checker, as a physical location on my axis
        // (bar = 25, past every point).
        let my_back = (1..=BAR).rev().find(|&i| self.mine[i] > 0);
        // Their farthest-back checker, likewise: their bar sits below my
        // point 1 (location 0), otherwise the lowest occupied point.
        let their_back = if self.theirs[BAR] > 0 {
            Some(0)
        } else {
            (1..=24).find(|&i| self.theirs[i] > 0)
        };
        match (my_back, their_back) {
            (Some(mine), Some(theirs)) => mine < theirs,
            _ => true,
        }
    }

    /// `true` when all my checkers are in my home board or off
    /// (`mine[7..=25]` all zero).
    #[must_use]
    pub fn all_home(&self) -> bool {
        self.mine[7..=BAR].iter().all(|&n| n == 0)
    }

    /// Pip counts `(mine, theirs)`; a checker on the bar counts 25.
    #[must_use]
    pub fn pips(&self) -> (u32, u32) {
        /// Pip distance credited to a checker on either bar.
        const BAR_PIPS: u32 = 25;
        let points = |side: &[u8; SLOTS], distance: fn(u8) -> u8| -> u32 {
            (1..=24u8)
                .map(|i| u32::from(side[usize::from(i)]) * u32::from(distance(i)))
                .sum()
        };
        let mine = points(&self.mine, |i| i) + u32::from(self.mine[BAR]) * BAR_PIPS;
        let theirs = points(&self.theirs, |i| 25 - i) + u32::from(self.theirs[BAR]) * BAR_PIPS;
        (mine, theirs)
    }
}

/// Exchanges slots 0 and 25 (the [`Board`] convention is bar = 0, off = 25;
/// the [`Position`] convention is off = 0, bar = 25).
fn swap_bar_off(a: &[u8; SLOTS]) -> [u8; SLOTS] {
    core::array::from_fn(|i| match i {
        0 => a[SLOTS - 1],
        i if i == SLOTS - 1 => a[0],
        i => a[i],
    })
}

/// Mirrors the points (`i ↔ 25 − i` for `1..=24`) and leaves the off (0) and
/// bar (25) slots where they are.
fn mirror(a: &[u8; SLOTS]) -> [u8; SLOTS] {
    core::array::from_fn(|i| match i {
        0 => a[0],
        i if i == SLOTS - 1 => a[SLOTS - 1],
        i => a[SLOTS - 1 - i],
    })
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn swap_and_mirror_are_involutions() {
        let a: [u8; SLOTS] = core::array::from_fn(|i| u8::try_from(i).unwrap_or(0));
        assert_eq!(swap_bar_off(&swap_bar_off(&a)), a);
        assert_eq!(mirror(&mirror(&a)), a);
        assert_eq!(swap_bar_off(&a)[0], 25);
        assert_eq!(swap_bar_off(&a)[25], 0);
        assert_eq!(mirror(&a)[1], 24);
        assert_eq!(mirror(&a)[24], 1);
        assert_eq!(mirror(&a)[0], 0);
        assert_eq!(mirror(&a)[25], 25);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn opening_white() -> Position {
        Position::from_board(&Board::opening(), Player::White)
    }

    /// A valid board: 15 checkers per side, no point shared.
    fn arb_board() -> impl Strategy<Value = Board> {
        prop::collection::vec(0usize..SLOTS, 15).prop_flat_map(|white_slots| {
            let mut white = [0u8; SLOTS];
            for &s in &white_slots {
                white[s] += 1;
            }
            let allowed: Vec<usize> = (0..SLOTS)
                .filter(|&i| i == 0 || i == 25 || white[i] == 0)
                .collect();
            let n = allowed.len();
            prop::collection::vec(0usize..n, 15).prop_map(move |picks| {
                let mut black = [0u8; SLOTS];
                for &k in &picks {
                    black[allowed[k]] += 1;
                }
                Board { white, black }
            })
        })
    }

    #[test]
    fn white_on_roll_keeps_points_and_swaps_bar_and_off() {
        let mut b = Board::opening();
        b.white[24] = 1;
        b.white[0] = 1;
        b.black[1] = 1;
        b.black[25] = 1;
        let p = Position::from_board(&b, Player::White);
        for i in 1..=24 {
            assert_eq!(p.mine[i], b.white[i], "mine[{i}]");
            assert_eq!(p.theirs[i], b.black[i], "theirs[{i}]");
        }
        assert_eq!(p.mine[OFF], b.white[25]);
        assert_eq!(p.mine[BAR], b.white[0]);
        assert_eq!(p.theirs[OFF], b.black[25]);
        assert_eq!(p.theirs[BAR], b.black[0]);
        assert_eq!(p.mine[BAR], 1);
        assert_eq!(p.theirs[OFF], 1);
    }

    #[test]
    fn black_on_roll_mirrors_everything() {
        let mut b = Board::opening();
        b.white[24] = 1;
        b.white[0] = 1;
        b.black[1] = 1;
        b.black[25] = 1;
        let p = Position::from_board(&b, Player::Black);
        for i in 0..SLOTS {
            assert_eq!(p.mine[i], b.black[25 - i], "mine[{i}]");
            assert_eq!(p.theirs[i], b.white[25 - i], "theirs[{i}]");
        }
        assert_eq!(p.mine[OFF], 1);
        assert_eq!(p.theirs[BAR], 1);
        // Black's back checkers sit on Black's 24-point.
        assert_eq!(p.mine[24], 1);
    }

    #[test]
    fn opening_is_symmetric() {
        let b = Board::opening();
        assert_eq!(
            Position::from_board(&b, Player::White),
            Position::from_board(&b, Player::Black)
        );
    }

    #[test]
    fn flip_is_an_involution_and_switches_the_side_on_roll() {
        let mut b = Board::opening();
        b.white[24] = 1;
        b.white[0] = 1;
        let w = Position::from_board(&b, Player::White);
        let k = Position::from_board(&b, Player::Black);
        assert_eq!(w.flip(), k);
        assert_eq!(k.flip(), w);
        assert_eq!(w.flip().flip(), w);
    }

    #[test]
    fn opening_pips_are_167_each() {
        assert_eq!(opening_white().pips(), (167, 167));
    }

    #[test]
    fn their_bar_counts_25_pips_and_their_points_are_mirrored() {
        let p = Position {
            mine: [0; SLOTS],
            theirs: {
                let mut t = [0u8; SLOTS];
                t[BAR] = 1;
                t[1] = 1; // their 24-point
                t[24] = 1; // their ace point
                t
            },
        };
        assert_eq!(p.pips(), (0, 25 + 24 + 1));
        let q = Position {
            mine: {
                let mut m = [0u8; SLOTS];
                m[BAR] = 2;
                m[6] = 1;
                m
            },
            theirs: [0; SLOTS],
        };
        assert_eq!(q.pips(), (56, 0));
    }

    #[test]
    fn opening_is_not_a_race() {
        assert!(!opening_white().is_race());
    }

    #[test]
    fn separated_checkers_are_a_race() {
        let mut mine = [0u8; SLOTS];
        mine[6] = 5;
        mine[5] = 5;
        mine[4] = 5;
        let mut theirs = [0u8; SLOTS];
        theirs[19] = 5;
        theirs[20] = 5;
        theirs[21] = 5;
        assert!(Position { mine, theirs }.is_race());
        // Adjacent but not overlapping is still a race.
        let mut mine = [0u8; SLOTS];
        mine[12] = 15;
        let mut theirs = [0u8; SLOTS];
        theirs[13] = 15;
        assert!(Position { mine, theirs }.is_race());
        // Interleaved: contact.
        theirs[11] = 1;
        theirs[13] = 14;
        assert!(!Position { mine, theirs }.is_race());
    }

    #[test]
    fn their_bar_is_behind_my_ace_point() {
        let mut mine = [0u8; SLOTS];
        mine[24] = 1;
        mine[OFF] = 14;
        let mut theirs = [0u8; SLOTS];
        theirs[BAR] = 1;
        theirs[OFF] = 14;
        assert!(!Position { mine, theirs }.is_race());
        // My bar checker is behind all of theirs as well.
        let mut mine = [0u8; SLOTS];
        mine[BAR] = 1;
        mine[OFF] = 14;
        let mut theirs = [0u8; SLOTS];
        theirs[24] = 1;
        theirs[OFF] = 14;
        assert!(!Position { mine, theirs }.is_race());
    }

    #[test]
    fn race_is_vacuous_without_checkers_on_the_board() {
        let mut mine = [0u8; SLOTS];
        mine[OFF] = 15;
        let mut theirs = [0u8; SLOTS];
        theirs[3] = 15;
        assert!(Position { mine, theirs }.is_race());
        let mut mine = [0u8; SLOTS];
        mine[3] = 15;
        let mut theirs = [0u8; SLOTS];
        theirs[OFF] = 15;
        assert!(Position { mine, theirs }.is_race());
    }

    #[test]
    fn all_home_looks_at_points_7_to_25() {
        assert!(!opening_white().all_home());
        let mut mine = [0u8; SLOTS];
        mine[1] = 5;
        mine[6] = 5;
        mine[OFF] = 5;
        let theirs = [0u8; SLOTS];
        assert!(Position { mine, theirs }.all_home());
        mine[7] = 1;
        assert!(!Position { mine, theirs }.all_home());
        mine[7] = 0;
        mine[BAR] = 1;
        assert!(!Position { mine, theirs }.all_home());
    }

    proptest! {
        #[test]
        fn round_trips_for_both_players(b in arb_board()) {
            prop_assert_eq!(b.validate(), Ok(()));
            for p in [Player::White, Player::Black] {
                prop_assert_eq!(Position::from_board(&b, p).to_board(p), b);
            }
        }

        #[test]
        fn flip_matches_the_other_side(b in arb_board()) {
            let w = Position::from_board(&b, Player::White);
            let k = Position::from_board(&b, Player::Black);
            prop_assert_eq!(w.flip(), k);
            prop_assert_eq!(w.flip().flip(), w);
            let (wm, wt) = w.pips();
            prop_assert_eq!(k.pips(), (wt, wm));
            prop_assert_eq!(w.is_race(), k.is_race());
        }

        #[test]
        fn pips_agree_with_the_board(b in arb_board()) {
            let w = Position::from_board(&b, Player::White);
            prop_assert_eq!(
                w.pips(),
                (b.pip_count(Player::White), b.pip_count(Player::Black))
            );
        }
    }
}
