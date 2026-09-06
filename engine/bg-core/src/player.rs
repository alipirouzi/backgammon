//! The two sides of the game.

use serde::{Deserialize, Serialize};

/// The two sides. `White` moves from point 24 toward point 1 and bears off
/// from points 1–6; `Black` moves 1 toward 24 and bears off from 19–24.
///
/// Serialises as the lowercase strings `"white"` and `"black"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Player {
    /// The side whose point numbering is the absolute numbering of the board.
    White,
    /// The side whose point numbering is mirrored (`25 - p`).
    Black,
}

impl Player {
    /// The opposing side.
    #[must_use]
    pub const fn opponent(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opponent_is_involutive() {
        assert_eq!(Player::White.opponent(), Player::Black);
        assert_eq!(Player::White.opponent().opponent(), Player::White);
    }

    #[test]
    fn serialises_as_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&Player::White).ok(),
            Some("\"white\"".to_owned())
        );
        assert_eq!(
            serde_json::to_string(&Player::Black).ok(),
            Some("\"black\"".to_owned())
        );
        assert_eq!(
            serde_json::from_str::<Player>("\"black\"").ok(),
            Some(Player::Black)
        );
        assert!(serde_json::from_str::<Player>("\"White\"").is_err());
    }
}
