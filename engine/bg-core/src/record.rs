//! Match records: the seed plus a log of every turn, and replay.
//!
//! Dice are never stored as the source of truth: [`replay`] re-derives every
//! roll from `Record::seed` with [`DiceRng`] and checks that the logged
//! dice, players and plays agree with what the rules produce. A record whose
//! log disagrees with the seed or the rules is rejected, so a stored record
//! is a proof of the game that was played.
//!
//! JSON: `{ "seed": 123456789, "length": 7, "rules": Rules, "turns": [Turn] }`
//! with `Turn` = `{ "player": "white", "dice": Dice|null, "action":
//! "roll"|"move"|"double"|"take"|"drop"|"resign", "play": "24/18 13/10"|null,
//! "resignPoints": u8|null }`; `play` is in notation relative to `player`.
//!
//! `seed` is a bare JSON integer and records travel through JavaScript, whose
//! `JSON.parse` rounds integers above 2^53 − 1. A seed must therefore not
//! exceed [`MAX_SEED`]; [`replay`] rejects a larger one up front rather than
//! failing later on dice derived from a drifted seed.

use serde::{Deserialize, Serialize};

use crate::game::{Phase, ResultKind, Rules};
use crate::match_play::MatchState;
use crate::{Dice, DiceRng, Play, Player, RulesError, parse_play};

/// What a logged turn did. JSON: lowercase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// The player rolled (`dice` set); the opening roll is logged by its winner.
    Roll,
    /// The player played `play` (`dice` set to the roll played).
    Move,
    /// The player offered a double.
    Double,
    /// The player accepted a double.
    Take,
    /// The player declined a double.
    Drop,
    /// The player resigned, conceding `resign_points` points.
    Resign,
}

/// One logged action.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Who acted.
    pub player: Player,
    /// The dice rolled (`Roll`) or played (`Move`); `None` otherwise.
    pub dice: Option<Dice>,
    /// What happened.
    pub action: Action,
    /// The play in standard notation relative to `player` (`Move` only;
    /// `""` for a forfeited turn).
    pub play: Option<String>,
    /// Points conceded (`Resign` only).
    pub resign_points: Option<u8>,
}

impl Turn {
    fn bare(player: Player, action: Action) -> Self {
        Self {
            player,
            dice: None,
            action,
            play: None,
            resign_points: None,
        }
    }

    /// `player` rolled `dice` (for the opening roll, `player` is its winner).
    #[must_use]
    pub fn roll(player: Player, dice: Dice) -> Self {
        Self {
            dice: Some(dice),
            ..Self::bare(player, Action::Roll)
        }
    }

    /// `player` played `play` with `dice`.
    #[must_use]
    pub fn mv(player: Player, dice: Dice, play: &Play) -> Self {
        Self {
            dice: Some(dice),
            play: Some(play.to_string()),
            ..Self::bare(player, Action::Move)
        }
    }

    /// `player` offered a double.
    #[must_use]
    pub fn double(player: Player) -> Self {
        Self::bare(player, Action::Double)
    }

    /// `player` accepted a double.
    #[must_use]
    pub fn take(player: Player) -> Self {
        Self::bare(player, Action::Take)
    }

    /// `player` declined a double.
    #[must_use]
    pub fn drop(player: Player) -> Self {
        Self::bare(player, Action::Drop)
    }

    /// `player` resigned, conceding `points`.
    #[must_use]
    pub fn resign(player: Player, points: u8) -> Self {
        Self {
            resign_points: Some(points),
            ..Self::bare(player, Action::Resign)
        }
    }
}

/// The largest seed a [`Record`] may carry: JavaScript's
/// `Number.MAX_SAFE_INTEGER` (2^53 − 1), so that `seed` survives
/// `JSON.parse` in every binding unchanged.
pub const MAX_SEED: u64 = (1 << 53) - 1;

/// A complete (or partial) match record.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Seed of the [`DiceRng`] that produced every roll; at most
    /// [`MAX_SEED`] (see the module documentation).
    pub seed: u64,
    /// Match length (`0` = money / single game).
    pub length: u8,
    /// Rules in force for every game.
    pub rules: Rules,
    /// The turns, in order.
    pub turns: Vec<Turn>,
}

impl Record {
    /// An empty record for a match with these parameters.
    #[must_use]
    pub fn new(seed: u64, length: u8, rules: Rules) -> Self {
        Self {
            seed,
            length,
            rules,
            turns: Vec::new(),
        }
    }
}

/// Replays `record` from its seed and returns the resulting [`MatchState`].
///
/// Every roll is re-derived from the seed; every logged `dice`, `player` and
/// `play` must agree with the rules. Whenever an action leaves the game
/// finished, [`MatchState::finish_game`] is called at once — a live driver
/// must do the same for its final state to compare equal.
///
/// # Errors
///
/// [`RulesError::Parse`] when `seed` exceeds [`MAX_SEED`], when the log
/// disagrees with the seed or names the wrong player, when a `Move` has no
/// play or a `Resign` no points, or when a play does not parse; the game's
/// own errors ([`RulesError::IllegalPlay`], [`RulesError::WrongPhase`],
/// [`RulesError::NotAllowed`]) when an action is not legal where it appears.
pub fn replay(record: &Record) -> Result<MatchState, RulesError> {
    if record.seed > MAX_SEED {
        return Err(mismatch(format!(
            "seed {} exceeds the maximum {MAX_SEED} (2^53 - 1, JavaScript's safe integer range)",
            record.seed
        )));
    }
    let mut rng = DiceRng::from_seed(record.seed);
    let mut m = MatchState::new(record.length, record.rules);
    for (i, turn) in record.turns.iter().enumerate() {
        replay_turn(&mut m, &mut rng, turn).map_err(|e| annotate(i, e))?;
        if m.game.phase == Phase::Finished {
            m.finish_game();
        }
    }
    Ok(m)
}

/// Prefixes `Parse` errors with the turn index; other errors pass through.
fn annotate(i: usize, e: RulesError) -> RulesError {
    match e {
        RulesError::Parse(msg) => RulesError::Parse(format!("turn {i}: {msg}")),
        other => other,
    }
}

fn mismatch(msg: String) -> RulesError {
    RulesError::Parse(msg)
}

fn expect_player(turn: &Turn, expected: Option<Player>) -> Result<(), RulesError> {
    if expected == Some(turn.player) {
        Ok(())
    } else {
        Err(mismatch(format!(
            "logged player {:?} but {:?} is to act",
            turn.player, expected
        )))
    }
}

fn expect_dice(turn: &Turn, actual: Dice) -> Result<(), RulesError> {
    match turn.dice {
        Some(logged) if logged == actual => Ok(()),
        Some(logged) => Err(mismatch(format!(
            "logged dice {}-{} but the seed gives {}-{}",
            logged.hi, logged.lo, actual.hi, actual.lo
        ))),
        None => Err(mismatch("turn has no dice".into())),
    }
}

fn replay_turn(m: &mut MatchState, rng: &mut DiceRng, turn: &Turn) -> Result<(), RulesError> {
    match turn.action {
        Action::Roll if m.game.phase == Phase::OpeningRoll => {
            let dice = m.game.opening_roll(rng);
            expect_player(turn, m.game.on_roll)?;
            expect_dice(turn, dice)
        }
        Action::Roll => {
            expect_player(turn, m.game.on_roll)?;
            let dice = m.game.roll(rng)?;
            expect_dice(turn, dice)
        }
        Action::Move => {
            expect_player(turn, m.game.on_roll)?;
            if let Some(dice) = m.game.dice {
                expect_dice(turn, dice)?;
            }
            let notation = turn
                .play
                .as_deref()
                .ok_or_else(|| mismatch("move turn has no play".into()))?;
            let play = parse_play(notation)?;
            m.game.play(&play)
        }
        Action::Double => {
            expect_player(turn, m.game.on_roll)?;
            if !m.cube_allowed() {
                return Err(RulesError::NotAllowed(
                    "the cube is out of play in the Crawford game",
                ));
            }
            m.game.double()
        }
        Action::Take => {
            expect_player(turn, m.game.on_roll.map(Player::opponent))?;
            m.game.take()
        }
        Action::Drop => {
            expect_player(turn, m.game.on_roll.map(Player::opponent))?;
            m.game.drop()
        }
        Action::Resign => {
            expect_player(turn, m.game.on_roll)?;
            let points = turn
                .resign_points
                .ok_or_else(|| mismatch("resign turn has no points".into()))?;
            let kind = resign_kind(points, m.game.cube.value)?;
            m.game.resign(kind)?;
            let awarded = m.game.result.map_or(0, |r| r.points);
            if awarded == points {
                Ok(())
            } else {
                Err(mismatch(format!(
                    "logged resignation of {points} points but the rules award {awarded}"
                )))
            }
        }
    }
}

/// The kind conceded when `points` are resigned at `cube` (`points` must be
/// 1, 2 or 3 times the cube).
fn resign_kind(points: u8, cube: u8) -> Result<ResultKind, RulesError> {
    let kind = [
        ResultKind::Single,
        ResultKind::Gammon,
        ResultKind::Backgammon,
    ]
    .into_iter()
    .find(|k| k.multiplier().saturating_mul(cube) == points);
    kind.ok_or_else(|| {
        mismatch(format!(
            "resignation of {points} points is not 1, 2 or 3 times the cube ({cube})"
        ))
    })
}
