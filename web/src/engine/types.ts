/**
 * The engine's JSON wire shapes, typed exactly as `bg-core` and `bg-bot`
 * serialise them (serde `camelCase` structs, lowercase or camelCase enums).
 * Source of truth: `engine/bg-core/src/*.rs`, `engine/bg-bot/src/*.rs`,
 * `engine/bg-wasm/README.md` and the vectors in `engine/vectors/*.json`.
 *
 * Coordinate conventions (they differ between `Board` and `Move`):
 *
 * - `Board.white` / `Board.black` are **absolute**: 26 slots, index `0` =
 *   bar, `1..24` = points in White's numbering, `25` = borne off. Black's
 *   point `p` is absolute point `25 - p`.
 * - `Move.from` / `Move.to` and every notation string are **relative to the
 *   player on roll**: `from` is `1..24` or `25` for the bar, `to` is `1..24`
 *   or `0` for bearing off.
 */

/** `"white"` | `"black"`. White's numbering is the board's absolute numbering. */
export type Player = "white" | "black";

/** Absolute checker counts per side; see the module docs for indices. */
export interface Board {
  white: number[];
  black: number[];
}

/** A roll; `hi >= lo`, both in `1..6` (`hi === lo` for doubles). */
export interface Dice {
  hi: number;
  lo: number;
}

/** One checker move relative to the player on roll. */
export interface Move {
  /** Source point `1..24`, or `25` for the bar. */
  from: number;
  /** Destination point `1..24`, or `0` for off. */
  to: number;
  /** `true` when an opposing blot on `to` is hit. */
  hit: boolean;
}

/**
 * A full play: 0–4 moves in the order they are made plus its standard
 * notation (`"24/18 13/10"`, `"bar/22*"`, `"6/off"`, `"13/7(2)"`; `""` for a
 * turn with no legal move). The engine always emits both fields.
 */
export interface Play {
  moves: Move[];
  notation: string;
}

/** The doubling cube; `owner` is `null` while centred. */
export interface Cube {
  value: number;
  owner: Player | null;
}

/** Optional rules in force for every game of a match. */
export interface Rules {
  jacoby: boolean;
  beavers: boolean;
  autoDoubles: boolean;
}

/** Turn-cycle phase of a game. */
export type Phase = "openingRoll" | "toRoll" | "doubled" | "toMove" | "finished";

/** How a game was won. */
export type ResultKind = "single" | "gammon" | "backgammon";

/** Outcome of a finished game; `points` = multiplier × cube value. */
export interface GameResult {
  winner: Player;
  kind: ResultKind;
  points: number;
}

/** Full state of one game (`bg_core::GameState`). */
export interface GameState {
  board: Board;
  /** `null` before the opening roll and after the game. */
  onRoll: Player | null;
  /** Present only in phase `toMove`. */
  dice: Dice | null;
  cube: Cube;
  phase: Phase;
  /** Set once `phase === "finished"`. */
  result: GameResult | null;
  rules: Rules;
}

/** A match, or a single money game when `length === 0` (`bg_core::MatchState`). */
export interface MatchState {
  length: number;
  score: { white: number; black: number };
  crawford: boolean;
  postCrawford: boolean;
  game: GameState;
}

/** What a logged turn did. */
export type Action = "roll" | "move" | "double" | "take" | "drop" | "resign";

/** One logged action; every field is always present on the wire. */
export interface Turn {
  player: Player;
  /** The dice rolled (`roll`) or played (`move`); `null` otherwise. */
  dice: Dice | null;
  action: Action;
  /** Notation relative to `player` (`move` only; `""` for a forfeited turn). */
  play: string | null;
  /** Points conceded (`resign` only). */
  resignPoints: number | null;
}

/**
 * A complete or partial match record (`bg_core::Record`). Note that this
 * name shadows TypeScript's `Record<K, V>` utility type in any module that
 * imports it unaliased: prefer `import type { Record as GameRecord }`.
 */
export interface Record {
  /** Seed of the dice stream; at most `Number.MAX_SAFE_INTEGER` (2^53 − 1). */
  seed: number;
  /** Match length; `0` = money / single game. */
  length: number;
  rules: Rules;
  turns: Turn[];
}

/** Bot strength (`bg_bot::Level`). */
export type Level = "beginner" | "intermediate" | "club";

/**
 * Match situation from the perspective of the player on roll
 * (`bg_bot::MatchContext`). A money game is `length: 0` with both away
 * counts `0`.
 */
export interface MatchContext {
  length: number;
  myAway: number;
  theirAway: number;
  crawford: boolean;
  postCrawford: boolean;
  cube: number;
  /** `true` if the player on roll owns the cube, `false` if the opponent does, `null` if centred. */
  cubeOwnerIsMe: boolean | null;
}

/** Outcome probabilities for the player on roll; `winG ≥ winBg`, `loseG ≥ loseBg`. */
export interface Probs {
  win: number;
  winG: number;
  winBg: number;
  loseG: number;
  loseBg: number;
}

/** Rollout statistics of a candidate play. */
export interface RolloutStats {
  trials: number;
  equity: number;
  stdErr: number;
  probs: Probs;
}

/** One ranked play; `rollout` is `null` unless the candidate was rolled out. */
export interface Candidate {
  play: Play;
  /** Match-normalised search equity (a single game at the current cube is ±1). */
  equity: number;
  probs: Probs;
  rollout: RolloutStats | null;
}

/** Output of `choose_play`: `play` equals `candidates[0].play`. */
export interface ChosenPlay {
  play: Play;
  /** Every legal play in the bot's ranking, best first. */
  candidates: Candidate[];
}

/** Grade of a played move relative to the best one. */
export type Category = "best" | "fine" | "error" | "blunder";

/** Output of `analyze_play`. */
export interface MoveAnalysis {
  candidates: Candidate[];
  /** Index into `candidates` of the play actually made. */
  playedIndex: number;
  /** Equity lost against `candidates[0]`; never negative. */
  errorSize: number;
  category: Category;
}

/** Recommended cube action (`bg_bot::CubeAction`). */
export type CubeActionKind =
  | "noDouble"
  | "doubleTake"
  | "doubleDrop"
  | "tooGood"
  | "redoubleTake"
  | "redoubleDrop"
  | "noRedouble";

/** Output of `cube_action`; equities on the current context's scale. */
export interface CubeAnalysis {
  action: CubeActionKind;
  /** `false` in the Crawford game or when the opponent owns the cube. */
  canDouble: boolean;
  equityNoDouble: number;
  equityDoubleTake: number;
  /** Always `1` on this scale. */
  equityDoubleDrop: number;
  takePoint: number;
}
