//! Outcome probabilities and the [`Evaluator`] trait every bot component
//! depends on.
//!
//! The probabilities are always **from the perspective of the player on
//! roll** (`pos.mine`), and they are *cumulative*: `win` is the chance of
//! winning at all, `win_g` the chance of winning a gammon *or better*,
//! `win_bg` the chance of winning a backgammon; `lose_g` and `lose_bg`
//! likewise for the opponent. `P(lose) = 1 − win` is not stored.

use bg_core::Position;
use serde::{Deserialize, Serialize};

/// Cumulative outcome probabilities for the player on roll.
///
/// Invariants (enforced by [`Probs::clamp`], assumed by consumers):
/// `0 ≤ win_bg ≤ win_g ≤ win ≤ 1` and `0 ≤ lose_bg ≤ lose_g ≤ 1 − win`.
///
/// Wire format (`camelCase`): `{ "win", "winG", "winBg", "loseG", "loseBg" }`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probs {
    /// P(I win the game), any margin.
    pub win: f64,
    /// P(I win a gammon or a backgammon).
    pub win_g: f64,
    /// P(I win a backgammon).
    pub win_bg: f64,
    /// P(I lose a gammon or a backgammon).
    pub lose_g: f64,
    /// P(I lose a backgammon).
    pub lose_bg: f64,
}

impl Probs {
    /// Cubeless money equity in points for the player on roll:
    /// `2·win − 1 + win_g + win_bg − lose_g − lose_bg`.
    ///
    /// A certain single win is `+1`, a certain backgammon loss is `−3`.
    #[must_use]
    pub fn cubeless_equity(&self) -> f64 {
        2.0 * self.win - 1.0 + self.win_g + self.win_bg - self.lose_g - self.lose_bg
    }

    /// The same distribution seen by the opponent: `win` becomes `1 − win`
    /// and the gammon/backgammon pairs swap sides.
    #[must_use]
    pub fn flipped(&self) -> Self {
        Self {
            win: 1.0 - self.win,
            win_g: self.lose_g,
            win_bg: self.lose_bg,
            lose_g: self.win_g,
            lose_bg: self.win_bg,
        }
    }

    /// A copy with every component forced into a consistent range:
    /// `win ∈ [0, 1]`, `win_g ∈ [0, win]`, `win_bg ∈ [0, win_g]`,
    /// `lose_g ∈ [0, 1 − win]`, `lose_bg ∈ [0, lose_g]`. `NaN` components
    /// become the lower bound.
    #[must_use]
    #[allow(clippy::similar_names)] // the bindings deliberately mirror the field names
    pub fn clamp(&self) -> Self {
        let win = bounded(self.win, 0.0, 1.0);
        let win_g = bounded(self.win_g, 0.0, win);
        let win_bg = bounded(self.win_bg, 0.0, win_g);
        let lose_g = bounded(self.lose_g, 0.0, 1.0 - win);
        let lose_bg = bounded(self.lose_bg, 0.0, lose_g);
        Self {
            win,
            win_g,
            win_bg,
            lose_g,
            lose_bg,
        }
    }
}

/// `x` restricted to `[lo, hi]`; `NaN` maps to `lo`. `lo ≤ hi` is the
/// caller's responsibility (all call sites derive `hi` from an already
/// bounded value, so it holds).
fn bounded(x: f64, lo: f64, hi: f64) -> f64 {
    if x.is_nan() { lo } else { x.clamp(lo, hi) }
}

/// A static position evaluator. Bot, coach and analysis depend on this
/// trait only; a future neural evaluator is just another `impl`.
pub trait Evaluator {
    /// Outcome probabilities for `pos`, from the perspective of the side
    /// whose checkers are `pos.mine` (the side on roll, about to roll).
    fn evaluate(&self, pos: &Position) -> Probs;
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOL: f64 = 1e-12;

    fn sample() -> Probs {
        Probs {
            win: 0.55,
            win_g: 0.20,
            win_bg: 0.03,
            lose_g: 0.15,
            lose_bg: 0.01,
        }
    }

    fn approx(a: Probs, b: Probs) -> bool {
        (a.win - b.win).abs() < TOL
            && (a.win_g - b.win_g).abs() < TOL
            && (a.win_bg - b.win_bg).abs() < TOL
            && (a.lose_g - b.lose_g).abs() < TOL
            && (a.lose_bg - b.lose_bg).abs() < TOL
    }

    #[test]
    fn cubeless_equity_follows_the_formula() {
        let p = sample();
        let expected = 2.0 * 0.55 - 1.0 + 0.20 + 0.03 - 0.15 - 0.01;
        assert!((p.cubeless_equity() - expected).abs() < TOL);
        let certain_single_win = Probs {
            win: 1.0,
            ..Probs::default()
        };
        assert!((certain_single_win.cubeless_equity() - 1.0).abs() < TOL);
        let certain_backgammon_loss = Probs {
            lose_g: 1.0,
            lose_bg: 1.0,
            ..Probs::default()
        };
        assert!((certain_backgammon_loss.cubeless_equity() + 3.0).abs() < TOL);
    }

    #[test]
    fn flipped_swaps_sides_and_negates_equity() {
        let p = sample();
        let f = p.flipped();
        assert!((f.win - 0.45).abs() < TOL);
        assert!((f.win_g - 0.15).abs() < TOL);
        assert!((f.win_bg - 0.01).abs() < TOL);
        assert!((f.lose_g - 0.20).abs() < TOL);
        assert!((f.lose_bg - 0.03).abs() < TOL);
        assert!((f.cubeless_equity() + p.cubeless_equity()).abs() < TOL);
        assert!(approx(f.flipped(), p));
    }

    #[test]
    fn clamp_enforces_ordering_invariants() {
        let messy = Probs {
            win: 1.3,
            win_g: 0.9,
            win_bg: 0.95,
            lose_g: 0.2,
            lose_bg: -0.1,
        };
        let c = messy.clamp();
        assert!((c.win - 1.0).abs() < TOL);
        assert!((c.win_g - 0.9).abs() < TOL);
        assert!((c.win_bg - 0.9).abs() < TOL);
        assert!((c.lose_g - 0.0).abs() < TOL);
        assert!((c.lose_bg - 0.0).abs() < TOL);

        let consistent = sample();
        assert!(approx(consistent.clamp(), consistent));
    }

    #[test]
    fn clamp_maps_nan_to_lower_bound_without_panicking() {
        let bad = Probs {
            win: f64::NAN,
            win_g: f64::NAN,
            win_bg: 0.1,
            lose_g: f64::NAN,
            lose_bg: 0.2,
        };
        let c = bad.clamp();
        assert!(approx(c, Probs::default()));
    }

    #[test]
    fn serialises_camel_case() {
        let json = serde_json::to_value(sample()).expect("serialise");
        assert_eq!(
            json,
            serde_json::json!({
                "win": 0.55, "winG": 0.20, "winBg": 0.03, "loseG": 0.15, "loseBg": 0.01
            })
        );
        let back: Probs = serde_json::from_value(json).expect("deserialise");
        assert!(approx(back, sample()));
    }

    #[test]
    fn evaluator_is_object_safe() {
        struct Fixed;
        impl Evaluator for Fixed {
            fn evaluate(&self, _pos: &Position) -> Probs {
                sample()
            }
        }
        let ev: &dyn Evaluator = &Fixed;
        let pos = Position::from_board(&bg_core::Board::opening(), bg_core::Player::White);
        assert!(approx(ev.evaluate(&pos), sample()));
    }
}
