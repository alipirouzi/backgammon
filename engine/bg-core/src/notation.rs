//! Standard backgammon notation for plays, relative to the mover.
//!
//! Conventions (binding, see the engine plan):
//!
//! * moves are separated by single spaces and written `from/to`;
//! * `bar/` stands for `from = 25`, `/off` for `to = 0`;
//! * `*` after a move marks a hit;
//! * identical consecutive moves are collapsed as `13/7(2)`; a hitting group
//!   is collapsed (`13/7*(2)`) only when every move in it hits;
//! * the empty play (no legal move) is the empty string.
//!
//! Examples: `24/18 13/10`, `bar/22* 6/2`, `8/4(2) 6/2(2)`, `6/off 5/off`.
//!
//! This module also owns the JSON representation of [`Play`]:
//! `{ "moves": [Move, ...], "notation": "24/18 13/10" }`. Serialisation
//! always emits `notation`; deserialisation requires `moves` and, when
//! `notation` is present and non-null, checks that it describes the same
//! moves.

use core::fmt;
use core::str::FromStr;

use serde::de::Error as _;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{Move, Play, RulesError};

/// `Move::from` value that denotes the bar.
const BAR_FROM: u8 = 25;
/// `Move::to` value that denotes bearing off.
const OFF_TO: u8 = 0;
/// A play never contains more moves than four (doubles).
const MAX_MOVES: usize = 4;
/// A single move never covers more pips than the largest die.
const MAX_DISTANCE: u8 = 6;

/// Formats a single move: `24/18`, `bar/22*`, `6/off`.
impl fmt::Display for Move {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.from == BAR_FROM {
            f.write_str("bar")?;
        } else {
            write!(f, "{}", self.from)?;
        }
        f.write_str("/")?;
        if self.to == OFF_TO {
            f.write_str("off")?;
        } else {
            write!(f, "{}", self.to)?;
        }
        if self.hit {
            f.write_str("*")?;
        }
        Ok(())
    }
}

/// Formats a play in standard notation, collapsing identical consecutive
/// moves as `13/7(2)`. Moves are written in the order stored; the empty play
/// formats as the empty string.
impl fmt::Display for Play {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut rest = self.moves.as_slice();
        let mut first = true;
        while let Some(head) = rest.first() {
            let run = rest.iter().take_while(|m| *m == head).count();
            if !first {
                f.write_str(" ")?;
            }
            write!(f, "{head}")?;
            if run > 1 {
                write!(f, "({run})")?;
            }
            rest = &rest[run..];
            first = false;
        }
        Ok(())
    }
}

/// Parses a play written in standard notation.
///
/// Accepts everything [`Display`](fmt::Display) produces, plus: arbitrary
/// whitespace between moves (leading/trailing included), `bar`/`off` in any
/// letter case, and an explicit `(1)` count. Collapsed groups are expanded
/// into repeated moves, so `parse_play(&play.to_string()) == play` for every
/// play.
///
/// Structural checks reject tokens that no legal move can produce: a `from`
/// outside `1..=24` or `bar`, a `to` outside `1..=24` or `off`, a move that
/// does not go forward by 1–6 pips, a hit while bearing off, a group count
/// outside `1..=4`, or more than four moves in total. Legality against a
/// position is *not* checked here; that is `moves::is_legal`'s job.
///
/// # Errors
///
/// Returns [`RulesError::Parse`] describing the offending token.
pub fn parse_play(s: &str) -> Result<Play, RulesError> {
    let mut moves: Vec<Move> = Vec::new();
    for token in s.split_whitespace() {
        let (mv, count) = parse_token(token)?;
        if moves.len() + count > MAX_MOVES {
            return Err(parse_error(format!("more than {MAX_MOVES} moves in {s:?}")));
        }
        moves.extend(core::iter::repeat_n(mv, count));
    }
    Ok(Play { moves })
}

/// `"24/18 13/10".parse::<Play>()`; see [`parse_play`].
impl FromStr for Play {
    type Err = RulesError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        parse_play(s)
    }
}

fn parse_error(msg: String) -> RulesError {
    RulesError::Parse(msg)
}

/// Parses one token such as `13/7*(2)` into its move and repeat count.
fn parse_token(token: &str) -> Result<(Move, usize), RulesError> {
    let (body, count) = split_count(token)?;
    let (body, hit) = match body.strip_suffix('*') {
        Some(stripped) => (stripped, true),
        None => (body, false),
    };
    let (from_text, to_text) = body
        .split_once('/')
        .ok_or_else(|| parse_error(format!("expected from/to in {token:?}")))?;
    let from = parse_from(from_text, token)?;
    let to = parse_to(to_text, token)?;

    if to >= from {
        return Err(parse_error(format!("move {token:?} does not go forward")));
    }
    if from - to > MAX_DISTANCE {
        return Err(parse_error(format!(
            "move {token:?} covers more than {MAX_DISTANCE} pips"
        )));
    }
    if hit && to == OFF_TO {
        return Err(parse_error(format!(
            "move {token:?} cannot hit while bearing off"
        )));
    }
    Ok((Move { from, to, hit }, count))
}

/// Splits an optional trailing `(n)` off a token, validating `1 <= n <= 4`.
fn split_count(token: &str) -> Result<(&str, usize), RulesError> {
    let Some(open) = token.find('(') else {
        return Ok((token, 1));
    };
    let inner = token[open..]
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
        .ok_or_else(|| parse_error(format!("malformed count in {token:?}")))?;
    let count: usize = inner
        .parse()
        .map_err(|_| parse_error(format!("malformed count in {token:?}")))?;
    if !(1..=MAX_MOVES).contains(&count) {
        return Err(parse_error(format!(
            "count in {token:?} must be 1..={MAX_MOVES}"
        )));
    }
    Ok((&token[..open], count))
}

fn parse_from(text: &str, token: &str) -> Result<u8, RulesError> {
    if text.eq_ignore_ascii_case("bar") {
        return Ok(BAR_FROM);
    }
    parse_point(text)
        .filter(|p| (1..=24).contains(p))
        .ok_or_else(|| parse_error(format!("bad source point in {token:?}")))
}

fn parse_to(text: &str, token: &str) -> Result<u8, RulesError> {
    if text.eq_ignore_ascii_case("off") {
        return Ok(OFF_TO);
    }
    parse_point(text)
        .filter(|p| (1..=24).contains(p))
        .ok_or_else(|| parse_error(format!("bad destination point in {token:?}")))
}

/// Parses a plain decimal point number; `None` for anything else.
fn parse_point(text: &str) -> Option<u8> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Emits `{ "moves": [...], "notation": "..." }`.
impl Serialize for Play {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("Play", 2)?;
        state.serialize_field("moves", &self.moves)?;
        state.serialize_field("notation", &self.to_string())?;
        state.end()
    }
}

/// Wire shape accepted for a play: `moves` is required, `notation` optional.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlay {
    moves: Vec<Move>,
    #[serde(default)]
    notation: Option<String>,
}

/// Accepts `{ "moves": [...] }` with an optional `notation`; when `notation`
/// is present and non-null it must parse to exactly the given moves.
impl<'de> Deserialize<'de> for Play {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawPlay::deserialize(deserializer)?;
        let play = Play { moves: raw.moves };
        if let Some(notation) = raw.notation {
            let parsed = parse_play(&notation).map_err(D::Error::custom)?;
            if parsed != play {
                return Err(D::Error::custom(format!(
                    "notation {notation:?} does not match moves ({play})"
                )));
            }
        }
        Ok(play)
    }
}
