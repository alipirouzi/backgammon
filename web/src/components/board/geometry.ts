// Pure board geometry in SVG user units. Everything is computed in board
// space from White's perspective (White bears off bottom-right); nothing here
// depends on CSS direction, so the board never mirrors in RTL locales.
//
// Layout (viewBox 0 0 1000 700):
//   frame 24 | left half: 6 columns | bar 60 | right half: 6 columns | divider | off trays | frame 24
//   bottom row, left → right: 12 … 7 | bar | 6 … 1     (White's home is 1–6, bottom right)
//   top row,    left → right: 13 … 18 | bar | 19 … 24

import type { Player } from "./types";

export const VIEW_W = 1000;
export const VIEW_H = 700;
export const FRAME = 24;
export const BAR_W = 60;
/** Width of one point column. */
export const COL_W = 68;
/** Gap between the right half and the off trays. */
export const TRAY_GAP = 12;
/** Width of the off-tray column. */
export const TRAY_W = 64;
/** Height of the playing area above/below the midline. */
export const HALF_H = (VIEW_H - 2 * FRAME) / 2;
/** Vertical midline of the board. */
export const MID_Y = VIEW_H / 2;
/** Height of a point triangle from its base to its apex. */
export const POINT_H = 250;
/** Radius of the ring drawn around a legal target slot. */
export const TARGET_RING_R = 34;

const CHECKER_R = 30;
const LEFT_X0 = FRAME;
const BAR_X0 = LEFT_X0 + 6 * COL_W;
const RIGHT_X0 = BAR_X0 + BAR_W;
const RIGHT_X1 = RIGHT_X0 + 6 * COL_W;
const TRAY_X0 = RIGHT_X1 + TRAY_GAP;

/** `true` for points on the top edge (13..24). */
export function isTopPoint(p: number): boolean {
  return p >= 13;
}

/** Column index 0..5 of point `p` within its half. */
export function pointColumn(p: number): number {
  if (p <= 6) return 6 - p;
  if (p <= 12) return 12 - p;
  if (p <= 18) return p - 13;
  return p - 19;
}

/** `true` when point `p` is in the right half (1..6 or 19..24). */
export function isRightHalf(p: number): boolean {
  return p <= 6 || p >= 19;
}

/** Centre x of point `p` (1..24). */
export function pointX(p: number): number {
  const x0 = isRightHalf(p) ? RIGHT_X0 : LEFT_X0;
  return x0 + pointColumn(p) * COL_W + COL_W / 2;
}

/** y of the edge a point's stack grows from: the top or bottom frame line. */
export function pointBaseY(p: number): number {
  return isTopPoint(p) ? FRAME : VIEW_H - FRAME;
}

/** +1 when the stack grows downwards (top points), −1 when it grows upwards. */
export function stackDirection(p: number): 1 | -1 {
  return isTopPoint(p) ? 1 : -1;
}

export function checkerRadius(): number {
  return CHECKER_R;
}

/** Centre x of the bar. */
export function barX(): number {
  return BAR_X0 + BAR_W / 2;
}

/** Left edge and width of the bar, for hit areas. */
export function barRect(): { x: number; y: number; width: number; height: number } {
  return { x: BAR_X0, y: FRAME, width: BAR_W, height: VIEW_H - 2 * FRAME };
}

/** Centre x of the off trays (both trays share the right-hand column). */
export function offTrayX(player: Player): number {
  return offTrayRect(player).x + TRAY_W / 2;
}

/** Bounding box of a player's off tray: Black top-right, White bottom-right. */
export function offTrayRect(player: Player): { x: number; y: number; width: number; height: number } {
  const y = player === "black" ? FRAME : MID_Y;
  return { x: TRAY_X0, y, width: TRAY_W, height: HALF_H };
}

/**
 * Distance from the point base to the centre of checker `index` (0-based) in
 * a stack of `count`. Up to five checkers stack touching; taller stacks are
 * compressed evenly (every pitch shrinks, not just the sixth onwards) so the
 * whole stack fits within `HALF_H` and reads as one column. Deliberate: a
 * "five full plus squeezed extras" stack looks broken on tall stacks.
 */
export function stackOffset(index: number, count: number = index + 1): number {
  const r = CHECKER_R;
  const naturalPitch = 2 * r;
  if (count <= 5) return r + index * naturalPitch;
  const room = HALF_H - 2 * r;
  const pitch = Math.min(naturalPitch, room / (count - 1));
  return r + index * pitch;
}

/** Centre of checker `index` of `count` on point `p`. */
export function checkerCenter(p: number, index: number, count: number): { x: number; y: number } {
  return {
    x: pointX(p),
    y: pointBaseY(p) + stackDirection(p) * stackOffset(index, count),
  };
}

/** Hit area of a point column (its half of the board), for the overlay button. */
export function pointRect(p: number): { x: number; y: number; width: number; height: number } {
  return {
    x: pointX(p) - COL_W / 2,
    y: isTopPoint(p) ? FRAME : MID_Y,
    width: COL_W,
    height: HALF_H,
  };
}

/** Where a player's bar checkers stack from: White above the cube, Black below it. */
export function barCheckerCenter(player: Player, index: number, count: number): { x: number; y: number } {
  const clearance = 44; // half the cube plus a gap
  const room = HALF_H - clearance - 2 * CHECKER_R;
  const pitch = count <= 1 ? 0 : Math.min(2 * CHECKER_R, room / (count - 1));
  const offset = clearance + CHECKER_R + index * pitch;
  return { x: barX(), y: player === "white" ? MID_Y - offset : MID_Y + offset };
}

/** Centre of the dice pair for the side on roll: White's dice in the right half, Black's in the left. */
export function diceCenter(onRoll: Player | null): { x: number; y: number } {
  const x = onRoll === "black" ? LEFT_X0 + 3 * COL_W : RIGHT_X0 + 3 * COL_W;
  return { x, y: MID_Y };
}

/** Centre of the cube: on the bar, at the owner's edge or in the middle when centred. */
export function cubeCenter(owner: Player | null): { x: number; y: number } {
  if (owner === "white") return { x: barX(), y: VIEW_H - FRAME - 44 };
  if (owner === "black") return { x: barX(), y: FRAME + 44 };
  return { x: barX(), y: MID_Y };
}

/**
 * Converts a mover-relative point (as in `Move.from`/`Move.to`: 25 = bar,
 * 0 = off) to absolute numbering. White's numbering is absolute; Black's is
 * mirrored. Bar and off keep their values.
 */
export function toAbsolute(player: Player, relative: number): number {
  if (relative <= 0 || relative >= 25 || player === "white") return relative;
  return 25 - relative;
}
