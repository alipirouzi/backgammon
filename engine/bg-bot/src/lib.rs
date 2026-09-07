//! Backgammon bot: evaluator trait, match equity table, heuristic evaluator,
//! search, rollouts, cube decisions and analysis output.
//!
//! Everything is deterministic for a given seed and builds for
//! `wasm32-unknown-unknown` (no `std::time`, no OS randomness, no threads).
//!
//! The match equity table is the Kazaross-XG2 table distributed with GNU
//! Backgammon; see [`met_data`] and `MET-NOTICE.txt` for its notice.
#![warn(missing_docs)]

pub mod evaluator;
pub mod met;
pub mod met_data;

pub use evaluator::{Evaluator, Probs};
pub use met::{MatchContext, cubeless_mwc, equity_for, met, met_post_crawford, mwc_after};

pub mod features;
pub mod heuristic;
pub mod race;

pub use heuristic::ClubEvaluator;
pub mod rollout;
pub mod search;

pub use rollout::RolloutStats;
pub use search::{Candidate, Level, SearchParams, rank_plays};

pub mod analysis;
pub mod bot;
pub mod cube;

pub use analysis::{Category, MoveAnalysis};
pub use bot::Bot;
pub use cube::{CubeAction, CubeAnalysis, CubeChoice};
