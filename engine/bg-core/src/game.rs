//! One game: cube, rules in force, phases, actions and result detection.
//!
//! A game moves through these phases:
//!
//! ```text
//! OpeningRoll ──opening_roll──▶ ToMove ──play──▶ ToRoll ──roll──▶ ToMove …
//!                                 │                │  └─double──▶ Doubled ──take──▶ ToRoll
//!                                 │                │                 └──drop──▶ Finished
//!                                 └─(15 off)───────┴──resign──────────────────▶ Finished
//! ```
//!
//! Rules (see <https://www.bkgm.com/rules.html>): a double may be offered
//! only at the start of one's own turn before rolling, by a player who has
//! access to the cube (centred or owned); the taker becomes the owner; a drop
//! concedes the current cube value. The loser is gammoned when he has borne
//! off nothing and backgammoned when in addition he has a checker on the bar
//! or in the winner's home board. Under the Jacoby rule (money games)
//! gammons and backgammons count as a single game unless a double has been
//! offered — an automatic double is not an offered double, so the test is
//! "the cube is owned", not "the cube shows more than 1".

use serde::{Deserialize, Serialize};

use crate::moves::{apply, is_legal, legal_plays};
use crate::position::{BAR, OFF};
use crate::{Board, Dice, DiceRng, Play, Player, Position, RulesError};

/// Largest cube value; a player may not double when the cube already shows it.
pub const MAX_CUBE: u8 = 64;
/// Checkers a side must bear off to win.
const ALL_CHECKERS: u8 = 15;
/// Highest point of the home board (relative numbering).
const HOME_TOP: usize = 6;

/// The doubling cube. JSON: `{ "value": 1, "owner": null }` with `owner`
/// `"white"`, `"black"` or `null` when centred.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cube {
    /// Current stake multiplier (1, 2, 4, … up to [`MAX_CUBE`]).
    pub value: u8,
    /// Who may double next; `None` while the cube is centred.
    pub owner: Option<Player>,
}

impl Cube {
    /// A centred cube at 1.
    #[must_use]
    pub const fn centred() -> Self {
        Self {
            value: 1,
            owner: None,
        }
    }
}

impl Default for Cube {
    fn default() -> Self {
        Self::centred()
    }
}

/// Optional rules in force for a game. JSON:
/// `{ "jacoby": true, "beavers": false, "autoDoubles": false }`.
///
/// `Default` is [`Rules::match_play`] (everything off).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the three flags are a binding wire shape"
)]
pub struct Rules {
    /// Jacoby rule: gammons count single unless a double was offered.
    pub jacoby: bool,
    /// Beavers: the taker may immediately redouble and keep the cube.
    pub beavers: bool,
    /// Automatic doubles: a tied opening roll doubles the stake (once).
    pub auto_doubles: bool,
}

impl Rules {
    /// Money-game defaults: Jacoby on, beavers and automatic doubles off.
    #[must_use]
    pub const fn money() -> Self {
        Self {
            jacoby: true,
            beavers: false,
            auto_doubles: false,
        }
    }

    /// Match-play defaults: everything off.
    #[must_use]
    pub const fn match_play() -> Self {
        Self {
            jacoby: false,
            beavers: false,
            auto_doubles: false,
        }
    }

    /// [`Rules::money`] for `length == 0`, [`Rules::match_play`] otherwise.
    #[must_use]
    pub const fn for_length(length: u8) -> Self {
        if length == 0 {
            Self::money()
        } else {
            Self::match_play()
        }
    }
}

/// Where a game is in its turn cycle. JSON: `"openingRoll"`, `"toRoll"`,
/// `"doubled"`, `"toMove"`, `"finished"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Nobody has rolled yet; [`GameState::opening_roll`] decides who starts.
    OpeningRoll,
    /// The player on roll may double or roll.
    ToRoll,
    /// A double has been offered; the opponent must take or drop.
    Doubled,
    /// Dice are on the board; the player on roll must play.
    ToMove,
    /// The game is over; see [`GameState::result`].
    Finished,
}

/// How a game was won. JSON: `"single"`, `"gammon"`, `"backgammon"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    /// The loser bore off at least one checker (or dropped / resigned one).
    Single,
    /// The loser bore off nothing: twice the cube.
    Gammon,
    /// … and still had a checker on the bar or in the winner's home board:
    /// three times the cube.
    Backgammon,
}

impl ResultKind {
    /// Stake multiplier: 1, 2 or 3.
    #[must_use]
    pub const fn multiplier(self) -> u8 {
        match self {
            Self::Single => 1,
            Self::Gammon => 2,
            Self::Backgammon => 3,
        }
    }
}

/// The outcome of a finished game. JSON:
/// `{ "winner": "white", "kind": "gammon", "points": 4 }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameResult {
    /// The winner.
    pub winner: Player,
    /// Single, gammon or backgammon (after any Jacoby reduction).
    pub kind: ResultKind,
    /// Points won: `kind.multiplier() × cube value`.
    pub points: u8,
}

/// Full state of one game.
///
/// JSON (camelCase): `{ "board": Board, "onRoll": "white"|"black"|null,
/// "dice": Dice|null, "cube": Cube, "phase": Phase, "result": GameResult|null,
/// "rules": Rules }`. The `cube_dead` flag is *not* part of the wire shape;
/// it is owned by [`crate::MatchState`], which restores it from its own
/// `crawford` flag when deserialising.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    /// The checkers, in absolute numbering.
    pub board: Board,
    /// Whose turn it is; `None` before the opening roll and after the game.
    pub on_roll: Option<Player>,
    /// The dice to be played, present only in [`Phase::ToMove`].
    pub dice: Option<Dice>,
    /// The doubling cube.
    pub cube: Cube,
    /// Turn-cycle phase.
    pub phase: Phase,
    /// Set once `phase == Finished`.
    pub result: Option<GameResult>,
    /// Optional rules in force.
    pub rules: Rules,
    /// `true` when no double may be offered in this game (the Crawford
    /// game). Set by [`crate::MatchState`], which derives it from its
    /// `crawford` flag; not on the wire (`#[serde(skip)]`), so a `GameState`
    /// deserialised on its own always has `cube_dead == false` and
    /// [`can_double`](Self::can_double) may return `true` inside a Crawford
    /// game — round-trip a match through [`crate::MatchState`] instead.
    /// Not part of the plan's seven-field `GameState` contract: construct
    /// with [`GameState::new`] rather than a struct literal.
    #[serde(skip)]
    pub cube_dead: bool,
}

impl GameState {
    /// A new game from the opening position, waiting for the opening roll.
    #[must_use]
    pub fn new(rules: Rules) -> Self {
        Self {
            board: Board::opening(),
            on_roll: None,
            dice: None,
            cube: Cube::centred(),
            phase: Phase::OpeningRoll,
            result: None,
            rules,
            cube_dead: false,
        }
    }

    /// The relative position of the player on roll (`None` when nobody is).
    #[must_use]
    pub fn position(&self) -> Option<Position> {
        self.on_roll.map(|p| Position::from_board(&self.board, p))
    }

    /// The opening roll: White and Black each roll one die (White's die is
    /// drawn first); ties are re-rolled (doubling a centred cube once when
    /// `rules.auto_doubles` is on); the higher die's owner is on roll with
    /// both numbers as the dice to play, phase [`Phase::ToMove`].
    ///
    /// Only meaningful in [`Phase::OpeningRoll`]. In any other phase the
    /// state and the generator are left untouched and the current dice (or
    /// `1-1` when there are none) are returned; the signature is binding
    /// and cannot report the misuse.
    pub fn opening_roll(&mut self, rng: &mut DiceRng) -> Dice {
        if self.phase != Phase::OpeningRoll {
            return self.dice.unwrap_or(Dice { hi: 1, lo: 1 });
        }
        let mut auto_doubled = false;
        loop {
            let white = rng.roll_one();
            let black = rng.roll_one();
            if white == black {
                if self.rules.auto_doubles && !auto_doubled {
                    self.cube.value = self.cube.value.saturating_mul(2).min(MAX_CUBE);
                    auto_doubled = true;
                }
                continue;
            }
            let dice = Dice {
                hi: white.max(black),
                lo: white.min(black),
            };
            self.on_roll = Some(if white > black {
                Player::White
            } else {
                Player::Black
            });
            self.dice = Some(dice);
            self.phase = Phase::ToMove;
            return dice;
        }
    }

    /// Rolls for the player on roll: [`Phase::ToRoll`] → [`Phase::ToMove`].
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `ToRoll`.
    pub fn roll(&mut self, rng: &mut DiceRng) -> Result<Dice, RulesError> {
        if self.phase != Phase::ToRoll {
            return Err(RulesError::WrongPhase(
                "roll: the game is not waiting for a roll",
            ));
        }
        let dice = rng.roll();
        self.dice = Some(dice);
        self.phase = Phase::ToMove;
        Ok(dice)
    }

    /// The legal plays for the dice on the board, in canonical order; empty
    /// when the phase is not [`Phase::ToMove`] **or when no checker can
    /// move** (the caller then passes `Play::empty()` to [`GameState::play`]).
    #[must_use]
    pub fn legal_plays(&self) -> Vec<Play> {
        let (Phase::ToMove, Some(pos), Some(dice)) = (self.phase, self.position(), self.dice)
        else {
            return Vec::new();
        };
        let plays = legal_plays(&pos, dice);
        if plays.len() == 1 && plays[0].is_empty() {
            return Vec::new();
        }
        plays
    }

    /// Plays `play` for the player on roll. The play must be legal for the
    /// dice on the board (`Play::empty()` when nothing can move). Detects
    /// the end of the game; otherwise hands the turn to the opponent
    /// ([`Phase::ToRoll`]).
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `ToMove`;
    /// [`RulesError::IllegalPlay`] when the play is not legal.
    pub fn play(&mut self, play: &Play) -> Result<(), RulesError> {
        let (Phase::ToMove, Some(on_roll), Some(dice)) = (self.phase, self.on_roll, self.dice)
        else {
            return Err(RulesError::WrongPhase(
                "play: the game is not waiting for a play",
            ));
        };
        let pos = Position::from_board(&self.board, on_roll);
        if !is_legal(&pos, dice, play) {
            return Err(RulesError::IllegalPlay(format!(
                "{play:?} ({play}) is not a legal play of {}-{}",
                dice.hi, dice.lo
            )));
        }
        let next = apply(&pos, play)?;
        self.board = next.to_board(on_roll);
        self.dice = None;
        if next.mine[OFF] == ALL_CHECKERS {
            self.finish(on_roll, result_kind_on_board(&next));
        } else {
            self.on_roll = Some(on_roll.opponent());
            self.phase = Phase::ToRoll;
        }
        Ok(())
    }

    /// `true` when the player on roll may double now: phase
    /// [`Phase::ToRoll`], cube centred or owned by him, cube not dead
    /// (Crawford) and below [`MAX_CUBE`].
    #[must_use]
    pub fn can_double(&self) -> bool {
        self.double_check().is_ok()
    }

    /// The reason a double is not possible right now, if any.
    fn double_check(&self) -> Result<(), RulesError> {
        let Some(on_roll) = self.on_roll else {
            return Err(RulesError::WrongPhase("double: nobody is on roll"));
        };
        if self.phase != Phase::ToRoll {
            return Err(RulesError::WrongPhase(
                "double: only at the start of one's own turn, before rolling",
            ));
        }
        if self.cube_dead {
            return Err(RulesError::NotAllowed(
                "the cube is out of play in the Crawford game",
            ));
        }
        if self.cube.owner.is_some_and(|owner| owner != on_roll) {
            return Err(RulesError::NotAllowed("the cube is owned by the opponent"));
        }
        if self.cube.value >= MAX_CUBE {
            return Err(RulesError::NotAllowed("the cube is at its maximum"));
        }
        Ok(())
    }

    /// Offers a double: [`Phase::ToRoll`] → [`Phase::Doubled`]. The cube is
    /// turned only when the opponent takes.
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `ToRoll`;
    /// [`RulesError::NotAllowed`] when the cube is dead, owned by the
    /// opponent or at its maximum.
    pub fn double(&mut self) -> Result<(), RulesError> {
        self.double_check()?;
        self.phase = Phase::Doubled;
        Ok(())
    }

    /// Accepts the pending double: the cube doubles and passes to the taker,
    /// the doubler rolls ([`Phase::ToRoll`]).
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `Doubled`.
    pub fn take(&mut self) -> Result<(), RulesError> {
        let (doubler, taker) = self.pending_double("take: no double is pending")?;
        self.cube = Cube {
            value: self.cube.value.saturating_mul(2).min(MAX_CUBE),
            owner: Some(taker),
        };
        self.on_roll = Some(doubler);
        self.phase = Phase::ToRoll;
        Ok(())
    }

    /// Beavers the pending double: the taker redoubles at once (cube × 4)
    /// and keeps the cube; the original doubler rolls. Like any redouble it
    /// is refused, rather than clamped, when it would take the cube past
    /// [`MAX_CUBE`]; the taker can still [`take`](Self::take).
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `Doubled`;
    /// [`RulesError::NotAllowed`] unless `rules.beavers` is on, or when
    /// cube × 4 would exceed [`MAX_CUBE`].
    pub fn beaver(&mut self) -> Result<(), RulesError> {
        let (doubler, taker) = self.pending_double("beaver: no double is pending")?;
        if !self.rules.beavers {
            return Err(RulesError::NotAllowed("beavers are not allowed"));
        }
        let value = self.cube.value.saturating_mul(4);
        if value > MAX_CUBE {
            return Err(RulesError::NotAllowed(
                "a beaver would take the cube past its maximum",
            ));
        }
        self.cube = Cube {
            value,
            owner: Some(taker),
        };
        self.on_roll = Some(doubler);
        self.phase = Phase::ToRoll;
        Ok(())
    }

    /// Declines the pending double: the doubler wins the current cube value
    /// as a single game.
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] unless the phase is `Doubled`.
    pub fn drop(&mut self) -> Result<(), RulesError> {
        let (doubler, _) = self.pending_double("drop: no double is pending")?;
        self.finish_with(doubler, ResultKind::Single, self.cube.value);
        Ok(())
    }

    /// The player on roll concedes the game as `kind` (single, gammon or
    /// backgammon); the opponent wins `kind × cube`, subject to the Jacoby
    /// reduction like any other result.
    ///
    /// # Errors
    ///
    /// [`RulesError::WrongPhase`] before the opening roll or after the game.
    pub fn resign(&mut self, kind: ResultKind) -> Result<(), RulesError> {
        let Some(resigner) = self
            .on_roll
            .filter(|_| matches!(self.phase, Phase::ToRoll | Phase::Doubled | Phase::ToMove))
        else {
            return Err(RulesError::WrongPhase(
                "resign: only during a game that is in progress",
            ));
        };
        self.finish(resigner.opponent(), kind);
        Ok(())
    }

    /// `(doubler, taker)` while a double is pending; `WrongPhase(no_double)`
    /// otherwise.
    fn pending_double(&self, no_double: &'static str) -> Result<(Player, Player), RulesError> {
        match (self.phase, self.on_roll) {
            (Phase::Doubled, Some(doubler)) => Ok((doubler, doubler.opponent())),
            _ => Err(RulesError::WrongPhase(no_double)),
        }
    }

    /// Ends the game for `winner` with the kind found on the board (or
    /// conceded), applying the Jacoby reduction and the cube.
    fn finish(&mut self, winner: Player, kind: ResultKind) {
        let kind = if self.rules.jacoby && self.cube.owner.is_none() {
            ResultKind::Single
        } else {
            kind
        };
        let points = kind.multiplier().saturating_mul(self.cube.value);
        self.finish_with(winner, kind, points);
    }

    fn finish_with(&mut self, winner: Player, kind: ResultKind, points: u8) {
        self.result = Some(GameResult {
            winner,
            kind,
            points,
        });
        self.on_roll = None;
        self.dice = None;
        self.phase = Phase::Finished;
    }
}

/// Single, gammon or backgammon, judged from the winner's relative position
/// after the final move: the loser has nothing off → gammon; and a checker on
/// the bar or in the winner's home board (my points 1–6) → backgammon.
fn result_kind_on_board(winner: &Position) -> ResultKind {
    if winner.theirs[OFF] > 0 {
        return ResultKind::Single;
    }
    let in_my_home = winner.theirs[1..=HOME_TOP].iter().any(|&n| n > 0);
    if winner.theirs[BAR] > 0 || in_my_home {
        ResultKind::Backgammon
    } else {
        ResultKind::Gammon
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(mine_off: u8, theirs: &[(usize, u8)]) -> Position {
        let mut p = Position {
            mine: [0; 26],
            theirs: [0; 26],
        };
        p.mine[OFF] = mine_off;
        for &(i, n) in theirs {
            p.theirs[i] = n;
        }
        p
    }

    #[test]
    fn result_kind_from_the_winners_position() {
        assert_eq!(
            result_kind_on_board(&pos(15, &[(OFF, 1), (20, 14)])),
            ResultKind::Single
        );
        assert_eq!(
            result_kind_on_board(&pos(15, &[(20, 15)])),
            ResultKind::Gammon
        );
        assert_eq!(
            result_kind_on_board(&pos(15, &[(20, 14), (BAR, 1)])),
            ResultKind::Backgammon
        );
        assert_eq!(
            result_kind_on_board(&pos(15, &[(20, 14), (6, 1)])),
            ResultKind::Backgammon
        );
        assert_eq!(
            result_kind_on_board(&pos(15, &[(20, 14), (7, 1)])),
            ResultKind::Gammon
        );
    }

    #[test]
    fn multipliers() {
        assert_eq!(ResultKind::Single.multiplier(), 1);
        assert_eq!(ResultKind::Gammon.multiplier(), 2);
        assert_eq!(ResultKind::Backgammon.multiplier(), 3);
    }
}
