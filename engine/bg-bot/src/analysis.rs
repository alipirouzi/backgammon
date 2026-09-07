//! Analysis output: error thresholds, the error [`Category`] and the
//! [`MoveAnalysis`] built from a ranked candidate list.
//!
//! Error sizes are equity losses against the best candidate on the scale of
//! [`crate::equity_for`] (money equity, or match equity normalised so a single
//! game at the current cube is `±1`), so the same thresholds apply to money
//! and match play, and to checker and cube decisions alike.

use serde::{Deserialize, Serialize};

use crate::search::{Candidate, ranking_gap};

/// Error-size boundaries in equity, following XG's published legend.
pub mod thresholds {
    /// Losses up to this size are [`super::Category::Best`] (rounding noise).
    pub const BEST: f64 = 0.0005;
    /// Losses below this size are [`super::Category::Fine`].
    pub const FINE: f64 = 0.020;
    /// Losses below this size are [`super::Category::Error`]; at or above it
    /// they are [`super::Category::Blunder`].
    pub const ERROR: f64 = 0.080;
}

/// How costly a decision was, relative to the best one.
///
/// Wire format: `"best" | "fine" | "error" | "blunder"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    /// Loss ≤ [`thresholds::BEST`].
    Best,
    /// Loss < [`thresholds::FINE`].
    Fine,
    /// [`thresholds::FINE`] ≤ loss < [`thresholds::ERROR`].
    Error,
    /// Loss ≥ [`thresholds::ERROR`] (a `NaN` loss is also reported here).
    Blunder,
}

/// The [`Category`] of an equity loss `error` (negative losses are `Best`).
#[must_use]
pub fn categorize(error: f64) -> Category {
    if error <= thresholds::BEST {
        Category::Best
    } else if error < thresholds::FINE {
        Category::Fine
    } else if error < thresholds::ERROR {
        Category::Error
    } else {
        Category::Blunder
    }
}

/// Analysis of one checker play against the ranked alternatives.
///
/// Wire format (`camelCase`): `{ "candidates", "playedIndex", "errorSize",
/// "category" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveAnalysis {
    /// Ranked candidates, best first (see [`crate::rank_plays`]).
    pub candidates: Vec<Candidate>,
    /// Index into `candidates` of the play actually made.
    pub played_index: usize,
    /// Equity lost by the played move against `candidates[0]`, never
    /// negative: [`ranking_gap`]`(best, played)`, the very comparator the
    /// ranking is ordered by — the search-equity difference unless both
    /// plays were rolled out and the rollout gap is decisive. Both plays
    /// must have been scored by the same procedure for the number to mean
    /// anything; [`crate::Bot::analyze_play`] refines a played move outside
    /// the head before building this.
    pub error_size: f64,
    /// [`categorize`] of `error_size`.
    pub category: Category,
}

impl MoveAnalysis {
    /// Builds the analysis for `candidates[played_index]`. An out-of-range
    /// index is clamped to the last candidate; an empty list yields a
    /// zero-error analysis with `played_index == 0`.
    #[must_use]
    pub fn from_candidates(candidates: Vec<Candidate>, played_index: usize) -> Self {
        let played_index = played_index.min(candidates.len().saturating_sub(1));
        let error_size = match (candidates.first(), candidates.get(played_index)) {
            (Some(best), Some(played)) => ranking_gap(best, played).max(0.0),
            _ => 0.0,
        };
        Self {
            candidates,
            played_index,
            error_size,
            category: categorize(error_size),
        }
    }
}

/// The equity a candidate is ranked by: its search equity (2-ply in the
/// refined head, 1-ply in the tail). A rollout is attached information and
/// re-orders candidates only when decisive ([`ranking_gap`]).
#[must_use]
pub fn value(c: &Candidate) -> f64 {
    c.equity
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Probs;
    use bg_core::Play;

    fn cand(equity: f64) -> Candidate {
        Candidate {
            play: Play::empty(),
            equity,
            probs: Probs::default(),
            rollout: None,
        }
    }

    #[test]
    fn from_candidates_clamps_index_and_never_reports_negative_error() {
        let a = MoveAnalysis::from_candidates(vec![cand(0.5), cand(0.4), cand(0.6)], 9);
        assert_eq!(a.played_index, 2);
        assert!((a.error_size - 0.0).abs() < 1e-12);
        assert_eq!(a.category, Category::Best);
        let b = MoveAnalysis::from_candidates(vec![cand(0.5), cand(0.4)], 1);
        assert!((b.error_size - 0.1).abs() < 1e-12);
        assert_eq!(b.category, Category::Blunder);
        let empty = MoveAnalysis::from_candidates(Vec::new(), 3);
        assert_eq!(empty.played_index, 0);
        assert_eq!(empty.category, Category::Best);
    }

    #[test]
    fn error_follows_a_decisive_rollout_and_ignores_a_noisy_one() {
        use crate::RolloutStats;
        let rolled = |equity: f64, r: f64, se: f64| Candidate {
            rollout: Some(RolloutStats {
                trials: 100,
                equity: r,
                std_err: se,
                probs: Probs::default(),
            }),
            ..cand(equity)
        };
        // Noisy rollout (gap 0.06 < 2 × 0.057): search equities grade the play.
        let a = MoveAnalysis::from_candidates(
            vec![rolled(0.30, 0.10, 0.04), rolled(0.25, 0.16, 0.04)],
            1,
        );
        assert!((a.error_size - 0.05).abs() < 1e-12);
        assert_eq!(a.category, Category::Error);
        // Decisive rollout: the rollout gap is the error, whatever 2-ply said.
        let b = MoveAnalysis::from_candidates(
            vec![rolled(0.20, 0.40, 0.04), rolled(0.30, 0.10, 0.04)],
            1,
        );
        assert!((b.error_size - 0.30).abs() < 1e-12);
        assert_eq!(b.category, Category::Blunder);
    }
}
