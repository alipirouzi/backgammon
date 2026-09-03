//! Backgammon rules engine.
//!
//! `bg-core` owns the board model, dice, legal-play generation, notation,
//! game and match state, and match records. It never reads OS randomness:
//! callers pass a `u64` seed and every result is reproducible on every
//! target, including `wasm32-unknown-unknown`.
//!
//! See `position` for the relative coordinate system used by the rules and
//! the bot, and `board` for the absolute one used on the wire.
#![warn(missing_docs)]

pub mod board;
pub mod dice;
pub mod error;
pub mod game;
pub mod match_play;
pub mod moves;
pub mod notation;
pub mod player;
pub mod point;
pub mod position;
pub mod record;

pub use board::Board;
pub use dice::{Dice, DiceRng};
pub use error::RulesError;
pub use game::{Cube, GameResult, GameState, Phase, ResultKind, Rules};
pub use match_play::MatchState;
pub use moves::{Move, Play};
pub use notation::parse_play;
pub use player::Player;
pub use point::Point;
pub use position::Position;
pub use record::{Action, Record, Turn, replay};
