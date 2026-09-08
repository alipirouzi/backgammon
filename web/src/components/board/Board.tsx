"use client";

import { useId } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import "../../styles/tokens.css";
import "../../styles/themes.css";
import "./board.css";
import { Checker } from "./Checker";
import { Cube } from "./Cube";
import { Dice } from "./Dice";
import { OffTray } from "./OffTray";
import { Point } from "./Point";
import {
  BAR_W,
  COL_W,
  FRAME,
  HALF_H,
  MID_Y,
  VIEW_H,
  VIEW_W,
  barCheckerCenter,
  barRect,
  diceCenter,
  offTrayRect,
  pointRect,
  toAbsolute,
} from "./geometry";
import { BAR_SLOT, MOVE_BAR, MOVE_OFF, OFF_SLOT } from "./types";
import type { Board as BoardState, Cube as CubeValue, Dice as DiceValue, Move, Player } from "./types";

/**
 * DOM contract for tests and e2e helpers:
 * - every checker on a point or the bar is an SVG group with
 *   `data-testid="checker-<player>-<point>-<index>"` (bar = point 0; borne-off
 *   checkers are drawn as tray slabs without test ids), and the lifted one
 *   carries `data-selected="true"`;
 * - `data-legal="true"`, `data-selected="true"` and `data-pending="true"` mark
 *   only the overlay `<button>`s (points, bar, trays), so
 *   `[data-legal="true"]` matches exactly the clickable targets;
 * - point buttons are labelled `Point <n>, <k> <player> checker(s)` /
 *   `Point <n>, empty`, the bar `Bar, <w> white checker(s), <b> black checker(s)`,
 *   the trays `<Player> off tray, <k> checker(s)`; while a checker is lifted the
 *   source's name ends in `, selected` and each target's in `, legal destination`
 *   (the non-visual counterpart of the lifted disc and the pulsing rings);
 *   Tab order is bar, 24 … 1, trays. Escape with a checker lifted calls `onDeselect`.
 */
export interface BoardProps {
  /** Absolute position (White's numbering). Rendered verbatim: the Board never applies moves itself. */
  board: BoardState;
  onRoll: Player | null;
  dice: DiceValue | null;
  cube: CubeValue;
  /**
   * `selectedFrom`, `legalTargets` and `pending` use the engine's `Move`
   * coordinates **relative to `onRoll`** (25 = bar, 0 = off), exactly as
   * `legal_plays` returns them; the Board converts to absolute points for
   * layout. When `onRoll` is null they are read as White's.
   */
  selectedFrom: number | null;
  legalTargets: number[];
  pending: Move[];
  /** Absolute point 1..24. Clicks on the bar and the off trays use the two callbacks below. */
  onPointClick(p: number): void;
  onBarClick(): void;
  /** Fired by either tray (the prop carries no player); legality is the store's/engine's call. */
  onOffClick(): void;
  /** Escape pressed on the hit layer while `selectedFrom` is set: put the lifted checker back. */
  onDeselect?(): void;
  /** White always sits at the bottom and bears off bottom-right. */
  perspective: "white";
}

/** Points in White's movement direction: the Tab order of the point buttons. */
const MOVEMENT_ORDER: readonly number[] = Array.from({ length: 24 }, (_, i) => 24 - i);

const LEFT_FELT = { x: FRAME, y: FRAME, width: 6 * COL_W, height: VIEW_H - 2 * FRAME };
const RIGHT_FELT_X = barRect().x + BAR_W;
const RIGHT_FELT_W = 6 * COL_W;

function pct(value: number, total: number): string {
  return `${(value / total) * 100}%`;
}

function hitStyle(rect: { x: number; y: number; width: number; height: number }): CSSProperties {
  return {
    left: pct(rect.x, VIEW_W),
    top: pct(rect.y, VIEW_H),
    width: pct(rect.width, VIEW_W),
    height: pct(rect.height, VIEW_H),
  };
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** `, selected` / `, legal destination` suffix for a hit's accessible name while a checker is lifted. */
function stateSuffix(state: { selected?: boolean; legal?: boolean }): string {
  if (state.selected) return ", selected";
  if (state.legal) return ", legal destination";
  return "";
}

function pointLabel(p: number, occupant: Player | null, count: number, state: { selected: boolean; legal: boolean }): string {
  const contents = !occupant || count === 0 ? "empty" : plural(count, `${occupant} checker`);
  return `Point ${String(p)}, ${contents}${stateSuffix(state)}`;
}

function occupantOf(board: BoardState, slot: number): { occupant: Player | null; count: number } {
  if (board.white[slot] > 0) return { occupant: "white", count: board.white[slot] };
  if (board.black[slot] > 0) return { occupant: "black", count: board.black[slot] };
  return { occupant: null, count: 0 };
}

export function Board({
  board,
  onRoll,
  dice,
  cube,
  selectedFrom,
  legalTargets,
  pending,
  onPointClick,
  onBarClick,
  onOffClick,
  onDeselect,
  perspective,
}: BoardProps) {
  const mover: Player = onRoll ?? "white";
  const selected = selectedFrom === null ? null : toAbsolute(mover, selectedFrom);
  const legal = new Set(legalTargets.map((t) => toAbsolute(mover, t)));
  const pendingTo = new Set(pending.map((m) => toAbsolute(mover, m.to)));
  const offLegal = legal.has(MOVE_OFF);
  const offPending = pendingTo.has(MOVE_OFF);
  const barSelected = selected === MOVE_BAR;
  const vignetteId = useId();
  const whiteBar = board.white[BAR_SLOT];
  const blackBar = board.black[BAR_SLOT];
  const whiteOff = board.white[OFF_SLOT];
  const blackOff = board.black[OFF_SLOT];
  const bar = barRect();
  const diceAt = diceCenter(onRoll);
  const whiteOffLegal = offLegal && mover === "white";
  const blackOffLegal = offLegal && mover === "black";
  const onHitsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && selected !== null && onDeselect) {
      event.preventDefault();
      onDeselect();
    }
  };

  return (
    <div className="board" data-perspective={perspective} data-on-roll={onRoll ?? undefined}>
      <svg
        className="board__svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id={vignetteId} cx="50%" cy="50%" r="72%">
            <stop offset="55%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.32" />
          </radialGradient>
        </defs>
        <rect className="board__frame" x={0} y={0} width={VIEW_W} height={VIEW_H} rx={18} />
        <rect className="board__frame-highlight" x={FRAME / 2} y={FRAME / 2} width={VIEW_W - FRAME} height={VIEW_H - FRAME} rx={12} fill="none" />
        <rect className="board__felt" x={LEFT_FELT.x} y={LEFT_FELT.y} width={LEFT_FELT.width} height={LEFT_FELT.height} />
        <rect className="board__felt" x={RIGHT_FELT_X} y={FRAME} width={RIGHT_FELT_W} height={VIEW_H - 2 * FRAME} />
        <rect className="board__bar" x={bar.x} y={bar.y} width={bar.width} height={bar.height} />
        <rect className="board__vignette" x={LEFT_FELT.x} y={FRAME} width={LEFT_FELT.width} height={VIEW_H - 2 * FRAME} fill={`url(#${vignetteId})`} />
        <rect className="board__vignette" x={RIGHT_FELT_X} y={FRAME} width={RIGHT_FELT_W} height={VIEW_H - 2 * FRAME} fill={`url(#${vignetteId})`} />
        <line className="board__midline" x1={FRAME} y1={MID_Y} x2={RIGHT_FELT_X + RIGHT_FELT_W} y2={MID_Y} />
        {MOVEMENT_ORDER.map((p) => {
          const { occupant, count } = occupantOf(board, p);
          return (
            <Point key={p} point={p} occupant={occupant} count={count} selected={selected === p} legal={legal.has(p)} />
          );
        })}
        <g className="board__bar-checkers" data-selected={barSelected ? "true" : undefined}>
          {Array.from({ length: whiteBar }, (_, i) => {
            const c = barCheckerCenter("white", i, whiteBar);
            return (
              <Checker key={`w${i}`} player="white" cx={c.x} cy={c.y} testId={`checker-white-0-${i}`} selected={barSelected && mover === "white" && i === whiteBar - 1} />
            );
          })}
          {Array.from({ length: blackBar }, (_, i) => {
            const c = barCheckerCenter("black", i, blackBar);
            return (
              <Checker key={`b${i}`} player="black" cx={c.x} cy={c.y} testId={`checker-black-0-${i}`} selected={barSelected && mover === "black" && i === blackBar - 1} />
            );
          })}
        </g>
        <OffTray player="black" count={blackOff} legal={offLegal && mover === "black"} />
        <OffTray player="white" count={whiteOff} legal={offLegal && mover === "white"} />
        {dice ? <Dice dice={dice} cx={diceAt.x} cy={diceAt.y} /> : null}
        <Cube cube={cube} />
      </svg>

      <div className="board__hits" onKeyDown={onHitsKeyDown}>
        <button
          type="button"
          className="board__hit board__hit--bar"
          style={hitStyle(bar)}
          aria-label={`Bar, ${plural(whiteBar, "white checker")}, ${plural(blackBar, "black checker")}${stateSuffix({ selected: barSelected })}`}
          data-selected={barSelected ? "true" : undefined}
          onClick={onBarClick}
        />
        {MOVEMENT_ORDER.map((p) => {
          const { occupant, count } = occupantOf(board, p);
          return (
            <button
              key={p}
              type="button"
              className="board__hit board__hit--point"
              style={hitStyle(pointRect(p))}
              data-point={p}
              data-occupant={occupant ?? undefined}
              data-legal={legal.has(p) ? "true" : undefined}
              data-selected={selected === p ? "true" : undefined}
              data-pending={pendingTo.has(p) ? "true" : undefined}
              aria-label={pointLabel(p, occupant, count, { selected: selected === p, legal: legal.has(p) })}
              onClick={() => onPointClick(p)}
            />
          );
        })}
        <button
          type="button"
          className="board__hit board__hit--off"
          style={hitStyle({ ...offTrayRect("white"), height: HALF_H })}
          aria-label={`White off tray, ${plural(whiteOff, "checker")}${stateSuffix({ legal: whiteOffLegal })}`}
          data-player="white"
          data-legal={whiteOffLegal ? "true" : undefined}
          data-pending={offPending && mover === "white" ? "true" : undefined}
          onClick={onOffClick}
        />
        <button
          type="button"
          className="board__hit board__hit--off"
          style={hitStyle(offTrayRect("black"))}
          aria-label={`Black off tray, ${plural(blackOff, "checker")}${stateSuffix({ legal: blackOffLegal })}`}
          data-player="black"
          data-legal={blackOffLegal ? "true" : undefined}
          data-pending={offPending && mover === "black" ? "true" : undefined}
          onClick={onOffClick}
        />
      </div>
    </div>
  );
}
