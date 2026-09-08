//! WebAssembly binding of the backgammon engine: JSON strings in, JSON
//! strings out, errors as JavaScript exceptions carrying the Rust message.
//!
//! The marshalling lives in [`api`] as plain Rust so that `bg-node` (the
//! native Node.js addon) can wrap the very same functions; the
//! `wasm-bindgen` exports below exist only on `wasm32` and mirror `api`
//! one-to-one. Seeds come from the caller: this crate never reads OS
//! randomness (no `getrandom`).
//!
//! Build with `wasm-pack build engine/bg-wasm --target bundler --release
//! --out-dir pkg --out-name bg_wasm` from the repository root; the JS
//! export names are the function names below.
#![warn(missing_docs)]

pub mod api;

/// `"<crate name> <version>"`, e.g. `bg-wasm 0.1.0`. A plain string, not a
/// JSON document.
pub const VERSION: &str = concat!(env!("CARGO_PKG_NAME"), " ", env!("CARGO_PKG_VERSION"));

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::api;

    fn js(result: api::JsonResult) -> Result<String, JsError> {
        result.map_err(|e| JsError::new(&e))
    }

    /// The standard opening position as `Board` JSON.
    #[wasm_bindgen]
    pub fn opening_board() -> Result<String, JsError> {
        js(api::opening_board_json())
    }

    /// Every legal play as a JSON array of `Play`; see [`api::legal_plays_json`].
    #[wasm_bindgen]
    pub fn legal_plays(board: &str, on_roll: &str, dice: &str) -> Result<String, JsError> {
        js(api::legal_plays_json(board, on_roll, dice))
    }

    /// Applies a `Play` object or notation string; see [`api::apply_play_json`].
    #[wasm_bindgen]
    pub fn apply_play(board: &str, on_roll: &str, play: &str) -> Result<String, JsError> {
        js(api::apply_play_json(board, on_roll, play))
    }

    /// The bot's move and ranked candidates; see [`api::choose_play_json`].
    #[wasm_bindgen]
    pub fn choose_play(
        board: &str,
        on_roll: &str,
        dice: &str,
        match_ctx: &str,
        level: &str,
        seed: &str,
    ) -> Result<String, JsError> {
        js(api::choose_play_json(
            board, on_roll, dice, match_ctx, level, seed,
        ))
    }

    /// Cube decision before rolling; see [`api::cube_action_json`].
    #[wasm_bindgen]
    pub fn cube_action(
        board: &str,
        on_roll: &str,
        match_ctx: &str,
        level: &str,
    ) -> Result<String, JsError> {
        js(api::cube_action_json(board, on_roll, match_ctx, level))
    }

    /// Analysis of a played move; see [`api::analyze_play_json`].
    #[wasm_bindgen]
    pub fn analyze_play(
        board: &str,
        on_roll: &str,
        dice: &str,
        match_ctx: &str,
        played: &str,
        seed: &str,
    ) -> Result<String, JsError> {
        js(api::analyze_play_json(
            board, on_roll, dice, match_ctx, played, seed,
        ))
    }

    /// Replays a `Record` into a `MatchState`; see [`api::replay_json`].
    #[wasm_bindgen]
    pub fn replay(record: &str) -> Result<String, JsError> {
        js(api::replay_json(record))
    }

    /// `"bg-wasm 0.1.0"`.
    #[wasm_bindgen]
    #[must_use]
    pub fn version() -> String {
        crate::VERSION.to_owned()
    }
}
