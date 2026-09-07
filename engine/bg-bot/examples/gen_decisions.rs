//! Generates the bot decision vectors `engine/vectors/decisions.json`.
//!
//! Usage (from `engine/`):
//!
//! ```text
//! cargo run --release -p bg-bot --example gen_decisions -- decisions vectors/decisions.json
//! ```
//!
//! The output is fully determined by the engine (`DiceRng`, `legal_plays`,
//! the club evaluator, search and rollouts) and the constants below;
//! `tests/vectors.rs` asserts that the committed file equals the regenerated
//! text, so a change in any of them shows up as a failing test rather than
//! as silent drift. `tests/perf.rs` reuses the position sampler.

use std::error::Error;
use std::fmt::Write as _;

use bg_bot::analysis::value;
use bg_bot::{Bot, Level, MatchContext};
use bg_core::moves::{apply, legal_plays};
use bg_core::{Board, Dice, DiceRng, Player, Position};
use serde::{Deserialize, Serialize};

/// Opening entries: the opening position, White on roll, one entry per
/// non-double roll (an opening roll is never a double), in [`Dice::all`]
/// order; levels cycle beginner → intermediate → club.
pub const OPENING_ROLLS: usize = 15;
/// Contact positions sampled along the seeded random walk (club level).
pub const MIDDLEGAME_POSITIONS: usize = 7;
/// No-contact positions with at least one side not yet all home (club level).
pub const RACE_POSITIONS: usize = 4;
/// No-contact positions with both sides all home (club level).
pub const BEAROFF_POSITIONS: usize = 4;

/// Seed of the random walk that produces the non-opening positions.
pub const WALK_SEED: u64 = 0xB07_2026_0903;
/// Seed of the random walk behind [`perf_positions`] (disjoint from the
/// vectors so the timing test does not share their positions).
pub const PERF_WALK_SEED: u64 = 0xB07_9E4F;
/// Entry `i` is decided with seed `SEED_BASE + i`.
pub const SEED_BASE: u64 = 7;
/// Equities are rounded to this many decimals before serialisation so the
/// file survives last-ulp differences between platform `libm`s.
pub const EQUITY_DECIMALS: i32 = 6;

/// Consecutive samples are at least this many plies apart along the walk
/// (the exact gap is `MIN_GAP..=MAX_GAP`, drawn from the same generator).
const MIN_GAP: usize = 1;
const MAX_GAP: usize = 6;
/// A middlegame sample needs this many plies since the last restart, so
/// both sides have developed.
const MIDDLEGAME_MIN_PLIES: usize = 6;
/// Checkers a side owns; a game is over when one side has borne them all off.
const CHECKERS: u8 = 15;

/// One decision vector: a position, the roll, the match situation, the bot
/// level and seed, the play the bot chooses and every legal play with its
/// equity.
///
/// JSON shape (binding for the bindings' parity tests):
/// `{ "board": Board, "onRoll": "white", "dice": Dice, "match": MatchContext,
/// "level": "club", "seed": 7, "chosen": "24/18 13/10",
/// "candidates": [{ "notation": "24/18 13/10", "equity": 0.021 }, …] }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionVector {
    /// The absolute board.
    pub board: Board,
    /// The player on roll; notations are from this player's point of view.
    pub on_roll: Player,
    /// The roll.
    pub dice: Dice,
    /// Match situation from the point of view of `on_roll`.
    #[serde(rename = "match")]
    pub match_ctx: MatchContext,
    /// Bot level the decision was made at.
    pub level: Level,
    /// Seed passed to the bot (noise stream and rollout dice).
    pub seed: u64,
    /// Notation of the chosen play (`candidates[0].notation`).
    pub chosen: String,
    /// Every legal play in the bot's ranking, best first.
    pub candidates: Vec<CandidateVector>,
}

/// One ranked play: its notation and the equity it was ranked by (the
/// search equity, `bg_bot::analysis::value`: 2-ply for the refined head,
/// 1-ply otherwise; a rollout only re-orders when decisive), rounded to
/// [`EQUITY_DECIMALS`] decimals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateVector {
    /// Play notation relative to the player on roll.
    pub notation: String,
    /// Match-normalised equity the play was ranked by.
    pub equity: f64,
}

/// A sampled position with the roll and the seed to decide it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    /// The position on the axis of the side on roll.
    pub pos: Position,
    /// The side on roll.
    pub on_roll: Player,
    /// The roll.
    pub dice: Dice,
    /// Seed for the bot.
    pub seed: u64,
}

/// Position class a sample is drawn for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Contact, both sides developed.
    Middlegame,
    /// No contact, at least one side not yet all home.
    Race,
    /// No contact, both sides all home.
    Bearoff,
}

impl Class {
    fn matches(self, pos: &Position, plies: usize) -> bool {
        let bearoff = pos.is_race() && pos.all_home() && pos.flip().all_home();
        match self {
            Self::Middlegame => !pos.is_race() && plies >= MIDDLEGAME_MIN_PLIES,
            Self::Race => pos.is_race() && !bearoff,
            Self::Bearoff => bearoff,
        }
    }
}

/// A money game with a centred cube.
#[must_use]
pub fn money() -> MatchContext {
    MatchContext {
        length: 0,
        my_away: 0,
        their_away: 0,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

/// Match situations the non-opening entries cycle through: money, mid-match
/// centred cube, a cube I own, the Crawford game, post-Crawford, and a cube
/// the opponent owns.
#[must_use]
pub fn match_contexts() -> [MatchContext; 6] {
    let m = money();
    [
        m,
        MatchContext {
            length: 7,
            my_away: 3,
            their_away: 5,
            ..m
        },
        MatchContext {
            cube: 2,
            cube_owner_is_me: Some(true),
            ..m
        },
        MatchContext {
            length: 5,
            my_away: 1,
            their_away: 3,
            crawford: true,
            ..m
        },
        MatchContext {
            length: 5,
            my_away: 3,
            their_away: 1,
            post_crawford: true,
            ..m
        },
        MatchContext {
            length: 9,
            my_away: 4,
            their_away: 2,
            cube: 2,
            cube_owner_is_me: Some(false),
            ..m
        },
    ]
}

/// The decision vectors: [`OPENING_ROLLS`] opening entries, then
/// [`MIDDLEGAME_POSITIONS`], [`RACE_POSITIONS`] and [`BEAROFF_POSITIONS`]
/// club-level entries sampled along one seeded random walk
/// ([`decision_samples`], each decided by [`decide`]).
#[must_use]
pub fn decision_vectors() -> Vec<DecisionVector> {
    decision_samples()
        .iter()
        .map(|(sample, ctx, level)| decide(sample, *ctx, *level))
        .collect()
}

/// The inputs of every decision vector, in file order: the sampled
/// position with its roll and seed, the match context and the level. Cheap
/// (no search), so a test can regenerate a subset of the entries.
#[must_use]
pub fn decision_samples() -> Vec<(Sample, MatchContext, Level)> {
    const LEVELS: [Level; 3] = [Level::Beginner, Level::Intermediate, Level::Club];
    let opening = Position::from_board(&Board::opening(), Player::White);
    let mut out: Vec<(Sample, MatchContext, Level)> = Dice::all()
        .into_iter()
        .filter(|d| !d.is_double())
        .enumerate()
        .map(|(i, dice)| {
            let sample = Sample {
                pos: opening,
                on_roll: Player::White,
                dice,
                seed: SEED_BASE + i as u64,
            };
            (sample, money(), LEVELS[i % LEVELS.len()])
        })
        .collect();

    let classes = [Class::Middlegame; MIDDLEGAME_POSITIONS]
        .into_iter()
        .chain([Class::Race; RACE_POSITIONS])
        .chain([Class::Bearoff; BEAROFF_POSITIONS]);
    let contexts = match_contexts();
    let mut walk = RandomWalk::new(WALK_SEED);
    for (j, class) in classes.enumerate() {
        let i = OPENING_ROLLS + j;
        let sample = walk.sample(class, SEED_BASE + i as u64);
        out.push((sample, contexts[j % contexts.len()], Level::Club));
    }
    out
}

/// `n` middlegame samples from a walk seeded with [`PERF_WALK_SEED`], for
/// the timing test.
#[must_use]
pub fn perf_positions(n: usize) -> Vec<Sample> {
    let mut walk = RandomWalk::new(PERF_WALK_SEED);
    (0..n)
        .map(|i| walk.sample(Class::Middlegame, SEED_BASE + i as u64))
        .collect()
}

/// Runs the bot at `level` on `sample` and records the result.
#[must_use]
pub fn decide(sample: &Sample, ctx: MatchContext, level: Level) -> DecisionVector {
    let bot = Bot::new(level);
    let (chosen, candidates) = bot.choose_play(&ctx, &sample.pos, sample.dice, sample.seed);
    DecisionVector {
        board: sample.pos.to_board(sample.on_roll),
        on_roll: sample.on_roll,
        dice: sample.dice,
        match_ctx: ctx,
        level,
        seed: sample.seed,
        chosen: chosen.to_string(),
        candidates: candidates
            .iter()
            .map(|c| CandidateVector {
                notation: c.play.to_string(),
                equity: round_equity(value(c)),
            })
            .collect(),
    }
}

/// Rounds to [`EQUITY_DECIMALS`] decimals; `-0.0` becomes `0.0`.
fn round_equity(x: f64) -> f64 {
    let scale = 10f64.powi(EQUITY_DECIMALS);
    (x * scale).round() / scale + 0.0
}

/// Seeded random play from the opening: every ply rolls and picks one of
/// the legal plays at random; sides alternate, White first.
struct RandomWalk {
    rng: DiceRng,
    pos: Position,
    on_roll: Player,
    /// Plies since the last (re)start.
    plies: usize,
}

impl RandomWalk {
    fn new(seed: u64) -> Self {
        Self {
            rng: DiceRng::from_seed(seed),
            pos: Position::from_board(&Board::opening(), Player::White),
            on_roll: Player::White,
            plies: 0,
        }
    }

    /// `true` once a side has borne off every checker.
    fn is_finished(&self) -> bool {
        self.pos.mine[0] == CHECKERS || self.pos.theirs[0] == CHECKERS
    }

    fn restart(&mut self) {
        self.pos = Position::from_board(&Board::opening(), Player::White);
        self.on_roll = Player::White;
        self.plies = 0;
    }

    /// Plays one random legal play, restarting from the opening first if
    /// the game is over.
    fn step(&mut self) {
        if self.is_finished() {
            self.restart();
        }
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
        self.plies += 1;
    }

    /// Advances a random gap, then steps until the position is unfinished
    /// and of `class`, and rolls for it.
    fn sample(&mut self, class: Class, seed: u64) -> Sample {
        let gap = MIN_GAP + random_index(&mut self.rng, MAX_GAP - MIN_GAP + 1);
        for _ in 0..gap {
            self.step();
        }
        while self.is_finished() || !class.matches(&self.pos, self.plies) {
            self.step();
        }
        Sample {
            pos: self.pos,
            on_roll: self.on_roll,
            dice: self.rng.roll(),
            seed,
        }
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

/// The exact text written to `decisions.json`: pretty JSON with a trailing
/// newline.
///
/// # Panics
///
/// Never in practice: serialising plain structs of arrays, strings and
/// finite numbers cannot fail.
#[must_use]
pub fn render_decisions() -> String {
    let vectors = decision_vectors();
    let mut text = serde_json::to_string_pretty(&vectors)
        .unwrap_or_else(|e| unreachable!("vectors serialise: {e}"));
    let _ = writeln!(text);
    text
}

fn usage() -> Box<dyn Error> {
    "usage: gen_decisions decisions <output-path>".into()
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let kind = args.next().ok_or_else(usage)?;
    let path = args.next().ok_or_else(usage)?;
    if args.next().is_some() {
        return Err(usage());
    }
    match kind.as_str() {
        "decisions" => {
            let text = render_decisions();
            std::fs::write(&path, &text)?;
            println!("wrote {} bytes to {path}", text.len());
            Ok(())
        }
        other => Err(format!("unknown vector kind {other:?}; expected `decisions`").into()),
    }
}
