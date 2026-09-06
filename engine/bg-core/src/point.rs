//! Absolute board points.

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
    fn point_rejects_out_of_range() {
        assert!(Point::new(0).is_none());
        assert!(Point::new(25).is_none());
        assert_eq!(Point::new(1).map(Point::number), Some(1));
        assert_eq!(Point::new(24).map(Point::number), Some(24));
    }
}
