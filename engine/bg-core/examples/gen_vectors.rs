//! Generates the shared engine test vectors under `engine/vectors/`.
//!
//! Usage (from `engine/`):
//!
//! ```text
//! cargo run -p bg-core --example gen_vectors -- plays vectors/plays.json
//! ```
//!
//! The output is fully determined by the engine (`DiceRng`, `legal_plays`
//! order and `Play` notation) and the constants below; `tests/vectors.rs`
//! asserts that the committed file equals the regenerated text, so a change
//! in any of them shows up as a failing test rather than as silent drift.

use std::error::Error;
use std::fmt::Write as _;

use bg_core::moves::{apply, legal_plays};
use bg_core::{Board, Dice, DiceRng, Player, Position};
use serde::{Deserialize, Serialize};

/// Seed of the random walk that produces the non-opening positions.
pub const PLAYS_SEED: u64 = 0x5EED_2026_0903;
/// Number of random positions in `plays.json`.
pub const RANDOM_POSITIONS: usize = 40;
/// Rolls per random position in `plays.json`.
pub const ROLLS_PER_POSITION: usize = 3;
/// Consecutive random positions are `MIN_GAP..=MAX_GAP` plies apart along
/// one continuous random walk (the gap is drawn from the same generator);
/// the walk restarts from the opening whenever a game ends.
const MIN_GAP: usize = 1;
const MAX_GAP: usize = 9;
/// Checkers a side owns; a game is over when one side has borne them all off.
const CHECKERS: u8 = 15;

/// One legal-play vector: a position, the player on roll, a roll, and the
/// notations of every legal play (relative to `on_roll`).
///
/// JSON shape (binding for the bindings' parity tests):
/// `{ "board": Board, "onRoll": "white", "dice": Dice, "plays": ["24/18 13/10", …] }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayVector {
    /// The absolute board.
    pub board: Board,
    /// The player on roll; `plays` are written from this player's point of view.
    pub on_roll: Player,
    /// The roll.
    pub dice: Dice,
    /// Every legal play in `legal_plays` order, as notation. A position with
    /// no legal move yields the single empty string.
    pub plays: Vec<String>,
}

impl PlayVector {
    fn new(pos: &Position, on_roll: Player, dice: Dice) -> Self {
        Self {
            board: pos.to_board(on_roll),
            on_roll,
            dice,
            plays: legal_plays(pos, dice)
                .iter()
                .map(ToString::to_string)
                .collect(),
        }
    }
}

/// The legal-play vectors: the opening position for all 21 rolls (in
/// [`Dice::all`] order, White on roll) followed by [`RANDOM_POSITIONS`]
/// positions sampled along a seeded random walk, each with
/// [`ROLLS_PER_POSITION`] rolls.
#[must_use]
pub fn plays_vectors() -> Vec<PlayVector> {
    let opening = Position::from_board(&Board::opening(), Player::White);
    let mut out: Vec<PlayVector> = Dice::all()
        .iter()
        .map(|&dice| PlayVector::new(&opening, Player::White, dice))
        .collect();

    let mut walk = RandomWalk::new(PLAYS_SEED);
    for _ in 0..RANDOM_POSITIONS {
        let gap = MIN_GAP + random_index(&mut walk.rng, MAX_GAP - MIN_GAP + 1);
        walk.advance(gap);
        for _ in 0..ROLLS_PER_POSITION {
            let dice = walk.rng.roll();
            out.push(PlayVector::new(&walk.pos, walk.on_roll, dice));
        }
    }
    out
}

/// Seeded random play from the opening: every ply rolls and picks one of
/// the legal plays at random; sides alternate, White first.
struct RandomWalk {
    rng: DiceRng,
    pos: Position,
    on_roll: Player,
}

impl RandomWalk {
    fn new(seed: u64) -> Self {
        Self {
            rng: DiceRng::from_seed(seed),
            pos: Position::from_board(&Board::opening(), Player::White),
            on_roll: Player::White,
        }
    }

    /// `true` once a side has borne off every checker.
    fn is_finished(&self) -> bool {
        self.pos.mine[0] == CHECKERS || self.pos.theirs[0] == CHECKERS
    }

    fn restart(&mut self) {
        self.pos = Position::from_board(&Board::opening(), Player::White);
        self.on_roll = Player::White;
    }

    /// Plays `plies` random legal plays, restarting from the opening whenever
    /// a game ends, and never stops on a finished position.
    fn advance(&mut self, plies: usize) {
        let mut remaining = plies;
        while remaining > 0 {
            if self.is_finished() {
                self.restart();
                continue;
            }
            self.play_one();
            remaining -= 1;
        }
        if self.is_finished() {
            self.restart();
        }
    }

    fn play_one(&mut self) {
        let plays = legal_plays(&self.pos, self.rng.roll());
        let chosen = &plays[random_index(&mut self.rng, plays.len())];
        // Every play returned by `legal_plays` applies to the position it
        // was generated for; a failure here is an engine bug, not an input
        // error, so the generator stops rather than writing a bad vector.
        let next = match apply(&self.pos, chosen) {
            Ok(next) => next,
            Err(e) => unreachable!("legal play {chosen} failed to apply: {e}"),
        };
        self.pos = next.flip();
        self.on_roll = self.on_roll.opponent();
    }
}

/// A pseudo-random index in `0..len` from three die rolls (216 outcomes,
/// reduced modulo `len`; the slight bias is irrelevant for a coverage walk).
fn random_index(rng: &mut DiceRng, len: usize) -> usize {
    let mut n = 0usize;
    for _ in 0..3 {
        n = n * 6 + usize::from(rng.roll_one() - 1);
    }
    n % len
}

/// The exact text written to `plays.json`: pretty JSON with a trailing
/// newline.
///
/// # Panics
///
/// Never in practice: serialising plain structs of arrays and strings cannot
/// fail.
#[must_use]
pub fn render_plays() -> String {
    let vectors = plays_vectors();
    let mut text = serde_json::to_string_pretty(&vectors)
        .unwrap_or_else(|e| unreachable!("vectors serialise: {e}"));
    let _ = writeln!(text);
    text
}

fn usage() -> Box<dyn Error> {
    "usage: gen_vectors plays <output-path>".into()
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let kind = args.next().ok_or_else(usage)?;
    let path = args.next().ok_or_else(usage)?;
    if args.next().is_some() {
        return Err(usage());
    }
    match kind.as_str() {
        "plays" => {
            let text = render_plays();
            std::fs::write(&path, &text)?;
            println!("wrote {} bytes to {path}", text.len());
            Ok(())
        }
        other => Err(format!("unknown vector kind {other:?}; expected `plays`").into()),
    }
}
