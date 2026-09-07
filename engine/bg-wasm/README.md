# bg-wasm

WebAssembly binding of the backgammon engine (`bg-core` + `bg-bot`). Every
function takes JSON strings and returns a JSON string; an error becomes a
JavaScript exception whose message is the Rust error text. The engine never
reads OS randomness: callers pass the seed, so results are reproducible and
the package has no `getrandom` dependency.

The marshalling is plain Rust in `src/api.rs` (`*_json` functions returning
`Result<String, String>`), exposed from the rlib so `bg-node` wraps the very
same functions with napi. The `wasm-bindgen` exports in `src/lib.rs` exist
only when compiling for `wasm32`.

## Build

From the repository root:

```sh
wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm
```

Output: `engine/bg-wasm/pkg/` (git-ignored), a pnpm workspace package named
`bg-wasm` (`pnpm-workspace.yaml` lists `engine/bg-wasm/pkg`); `web/` depends
on it as `"bg-wasm": "workspace:*"`, so build it before `pnpm install`, as CI
and the Dockerfile do. Files:
`package.json`, `bg_wasm.js`, `bg_wasm_bg.js`, `bg_wasm_bg.wasm`,
`bg_wasm.d.ts`, `bg_wasm_bg.wasm.d.ts`, `README.md`. No `--scope` flag: the
package name is the crate name.

Locally, wasm-pack downloads wasm-bindgen-cli 0.2.127 and binaryen
(`wasm-opt`) on first use. CI and the Dockerfile instead install both from
pinned, sha256-verified release tarballs and build with `--mode no-install`,
so no unverified binary is fetched at build time.

## JavaScript exports

| Export | Arguments (all strings) | Returns |
|---|---|---|
| `opening_board()` | – | `Board` |
| `legal_plays(board, onRoll, dice)` | | `[Play]` (canonical order; `[{"moves":[],"notation":""}]` when no move is possible) |
| `apply_play(board, onRoll, play)` | `play`: `Play` object or notation string | `Board` |
| `choose_play(board, onRoll, dice, matchCtx, level, seed)` | `level`: `"beginner"`, `"intermediate"`, `"club"` | `{ "play": Play, "candidates": [Candidate] }` |
| `cube_action(board, onRoll, matchCtx, level)` | | `CubeAnalysis` |
| `analyze_play(board, onRoll, dice, matchCtx, played, seed)` | `played`: notation string | `MoveAnalysis` |
| `replay(record)` | `Record` | `MatchState` |
| `version()` | – | plain string `bg-wasm 0.1.0` (not JSON) |

JSON shapes are the engine's serde output (`camelCase`): `Board`, `Dice`,
`Play` from `bg-core`; `MatchContext`, `Candidate` (`play`, `equity`,
`probs`, `rollout`), `CubeAnalysis` (`action`, `canDouble`, `equityNoDouble`,
`equityDoubleTake`, `equityDoubleDrop`, `takePoint`), `MoveAnalysis` from
`bg-bot`. `matchCtx` is `bg_bot::MatchContext`, e.g.
`{"length":0,"myAway":0,"theirAway":0,"crawford":false,"postCrawford":false,"cube":1,"cubeOwnerIsMe":null}`.

Argument leniencies (part of the contract, identical in `bg-node`):

- Text arguments (`onRoll`, `level`, a notation) may be a JSON string
  (`"\"white\""`) or the bare text (`"white"`).
- `seed` is a `u64` as a JSON number (`"12"`) or a numeric string
  (`"\"12\""`), at most `2^53 - 1` (`Number.MAX_SAFE_INTEGER`). Negative,
  fractional or larger values are rejected.
- `apply_play` has no dice: it checks a play structurally (sources occupied,
  bar first, destinations open, hits marked, bear-off only with all checkers
  home) but not against a roll. Use `legal_plays` for roll legality.

Boards are validated on input (15 checkers per side, no shared point).

## Tests

```sh
cd engine
cargo test -p bg-wasm                                                     # unit tests + vectors (cheap subset of club decisions)
cargo test --release -p bg-wasm --test vectors -- --include-ignored       # every decisions.json entry
cargo clippy -p bg-wasm --all-targets -- -D warnings
cargo clippy -p bg-wasm --all-targets --target wasm32-unknown-unknown -- -D warnings
cargo tree -p bg-wasm --target wasm32-unknown-unknown | grep -c getrandom  # must print 0
```

`tests/vectors.rs` drives `src/api.rs` with the committed
`engine/vectors/plays.json` and `decisions.json` through the exact
string-in/string-out path (see `engine/vectors/README.md` for the criteria).
