//! The binding API as plain Rust: every function takes JSON strings and
//! returns a JSON string, or an error message. `bg-wasm` wraps these with
//! `wasm-bindgen` on `wasm32` and `bg-node` wraps the same functions with
//! `napi`, so both bindings share one marshalling layer and cannot drift.
//!
//! # Argument forms
//!
//! Every argument is JSON as produced by the engine's serde impls (see the
//! JSON shapes in `bg-core` and `bg-bot`). Two leniencies make callers'
//! lives easier and are part of the contract:
//!
//! - **Text arguments** (`on_roll`, `level`, a notation) may be a JSON
//!   string (`"white"`) or the bare text (`white`). Anything that does not
//!   parse as a JSON string is taken verbatim.
//! - **`seed`** is a `u64` given as a JSON number (`12`) or as a numeric
//!   string (`"12"`); it must not exceed [`MAX_SEED`] (2^53 − 1) so that it
//!   round-trips through `JSON.parse` on the JavaScript side. Negative,
//!   fractional and larger values are rejected.
//!
//! `play` in [`apply_play_json`] is either a `Play` object
//! (`{ "moves": [...], "notation": "..." }`, `notation` optional but
//! cross-checked against `moves` when present) or a notation string.
//!
//! Boards are validated on the way in ([`Board::validate`]); an invalid board
//! is an error, never a panic.

use bg_bot::{Bot, Candidate, Level, MatchContext};
use bg_core::moves::{apply, legal_plays};
use bg_core::record::MAX_SEED;
use bg_core::{Board, Dice, Play, Player, Position, Record, parse_play, replay};
use serde::Serialize;
use serde_json::Value;

/// Result of the JSON functions: a JSON document, or a human-readable error.
pub type JsonResult = Result<String, String>;

/// Output of [`choose_play_json`]: `{ "play": Play, "candidates": [Candidate] }`.
#[derive(Serialize)]
struct ChosenPlay {
    play: Play,
    candidates: Vec<Candidate>,
}

/// The standard opening position as a `Board` JSON document.
///
/// # Errors
///
/// Never in practice; serialising a fixed-size struct of integers cannot
/// fail. The `Result` keeps the signature uniform with the other functions.
pub fn opening_board_json() -> JsonResult {
    to_json(&Board::opening())
}

/// Every legal play for `dice` on `board` as seen by `on_roll`, in the
/// engine's canonical order, as a JSON array of `Play` objects
/// (`{ "moves": [...], "notation": "..." }`). A roll with no legal move
/// yields a single empty play (`{ "moves": [], "notation": "" }`).
///
/// # Errors
///
/// Malformed JSON, an invalid board, an unknown player or dice outside
/// `1..=6`.
pub fn legal_plays_json(board: &str, on_roll: &str, dice: &str) -> JsonResult {
    let pos = parse_position(board, on_roll)?;
    let dice = parse_dice(dice)?;
    to_json(&legal_plays(&pos, dice))
}

/// Applies `play` (a `Play` object or a notation string, relative to
/// `on_roll`) to `board` and returns the resulting `Board` JSON. The dice are
/// not known here, so the play is checked structurally (sources occupied,
/// bar first, destinations open, hits marked, bear-off only with every
/// checker home) but not against a roll; use [`legal_plays_json`] for that.
///
/// # Errors
///
/// Malformed JSON, an invalid board, an unknown player, a play whose
/// `notation` does not match its `moves`, or a play that cannot be made from
/// this position.
pub fn apply_play_json(board: &str, on_roll: &str, play: &str) -> JsonResult {
    let player = parse_player(on_roll)?;
    let pos = parse_position(board, on_roll)?;
    let play = parse_play_arg(play)?;
    let after = apply(&pos, &play).map_err(|e| e.to_string())?;
    to_json(&after.to_board(player))
}

/// The bot's move for `dice` on `board` as seen by `on_roll`, at `level`
/// (`"beginner"`, `"intermediate"` or `"club"`), deciding with `seed`:
/// `{ "play": Play, "candidates": [Candidate] }` where `play` equals
/// `candidates[0].play` and the candidates are every legal play in the bot's
/// ranking, best first.
///
/// # Errors
///
/// Malformed JSON, an invalid board, an unknown player or level, bad dice,
/// a malformed match context or a seed outside `0..=2^53-1`.
pub fn choose_play_json(
    board: &str,
    on_roll: &str,
    dice: &str,
    match_ctx: &str,
    level: &str,
    seed: &str,
) -> JsonResult {
    let pos = parse_position(board, on_roll)?;
    let dice = parse_dice(dice)?;
    let ctx = parse_match_ctx(match_ctx)?;
    let level = parse_level(level)?;
    let seed = parse_seed(seed)?;
    let (play, candidates) = Bot::new(level).choose_play(&ctx, &pos, dice, seed);
    to_json(&ChosenPlay { play, candidates })
}

/// Cube decision for `on_roll` before rolling on `board` in `match_ctx`, as a
/// `CubeAnalysis` JSON document. `level` is validated for uniformity; the
/// cube decision always uses the club evaluator.
///
/// # Errors
///
/// Malformed JSON, an invalid board, an unknown player or level, or a
/// malformed match context.
pub fn cube_action_json(board: &str, on_roll: &str, match_ctx: &str, level: &str) -> JsonResult {
    let pos = parse_position(board, on_roll)?;
    let ctx = parse_match_ctx(match_ctx)?;
    let level = parse_level(level)?;
    to_json(&Bot::new(level).cube_action(&ctx, &pos))
}

/// Analyses the play `played` (a notation string relative to `on_roll`) for
/// `dice` on `board` in `match_ctx` against every legal play, with the club
/// parameters and `seed`, as a `MoveAnalysis` JSON document.
///
/// # Errors
///
/// Malformed JSON, an invalid board, an unknown player, bad dice, a
/// malformed match context, a notation that does not parse, or a seed
/// outside `0..=2^53-1`.
pub fn analyze_play_json(
    board: &str,
    on_roll: &str,
    dice: &str,
    match_ctx: &str,
    played: &str,
    seed: &str,
) -> JsonResult {
    let pos = parse_position(board, on_roll)?;
    let dice = parse_dice(dice)?;
    let ctx = parse_match_ctx(match_ctx)?;
    let played = parse_play(&text_arg(played)).map_err(|e| e.to_string())?;
    let seed = parse_seed(seed)?;
    to_json(&Bot::default().analyze_play(&ctx, &pos, dice, &played, seed))
}

/// Replays a `Record` JSON document from its seed and returns the resulting
/// `MatchState` JSON.
///
/// # Errors
///
/// Malformed JSON, or any replay error from the rules engine (a seed above
/// 2^53 − 1, a logged roll that disagrees with the seed, an action that is
/// not legal where it appears).
pub fn replay_json(record: &str) -> JsonResult {
    let record: Record = from_json("record", record)?;
    let state = replay(&record).map_err(|e| e.to_string())?;
    to_json(&state)
}

fn to_json<T: Serialize>(value: &T) -> JsonResult {
    serde_json::to_string(value).map_err(|e| format!("cannot serialise result: {e}"))
}

fn from_json<T: serde::de::DeserializeOwned>(what: &str, text: &str) -> Result<T, String> {
    serde_json::from_str(text).map_err(|e| format!("invalid {what}: {e}"))
}

/// A JSON string's contents, or the input verbatim when it is not one.
fn text_arg(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::String(s)) => s,
        _ => text.trim().to_owned(),
    }
}

fn parse_player(on_roll: &str) -> Result<Player, String> {
    let text = text_arg(on_roll);
    from_json("player", &format!("\"{text}\""))
        .map_err(|_| format!("invalid player {text:?}: expected \"white\" or \"black\""))
}

fn parse_level(level: &str) -> Result<Level, String> {
    let text = text_arg(level);
    from_json("level", &format!("\"{text}\"")).map_err(|_| {
        format!("invalid level {text:?}: expected \"beginner\", \"intermediate\" or \"club\"")
    })
}

fn parse_position(board: &str, on_roll: &str) -> Result<Position, String> {
    let board: Board = from_json("board", board)?;
    board.validate().map_err(|e| e.to_string())?;
    let player = parse_player(on_roll)?;
    Ok(Position::from_board(&board, player))
}

fn parse_dice(dice: &str) -> Result<Dice, String> {
    from_json("dice", dice)
}

fn parse_match_ctx(match_ctx: &str) -> Result<MatchContext, String> {
    from_json("match context", match_ctx)
}

/// A `Play` from a JSON object or a notation string (JSON-quoted or bare).
fn parse_play_arg(play: &str) -> Result<Play, String> {
    match serde_json::from_str::<Value>(play) {
        Ok(Value::Object(_)) => from_json("play", play),
        Ok(Value::String(notation)) => parse_play(&notation).map_err(|e| e.to_string()),
        Ok(other) => Err(format!(
            "invalid play: expected a Play object or a notation string, got {other}"
        )),
        Err(_) => parse_play(play.trim()).map_err(|e| e.to_string()),
    }
}

/// A seed from a JSON number or a numeric string, at most [`MAX_SEED`].
fn parse_seed(seed: &str) -> Result<u64, String> {
    let value = match serde_json::from_str::<Value>(seed) {
        Ok(Value::Number(n)) => n.as_u64(),
        Ok(Value::String(s)) => s.trim().parse().ok(),
        Ok(_) => None,
        Err(_) => seed.trim().parse().ok(),
    };
    match value {
        Some(n) if n <= MAX_SEED => Ok(n),
        Some(n) => Err(format!(
            "invalid seed {n}: must not exceed {MAX_SEED} (2^53 - 1)"
        )),
        None => Err(format!(
            "invalid seed {seed:?}: expected a non-negative integer up to {MAX_SEED}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENING: &str = r#"{"white":[0,0,0,0,0,0,5,0,3,0,0,0,0,5,0,0,0,0,0,0,0,0,0,0,2,0],"black":[0,2,0,0,0,0,0,0,0,0,0,0,5,0,0,0,0,3,0,5,0,0,0,0,0,0]}"#;
    const MONEY: &str = r#"{"length":0,"myAway":0,"theirAway":0,"crawford":false,"postCrawford":false,"cube":1,"cubeOwnerIsMe":null}"#;

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn opening_board_matches_bg_core() {
        assert_eq!(json(&opening_board_json().unwrap()), json(OPENING));
    }

    #[test]
    fn legal_plays_serialises_moves_and_notation() {
        let out = json(&legal_plays_json(OPENING, "\"white\"", r#"{"hi":3,"lo":1}"#).unwrap());
        let plays = out.as_array().unwrap();
        assert!(plays.iter().any(|p| p["notation"] == "8/5 6/5"));
        let p = &plays[0];
        assert!(p["moves"].is_array());
        assert!(p["moves"][0]["from"].is_number());
        assert!(p["moves"][0]["hit"].is_boolean());
    }

    #[test]
    fn text_arguments_accept_json_strings_and_bare_text() {
        let quoted = legal_plays_json(OPENING, "\"black\"", r#"{"hi":6,"lo":5}"#).unwrap();
        let bare = legal_plays_json(OPENING, "black", r#"{"hi":6,"lo":5}"#).unwrap();
        assert_eq!(quoted, bare);
        assert!(
            json(&quoted)
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["notation"] == "24/18 18/13")
        );
    }

    #[test]
    fn rejects_bad_inputs_with_messages() {
        assert!(
            legal_plays_json("{", "white", r#"{"hi":3,"lo":1}"#)
                .unwrap_err()
                .starts_with("invalid board")
        );
        assert!(
            legal_plays_json(OPENING, "red", r#"{"hi":3,"lo":1}"#)
                .unwrap_err()
                .contains("invalid player")
        );
        assert!(
            legal_plays_json(OPENING, "white", r#"{"hi":7,"lo":1}"#)
                .unwrap_err()
                .starts_with("invalid dice")
        );
        let broken = OPENING.replacen("5,0,3", "9,0,3", 1);
        assert!(
            legal_plays_json(&broken, "white", r#"{"hi":3,"lo":1}"#)
                .unwrap_err()
                .starts_with("invalid board")
        );
        assert!(
            choose_play_json(OPENING, "white", r#"{"hi":3,"lo":1}"#, MONEY, "expert", "1")
                .unwrap_err()
                .contains("invalid level")
        );
        assert!(
            choose_play_json(OPENING, "white", r#"{"hi":3,"lo":1}"#, "{}", "club", "1")
                .unwrap_err()
                .starts_with("invalid match context")
        );
    }

    #[test]
    fn apply_play_accepts_object_and_notation() {
        let by_notation = apply_play_json(OPENING, "white", "\"8/5 6/5\"").unwrap();
        let bare = apply_play_json(OPENING, "white", "8/5 6/5").unwrap();
        let by_object = apply_play_json(
            OPENING,
            "white",
            r#"{"moves":[{"from":8,"to":5,"hit":false},{"from":6,"to":5,"hit":false}],"notation":"8/5 6/5"}"#,
        )
        .unwrap();
        assert_eq!(by_notation, bare);
        assert_eq!(by_notation, by_object);
        let board = json(&by_notation);
        assert_eq!(board["white"][5], 2);
        assert_eq!(board["white"][8], 2);
        assert_eq!(board["white"][6], 4);
    }

    #[test]
    fn apply_play_black_uses_black_relative_notation() {
        let board = json(&apply_play_json(OPENING, "black", "24/18 13/10").unwrap());
        // Black's 24 is absolute point 1, Black's 18 is absolute 7, 13 -> 12, 10 -> 15.
        assert_eq!(board["black"][1], 1);
        assert_eq!(board["black"][7], 1);
        assert_eq!(board["black"][12], 4);
        assert_eq!(board["black"][15], 1);
        assert_eq!(board["white"], json(OPENING)["white"]);
    }

    #[test]
    fn apply_play_rejects_mismatched_notation_and_impossible_plays() {
        let err = apply_play_json(
            OPENING,
            "white",
            r#"{"moves":[{"from":8,"to":5,"hit":false}],"notation":"6/5"}"#,
        )
        .unwrap_err();
        assert!(err.contains("does not match"), "{err}");
        let err = apply_play_json(OPENING, "white", "6/off").unwrap_err();
        assert!(err.starts_with("illegal play"), "{err}");
        let err = apply_play_json(OPENING, "white", "42").unwrap_err();
        assert!(err.starts_with("invalid play"), "{err}");
    }

    #[test]
    fn empty_play_leaves_the_board_unchanged() {
        assert_eq!(
            json(&apply_play_json(OPENING, "white", "\"\"").unwrap()),
            json(OPENING)
        );
        assert_eq!(
            json(&apply_play_json(OPENING, "white", "").unwrap()),
            json(OPENING)
        );
    }

    #[test]
    fn seeds_accept_numbers_and_numeric_strings_within_the_safe_range() {
        assert_eq!(parse_seed("12").unwrap(), 12);
        assert_eq!(parse_seed("\"12\"").unwrap(), 12);
        assert_eq!(parse_seed(" 12 ").unwrap(), 12);
        assert_eq!(parse_seed("9007199254740991").unwrap(), MAX_SEED);
        assert!(parse_seed("9007199254740992").unwrap_err().contains("2^53"));
        assert!(parse_seed("-1").unwrap_err().contains("invalid seed"));
        assert!(parse_seed("1.5").unwrap_err().contains("invalid seed"));
        assert!(parse_seed("null").unwrap_err().contains("invalid seed"));
        assert!(parse_seed("abc").unwrap_err().contains("invalid seed"));
    }

    #[test]
    fn choose_play_returns_the_head_candidate_as_play() {
        let out = json(
            &choose_play_json(
                OPENING,
                "white",
                r#"{"hi":3,"lo":1}"#,
                MONEY,
                "intermediate",
                "1",
            )
            .unwrap(),
        );
        assert_eq!(out["play"], out["candidates"][0]["play"]);
        assert_eq!(out["play"]["notation"], "8/5 6/5");
        let c = &out["candidates"][0];
        assert!(c["equity"].is_number());
        assert!(c["probs"]["win"].is_number());
        assert!(c["rollout"].is_null());
    }

    #[test]
    fn choose_play_is_deterministic_for_a_seed() {
        let a = choose_play_json(
            OPENING,
            "white",
            r#"{"hi":2,"lo":1}"#,
            MONEY,
            "beginner",
            "5",
        )
        .unwrap();
        let b = choose_play_json(
            OPENING,
            "white",
            r#"{"hi":2,"lo":1}"#,
            MONEY,
            "beginner",
            "\"5\"",
        )
        .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn cube_action_serialises_can_double() {
        let out = json(&cube_action_json(OPENING, "white", MONEY, "club").unwrap());
        let actions = [
            "noDouble",
            "doubleTake",
            "doubleDrop",
            "tooGood",
            "redoubleTake",
            "redoubleDrop",
            "noRedouble",
        ];
        assert!(actions.contains(&out["action"].as_str().unwrap()), "{out}");
        assert_eq!(out["canDouble"], true);
        assert!(out["equityNoDouble"].is_number());
        assert!(out["equityDoubleTake"].is_number());
        assert_eq!(out["equityDoubleDrop"], 1.0);
        assert!(out["takePoint"].is_number());

        let crawford = r#"{"length":5,"myAway":1,"theirAway":3,"crawford":true,"postCrawford":false,"cube":1,"cubeOwnerIsMe":null}"#;
        let out = json(&cube_action_json(OPENING, "black", crawford, "beginner").unwrap());
        assert_eq!(out["canDouble"], false);
        assert_eq!(out["action"], "noDouble");
    }

    #[test]
    fn analyze_play_locates_the_played_move() {
        let out = json(
            &analyze_play_json(
                OPENING,
                "white",
                r#"{"hi":3,"lo":1}"#,
                MONEY,
                "\"24/21 24/23\"",
                "3",
            )
            .unwrap(),
        );
        // The played move is located by the position it produces, so the
        // non-canonical order still matches the canonical candidate.
        let idx = usize::try_from(out["playedIndex"].as_u64().unwrap()).unwrap();
        assert_eq!(out["candidates"][idx]["play"]["notation"], "24/23 24/21");
        assert!(out["errorSize"].as_f64().unwrap() >= 0.0);
        assert!(["best", "fine", "error", "blunder"].contains(&out["category"].as_str().unwrap()));
    }

    #[test]
    fn analyze_play_rejects_unparseable_notation() {
        let err = analyze_play_json(OPENING, "white", r#"{"hi":3,"lo":1}"#, MONEY, "8/x", "3")
            .unwrap_err();
        assert!(err.starts_with("parse error"), "{err}");
    }

    #[test]
    fn replay_of_an_empty_record_is_a_fresh_match() {
        let record = r#"{"seed":42,"length":7,"rules":{"jacoby":false,"beavers":false,"autoDoubles":false},"turns":[]}"#;
        let out = json(&replay_json(record).unwrap());
        assert_eq!(out["length"], 7);
        assert_eq!(out["score"]["white"], 0);
        assert_eq!(out["score"]["black"], 0);
        assert_eq!(out["game"]["phase"], "openingRoll");
        assert_eq!(json(&out["game"]["board"].to_string()), json(OPENING));
    }

    #[test]
    fn replay_reports_engine_errors() {
        let record = r#"{"seed":9007199254740992,"length":1,"rules":{"jacoby":false,"beavers":false,"autoDoubles":false},"turns":[]}"#;
        let err = replay_json(record).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
        assert!(replay_json("[]").unwrap_err().starts_with("invalid record"));
    }
}
