// Board-local copies of the engine's JSON shapes (bg-core / bg-bot serde
// output). Task 1 defines the same shapes in web/src/engine/types.ts; a later
// task aliases these to those. Do not import from engine/ here.

/** The two sides. White moves 24 → 1 and bears off from points 1–6. */
export type Player = "white" | "black";

/**
 * Absolute board in White's numbering: 26 slots per side, index 0 = bar,
 * 1..24 = points, 25 = borne off. `{ white: [...], black: [...] }`.
 */
export interface Board {
  white: number[];
  black: number[];
}

/** Slot index of the bar in a `Board` array. */
export const BAR_SLOT = 0;
/** Slot index of the borne-off count in a `Board` array. */
export const OFF_SLOT = 25;

/** A roll; `hi >= lo`. */
export interface Dice {
  hi: number;
  lo: number;
}

/**
 * One checker moving by one die, **relative to the mover**: `from` is 1..24
 * or 25 (bar), `to` is 1..24 or 0 (off).
 */
export interface Move {
  from: number;
  to: number;
  hit: boolean;
}

/** Relative `Move.from` value for the bar. */
export const MOVE_BAR = 25;
/** Relative `Move.to` value for bearing off. */
export const MOVE_OFF = 0;

/** A full play as the engine serialises it. */
export interface Play {
  moves: Move[];
  notation: string;
}

/** The doubling cube; `owner` is `null` while centred. */
export interface Cube {
  value: number;
  owner: Player | null;
}

export type ThemeId = "heritage" | "broadcast" | "editorial";

export const THEME_IDS: readonly ThemeId[] = ["heritage", "broadcast", "editorial"];

/** The standard opening position as the engine's `opening_board()` returns it. */
export function openingBoard(): Board {
  const white = new Array<number>(26).fill(0);
  white[24] = 2;
  white[13] = 5;
  white[8] = 3;
  white[6] = 5;
  const black = white.map((_, i) => (i === 0 || i === 25 ? 0 : white[25 - i]));
  return { white, black };
}
