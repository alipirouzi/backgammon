//! Backgammon rules engine. Foundation stub: the types below are the seed of
//! the position model and exist so the Rust toolchain, lints and tests are
//! exercised in CI from the first commit.

/// The two sides. `White` moves from point 24 toward point 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Player {
    White,
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

/// A board point numbered 1..=24 from White's perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Point(u8);

impl Point {
    /// Returns `None` for anything outside 1..=24.
    #[must_use]
    pub const fn new(n: u8) -> Option<Self> {
        if n >= 1 && n <= 24 {
            Some(Self(n))
        } else {
            None
        }
    }

    /// The 1-based point number.
    #[must_use]
    pub const fn number(self) -> u8 {
        self.0
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
    fn point_rejects_out_of_range() {
        assert!(Point::new(0).is_none());
        assert!(Point::new(25).is_none());
        assert_eq!(Point::new(1).map(Point::number), Some(1));
        assert_eq!(Point::new(24).map(Point::number), Some(24));
    }
}
