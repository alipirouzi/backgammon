//! Dice and the seeded dice generator.

use rand_chacha::ChaCha8Rng;
use rand_core::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

use crate::RulesError;

/// A roll of two dice, ordered so that `hi >= lo`; both in `1..=6`.
///
/// There are 21 distinct rolls; a double has probability 1/36, every other
/// roll 2/36 (see [`Dice::weight`]).
///
/// JSON shape: `{ "hi": 6, "lo": 3 }`. Deserialisation goes through
/// [`Dice::new`], so out-of-range dice are rejected and `hi`/`lo` are put in
/// order if they arrive swapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "RawDice")]
pub struct Dice {
    /// The larger die.
    pub hi: u8,
    /// The smaller die (equal to `hi` for doubles).
    pub lo: u8,
}

/// Unchecked wire form of [`Dice`].
#[derive(Deserialize)]
struct RawDice {
    hi: u8,
    lo: u8,
}

impl TryFrom<RawDice> for Dice {
    type Error = RulesError;

    fn try_from(raw: RawDice) -> Result<Self, Self::Error> {
        Self::new(raw.hi, raw.lo)
    }
}

impl Dice {
    /// Builds a roll from two dice in any order.
    ///
    /// # Errors
    ///
    /// Returns [`RulesError::InvalidDie`] with the first die outside `1..=6`.
    pub fn new(a: u8, b: u8) -> Result<Self, RulesError> {
        for die in [a, b] {
            if !(1..=6).contains(&die) {
                return Err(RulesError::InvalidDie(die));
            }
        }
        Ok(Self {
            hi: a.max(b),
            lo: a.min(b),
        })
    }

    /// `true` when both dice show the same number.
    #[must_use]
    pub const fn is_double(&self) -> bool {
        self.hi == self.lo
    }

    /// All 21 distinct rolls, ordered by `hi` then `lo` ascending.
    #[must_use]
    pub const fn all() -> [Self; 21] {
        let mut rolls = [Self { hi: 1, lo: 1 }; 21];
        let mut k = 0;
        let mut hi = 1;
        while hi <= 6 {
            let mut lo = 1;
            while lo <= hi {
                rolls[k] = Self { hi, lo };
                k += 1;
                lo += 1;
            }
            hi += 1;
        }
        rolls
    }

    /// Number of the 36 equally likely dice outcomes that produce this roll:
    /// 1 for a double, 2 otherwise.
    #[must_use]
    pub const fn weight(&self) -> u8 {
        if self.is_double() { 1 } else { 2 }
    }
}

/// A seeded, reproducible dice generator (`ChaCha8`, no OS randomness).
///
/// Two generators built from the same seed produce the same sequence on
/// every target. Dice are drawn with rejection sampling on 32-bit words so
/// the distribution is exactly uniform.
#[derive(Debug, Clone)]
pub struct DiceRng(ChaCha8Rng);

impl DiceRng {
    /// A generator whose whole future is determined by `seed`.
    #[must_use]
    pub fn from_seed(seed: u64) -> Self {
        Self(ChaCha8Rng::seed_from_u64(seed))
    }

    /// Rolls two dice.
    pub fn roll(&mut self) -> Dice {
        let a = self.roll_one();
        let b = self.roll_one();
        Dice {
            hi: a.max(b),
            lo: a.min(b),
        }
    }

    /// Rolls one die, uniformly in `1..=6`.
    pub fn roll_one(&mut self) -> u8 {
        // Largest multiple of 6 that fits in a u32; words at or above it are
        // rejected so every face has exactly the same number of words.
        const ZONE: u32 = u32::MAX - (u32::MAX % 6);
        loop {
            let word = self.0.next_u32();
            if word < ZONE {
                // `word % 6` is in 0..6, so the narrowing is exact.
                #[allow(clippy::cast_possible_truncation)]
                return (word % 6) as u8 + 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_orders_the_dice_and_validates_range() {
        assert_eq!(Dice::new(3, 6), Ok(Dice { hi: 6, lo: 3 }));
        assert_eq!(Dice::new(6, 3), Ok(Dice { hi: 6, lo: 3 }));
        assert_eq!(Dice::new(4, 4), Ok(Dice { hi: 4, lo: 4 }));
        assert_eq!(Dice::new(0, 3), Err(RulesError::InvalidDie(0)));
        assert_eq!(Dice::new(2, 7), Err(RulesError::InvalidDie(7)));
        assert_eq!(Dice::new(9, 8), Err(RulesError::InvalidDie(9)));
    }

    #[test]
    fn doubles_and_weights() {
        assert!(Dice::new(5, 5).unwrap().is_double());
        assert!(!Dice::new(5, 2).unwrap().is_double());
        assert_eq!(Dice::new(5, 5).unwrap().weight(), 1);
        assert_eq!(Dice::new(5, 2).unwrap().weight(), 2);
    }

    #[test]
    fn all_has_21_distinct_rolls_weighing_36() {
        let all = Dice::all();
        assert_eq!(all.len(), 21);
        let mut seen = std::collections::HashSet::new();
        for d in all {
            assert!(d.hi >= d.lo && (1..=6).contains(&d.lo) && (1..=6).contains(&d.hi));
            assert!(seen.insert(d));
        }
        assert_eq!(all.iter().map(|d| u32::from(d.weight())).sum::<u32>(), 36);
        assert_eq!(all[0], Dice { hi: 1, lo: 1 });
        assert_eq!(all[20], Dice { hi: 6, lo: 6 });
    }

    #[test]
    fn json_round_trip_and_validation() {
        let d = Dice::new(6, 3).unwrap();
        assert_eq!(serde_json::to_string(&d).unwrap(), r#"{"hi":6,"lo":3}"#);
        assert_eq!(
            serde_json::from_str::<Dice>(r#"{"hi":6,"lo":3}"#).unwrap(),
            d
        );
        assert_eq!(
            serde_json::from_str::<Dice>(r#"{"hi":3,"lo":6}"#).unwrap(),
            d
        );
        assert!(serde_json::from_str::<Dice>(r#"{"hi":7,"lo":1}"#).is_err());
        assert!(serde_json::from_str::<Dice>(r#"{"hi":6}"#).is_err());
    }

    #[test]
    fn same_seed_same_sequence() {
        let mut a = DiceRng::from_seed(7);
        let mut b = DiceRng::from_seed(7);
        for _ in 0..200 {
            assert_eq!(a.roll(), b.roll());
        }
        let mut c = DiceRng::from_seed(8);
        let differs = (0..50).any(|_| a.roll() != c.roll());
        assert!(differs);
    }

    #[test]
    fn roll_one_stays_in_range_and_covers_every_face() {
        let mut rng = DiceRng::from_seed(1);
        let mut counts = [0u32; 7];
        for _ in 0..6000 {
            let d = rng.roll_one();
            assert!((1..=6).contains(&d));
            counts[usize::from(d)] += 1;
        }
        assert!(counts[1..].iter().all(|&c| c > 800), "{counts:?}");
    }

    #[test]
    fn roll_orders_hi_before_lo() {
        let mut rng = DiceRng::from_seed(3);
        for _ in 0..500 {
            let d = rng.roll();
            assert!(d.hi >= d.lo);
            assert_eq!(Dice::new(d.hi, d.lo), Ok(d));
        }
    }

    /// Frozen once from `DiceRng::from_seed(42)`; any change to the sampling
    /// method or the RNG breaks replay of stored records, so this must not
    /// change without a data migration.
    const FIRST_100_ROLLS_SEED_42: [(u8, u8); 100] = [
        (4, 4),
        (5, 1),
        (3, 3),
        (5, 4),
        (3, 1),
        (4, 3),
        (4, 3),
        (6, 5),
        (5, 1),
        (5, 4),
        (4, 3),
        (4, 2),
        (6, 2),
        (4, 3),
        (3, 3),
        (4, 3),
        (5, 4),
        (4, 1),
        (5, 4),
        (5, 2),
        (4, 1),
        (4, 1),
        (4, 3),
        (6, 3),
        (5, 3),
        (4, 1),
        (6, 1),
        (6, 1),
        (4, 2),
        (2, 2),
        (6, 3),
        (3, 2),
        (5, 2),
        (5, 1),
        (5, 2),
        (4, 1),
        (5, 3),
        (6, 2),
        (6, 5),
        (5, 2),
        (5, 5),
        (5, 4),
        (4, 1),
        (4, 2),
        (6, 5),
        (5, 4),
        (4, 1),
        (3, 2),
        (6, 3),
        (5, 3),
        (5, 5),
        (5, 1),
        (6, 5),
        (3, 1),
        (6, 6),
        (6, 3),
        (4, 4),
        (6, 2),
        (2, 1),
        (5, 4),
        (4, 2),
        (3, 2),
        (4, 2),
        (5, 1),
        (3, 3),
        (6, 1),
        (6, 6),
        (6, 4),
        (4, 4),
        (6, 3),
        (4, 1),
        (6, 1),
        (4, 1),
        (4, 4),
        (4, 2),
        (4, 4),
        (3, 1),
        (5, 5),
        (2, 1),
        (6, 3),
        (2, 1),
        (6, 2),
        (4, 3),
        (6, 1),
        (5, 2),
        (5, 1),
        (6, 1),
        (6, 2),
        (4, 1),
        (1, 1),
        (6, 1),
        (6, 3),
        (6, 1),
        (6, 1),
        (4, 1),
        (2, 1),
        (3, 1),
        (6, 4),
        (3, 3),
        (1, 1),
    ];

    #[test]
    fn seed_42_first_100_rolls_are_frozen() {
        let mut rng = DiceRng::from_seed(42);
        let actual: Vec<(u8, u8)> = (0..100).map(|_| rng.roll()).map(|d| (d.hi, d.lo)).collect();
        assert_eq!(
            actual,
            FIRST_100_ROLLS_SEED_42.to_vec(),
            "actual = {actual:?}"
        );
    }
}
