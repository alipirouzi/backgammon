//! Native Node.js binding of the backgammon engine (napi-rs).
//!
//! Every exported function takes and returns JSON strings with the shapes
//! defined by the serde derives in `bg-core` and `bg-bot` (`camelCase`) and
//! documented in `engine/vectors/README.md`. Errors are thrown as JavaScript
//! exceptions carrying the engine's message.
//!
//! JavaScript names (napi camel-cases the Rust names): `openingBoard`,
//! `legalPlays`, `applyPlay`, `choosePlay`, `cubeAction`, `analyzePlay`,
//! `replay`, `version`.
//!
//! Argument conventions:
//! - `board`: `Board` JSON, `onRoll`: `"white"` | `"black"` (JSON string or
//!   bare word), `dice`: `{ "hi", "lo" }`.
//! - `matchCtx`: `bg_bot::MatchContext` JSON (`length`, `myAway`,
//!   `theirAway`, `crawford`, `postCrawford`, `cube`, `cubeOwnerIsMe`).
//! - `level`: `"beginner"` | `"intermediate"` | `"club"`.
//! - `seed`: a JSON number or numeric string, at most `2^53 - 1`.
//! - `play` (for `applyPlay`): a `Play` object or its notation;
//!   `played` (for `analyzePlay`): notation.
//!
//! The marshalling itself is shared with the WebAssembly binding; this crate
//! only adapts it to napi. `String` parameters are what napi hands us, so
//! the pass-by-value lint is silenced crate-wide.
#![allow(clippy::needless_pass_by_value, clippy::must_use_candidate)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

// The shared JSON layer (`bg_wasm::api`): the WebAssembly binding wraps the
// very same functions, so the two bindings cannot drift.
use bg_wasm::api as json;

fn js_error(message: String) -> Error {
    Error::from_reason(message)
}

/// The standard opening position as `Board` JSON.
///
/// # Errors
///
/// Never in practice; kept as a `Result` for a uniform API.
#[napi]
pub fn opening_board() -> Result<String> {
    json::opening_board_json().map_err(js_error)
}

/// Every legal play for `dice` from `board` as seen by `on_roll`:
/// `[Play]` JSON in the engine's canonical order.
///
/// # Errors
///
/// Throws on invalid board, player or dice JSON.
#[napi]
pub fn legal_plays(board: String, on_roll: String, dice: String) -> Result<String> {
    json::legal_plays_json(&board, &on_roll, &dice).map_err(js_error)
}

/// Applies `play` (a `Play` object or its notation) for `on_roll` and
/// returns the resulting `Board` JSON.
///
/// # Errors
///
/// Throws on invalid JSON or a play that cannot be made from `board`.
#[napi]
pub fn apply_play(board: String, on_roll: String, play: String) -> Result<String> {
    json::apply_play_json(&board, &on_roll, &play).map_err(js_error)
}

/// The bot's play at `level` for `dice`:
/// `{ "play": Play, "candidates": [Candidate] }` JSON.
///
/// # Errors
///
/// Throws on invalid board, player, dice, match context, level or seed.
#[napi]
pub fn choose_play(
    board: String,
    on_roll: String,
    dice: String,
    match_ctx: String,
    level: String,
    seed: String,
) -> Result<String> {
    json::choose_play_json(&board, &on_roll, &dice, &match_ctx, &level, &seed).map_err(js_error)
}

/// The cube decision of `on_roll` before rolling: `CubeAnalysis` JSON.
///
/// # Errors
///
/// Throws on invalid board, player, match context or level.
#[napi]
pub fn cube_action(
    board: String,
    on_roll: String,
    match_ctx: String,
    level: String,
) -> Result<String> {
    json::cube_action_json(&board, &on_roll, &match_ctx, &level).map_err(js_error)
}

/// Grades `played` (notation) for `dice` against every legal play:
/// `MoveAnalysis` JSON.
///
/// # Errors
///
/// Throws on invalid board, player, dice, match context, seed or notation.
#[napi]
pub fn analyze_play(
    board: String,
    on_roll: String,
    dice: String,
    match_ctx: String,
    played: String,
    seed: String,
) -> Result<String> {
    json::analyze_play_json(&board, &on_roll, &dice, &match_ctx, &played, &seed).map_err(js_error)
}

/// Replays a `Record` from its seed and returns the resulting `MatchState`
/// JSON.
///
/// # Errors
///
/// Throws when the record is invalid or disagrees with its seed or the
/// rules; the message is the engine's.
#[napi]
pub fn replay(record: String) -> Result<String> {
    json::replay_json(&record).map_err(js_error)
}

/// The binding's name and version, e.g. `"bg-node 0.1.0"`.
#[napi]
pub fn version() -> String {
    format!("bg-node {}", env!("CARGO_PKG_VERSION"))
}
