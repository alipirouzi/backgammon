//! Match state: score, Crawford / post-Crawford, game succession.
//!
//! A match to `length` points ends as soon as a player's score reaches
//! `length`. When a player first reaches `length − 1` the next game is the
//! Crawford game, in which the cube is out of play (USBGF Ruling Guide
//! §4.4.8); every later game is post-Crawford with the cube back in play.
//! `length == 0` denotes a money / single game: the first finished game
//! decides it and its points are recorded in `score`.
//!
//! JSON: `{ "length": 7, "score": { "white": 3, "black": 1 }, "crawford":
//! false, "postCrawford": false, "game": GameState }`.

use serde::{Deserialize, Serialize};

use crate::Player;
use crate::game::{GameState, Phase, Rules};

/// Index of `p` in a `[u8; 2]` score (White first).
const fn index(p: Player) -> usize {
    match p {
        Player::White => 0,
        Player::Black => 1,
    }
}

/// A match (or a single money game when `length == 0`) and its current game.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(into = "Wire", from = "Wire")]
pub struct MatchState {
    /// Points needed to win; `0` for a money / single game.
    pub length: u8,
    /// Points so far, `[white, black]`.
    pub score: [u8; 2],
    /// `true` while the Crawford game is being played (cube out of play).
    pub crawford: bool,
    /// `true` once the Crawford game has been played.
    pub post_crawford: bool,
    /// The game in progress (or the last game once the match is over).
    pub game: GameState,
}

impl MatchState {
    /// A new match at 0–0 with a fresh game awaiting its opening roll. Every
    /// game of the match uses `seed_game_rules`.
    #[must_use]
    pub fn new(length: u8, seed_game_rules: Rules) -> Self {
        Self {
            length,
            score: [0, 0],
            crawford: false,
            post_crawford: false,
            game: GameState::new(seed_game_rules),
        }
    }

    /// Points `p` has scored.
    #[must_use]
    pub const fn score_of(&self, p: Player) -> u8 {
        self.score[index(p)]
    }

    /// Points `p` still needs (`0` in a money game or once he has won).
    #[must_use]
    pub const fn away(&self, p: Player) -> u8 {
        self.length.saturating_sub(self.score_of(p))
    }

    /// `false` during the Crawford game, `true` otherwise.
    #[must_use]
    pub const fn cube_allowed(&self) -> bool {
        !self.crawford
    }

    /// `true` once a player has reached `length` (or, in a money game, once
    /// the game is finished).
    #[must_use]
    pub fn is_over(&self) -> bool {
        if self.length == 0 {
            self.game.phase == Phase::Finished
        } else {
            self.score.iter().any(|&s| s >= self.length)
        }
    }

    /// Applies the finished game's result to the score, updates the
    /// Crawford flags and starts the next game. Returns `Some(winner)` when
    /// the match is over (the finished game is kept as `game`), `None` when
    /// a new game has started.
    ///
    /// Does nothing and returns `None` when the current game is not
    /// finished. Idempotent once the match is over: further calls return
    /// `Some(winner)` without touching the score again.
    pub fn finish_game(&mut self) -> Option<Player> {
        let (Phase::Finished, Some(result)) = (self.game.phase, self.game.result) else {
            return None;
        };
        let winner = result.winner;
        if self.already_scored() {
            return Some(winner);
        }
        let i = index(winner);
        self.score[i] = self.score[i].saturating_add(result.points);
        if self.length == 0 || self.score[i] >= self.length {
            return Some(winner);
        }
        if self.crawford {
            self.crawford = false;
            self.post_crawford = true;
        } else if !self.post_crawford && self.away(winner) == 1 {
            self.crawford = true;
        }
        self.game = GameState::new(self.game.rules);
        self.game.cube_dead = self.crawford;
        None
    }
}

impl MatchState {
    /// `true` when the finished game's points are already on the score
    /// board: the match is won, or (money game) the single game has been
    /// scored.
    fn already_scored(&self) -> bool {
        if self.length == 0 {
            self.score != [0, 0]
        } else {
            self.score.iter().any(|&s| s >= self.length)
        }
    }
}

/// Wire form: the score is an object keyed by player.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    length: u8,
    score: Score,
    crawford: bool,
    post_crawford: bool,
    game: GameState,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Score {
    white: u8,
    black: u8,
}

impl From<MatchState> for Wire {
    fn from(m: MatchState) -> Self {
        Self {
            length: m.length,
            score: Score {
                white: m.score[0],
                black: m.score[1],
            },
            crawford: m.crawford,
            post_crawford: m.post_crawford,
            game: m.game,
        }
    }
}

impl From<Wire> for MatchState {
    fn from(w: Wire) -> Self {
        let mut game = w.game;
        // `cube_dead` is not on the wire; the Crawford flag is its source.
        game.cube_dead = w.crawford;
        Self {
            length: w.length,
            score: [w.score.white, w.score.black],
            crawford: w.crawford,
            post_crawford: w.post_crawford,
            game,
        }
    }
}
