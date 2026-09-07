//! The absolute board: what both players and the wire format see.

use serde::{Deserialize, Serialize};

use crate::{Player, RulesError};

/// Number of slots per side: index 0 = bar, 1..=24 = points, 25 = off.
pub const SLOTS: usize = 26;
/// Checkers each side owns.
pub const CHECKERS_PER_SIDE: u8 = 15;
/// Pip distance credited to a checker on the bar.
const BAR_PIPS: u32 = 25;

/// Checker counts for both sides in **absolute** numbering (White's).
///
/// For each side the array has 26 slots: index `0` is the bar, `1..=24` are
/// the board points, `25` is the number of checkers borne off. White moves
/// 24 → 1, Black moves 1 → 24.
///
/// JSON shape (camelCase, binding for all bindings):
///
/// ```json
/// { "white": [0, 0,0,0,0,0,5, 0,3,0,0,0,0, 5,0,0,0,0,0, 0,0,0,0,0,2, 0],
///   "black": [0, 2,0,0,0,0,0, 0,0,0,0,0,5, 0,0,0,0,3,0, 5,0,0,0,0,0, 0] }
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// White's checkers, absolute numbering, index 0 = bar, 25 = off.
    pub white: [u8; SLOTS],
    /// Black's checkers, absolute numbering, index 0 = bar, 25 = off.
    pub black: [u8; SLOTS],
}

impl Board {
    /// The standard opening position: White 2 on 24, 5 on 13, 3 on 8, 5 on 6;
    /// Black mirrored (2 on 1, 5 on 12, 3 on 17, 5 on 19).
    #[must_use]
    pub fn opening() -> Self {
        let mut white = [0u8; SLOTS];
        white[24] = 2;
        white[13] = 5;
        white[8] = 3;
        white[6] = 5;
        let black = core::array::from_fn(|i| {
            if i == 0 || i == SLOTS - 1 {
                0
            } else {
                white[SLOTS - 1 - i]
            }
        });
        Self { white, black }
    }

    /// The 26-slot checker array of `p`.
    #[must_use]
    pub const fn checkers(&self, p: Player) -> &[u8; SLOTS] {
        match p {
            Player::White => &self.white,
            Player::Black => &self.black,
        }
    }

    /// Pip count of `p`: White sums `n × point`, Black sums `n × (25 − point)`;
    /// a checker on the bar counts 25 pips.
    #[must_use]
    pub fn pip_count(&self, p: Player) -> u32 {
        let checkers = self.checkers(p);
        let bar = u32::from(checkers[0]) * BAR_PIPS;
        let points: u32 = (1..=24u8)
            .map(|point| {
                let distance = match p {
                    Player::White => point,
                    Player::Black => 25 - point,
                };
                u32::from(checkers[usize::from(point)]) * u32::from(distance)
            })
            .sum();
        bar + points
    }

    /// Checkers `p` has borne off.
    #[must_use]
    pub const fn borne_off(&self, p: Player) -> u8 {
        self.checkers(p)[SLOTS - 1]
    }

    /// Checks the structural invariants: 15 checkers per side, no point
    /// occupied by both sides, every count at most 15.
    ///
    /// # Errors
    ///
    /// Returns [`RulesError::InvalidBoard`] naming the violated invariant.
    pub fn validate(&self) -> Result<(), RulesError> {
        for side in [&self.white, &self.black] {
            if side.iter().any(|&n| n > CHECKERS_PER_SIDE) {
                return Err(RulesError::InvalidBoard(
                    "a slot holds more than 15 checkers",
                ));
            }
            if side.iter().map(|&n| u32::from(n)).sum::<u32>() != u32::from(CHECKERS_PER_SIDE) {
                return Err(RulesError::InvalidBoard(
                    "each side must have exactly 15 checkers",
                ));
            }
        }
        let shared = (1..=24).any(|i| self.white[i] > 0 && self.black[i] > 0);
        if shared {
            return Err(RulesError::InvalidBoard(
                "a point is occupied by both sides",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const OPENING_WHITE: [u8; 26] = [
        0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0,
    ];
    const OPENING_BLACK: [u8; 26] = [
        0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn opening_layout_matches_the_plan() {
        let b = Board::opening();
        assert_eq!(b.white, OPENING_WHITE);
        assert_eq!(b.black, OPENING_BLACK);
        assert_eq!(b.validate(), Ok(()));
    }

    #[test]
    fn opening_json_matches_the_binding_shape() {
        let value = serde_json::to_value(Board::opening()).unwrap();
        let expected = json!({
            "white": [0, 0,0,0,0,0,5, 0,3,0,0,0,0, 5,0,0,0,0,0, 0,0,0,0,0,2, 0],
            "black": [0, 2,0,0,0,0,0, 0,0,0,0,0,5, 0,0,0,0,3,0, 5,0,0,0,0,0, 0]
        });
        assert_eq!(value, expected);
        let back: Board = serde_json::from_value(expected).unwrap();
        assert_eq!(back, Board::opening());
    }

    #[test]
    fn opening_pip_count_is_167_for_both() {
        let b = Board::opening();
        assert_eq!(b.pip_count(Player::White), 167);
        assert_eq!(b.pip_count(Player::Black), 167);
    }

    #[test]
    fn bar_checkers_count_25_pips() {
        let mut b = Board::opening();
        b.white[24] = 1;
        b.white[0] = 1;
        assert_eq!(b.pip_count(Player::White), 167 - 24 + 25);
        b.black[1] = 1;
        b.black[0] = 1;
        assert_eq!(b.pip_count(Player::Black), 167 - 24 + 25);
    }

    #[test]
    fn checkers_and_borne_off_select_the_right_side() {
        let mut b = Board::opening();
        b.white[6] = 3;
        b.white[25] = 2;
        b.black[19] = 4;
        b.black[25] = 1;
        assert_eq!(b.checkers(Player::White), &b.white);
        assert_eq!(b.checkers(Player::Black), &b.black);
        assert_eq!(b.borne_off(Player::White), 2);
        assert_eq!(b.borne_off(Player::Black), 1);
    }

    #[test]
    fn validate_rejects_wrong_totals() {
        let mut b = Board::opening();
        b.white[6] = 4;
        assert!(matches!(b.validate(), Err(RulesError::InvalidBoard(_))));
        let mut b = Board::opening();
        b.black[19] = 6;
        assert!(matches!(b.validate(), Err(RulesError::InvalidBoard(_))));
    }

    #[test]
    fn validate_rejects_shared_points() {
        let mut b = Board::opening();
        // Move one White checker from 24 onto Black's 19-point stack.
        b.white[24] = 1;
        b.white[19] = 1;
        assert!(matches!(b.validate(), Err(RulesError::InvalidBoard(_))));
    }

    #[test]
    fn validate_rejects_counts_above_fifteen() {
        let mut b = Board::opening();
        b.white = [0; 26];
        b.white[25] = 16;
        b.white[0] = 0;
        // total is 16 as well, but a slot > 15 must be reported regardless
        assert!(matches!(b.validate(), Err(RulesError::InvalidBoard(_))));
    }

    #[test]
    fn validate_allows_bar_and_off_sharing() {
        let mut b = Board::opening();
        b.white[24] = 0;
        b.white[0] = 1;
        b.white[25] = 1;
        b.black[1] = 0;
        b.black[0] = 1;
        b.black[25] = 1;
        assert_eq!(b.validate(), Ok(()));
    }
}
