import { Checker } from "./Checker";
import {
  COL_W,
  POINT_H,
  TARGET_RING_R,
  checkerCenter,
  checkerRadius,
  isTopPoint,
  pointBaseY,
  pointX,
  stackDirection,
} from "./geometry";
import type { Player } from "./types";

/** Stacks taller than this show a count badge on the top checker. */
export const BADGE_FROM = 6;

export interface PointProps {
  /** Absolute point number 1..24. */
  point: number;
  /** Checkers on the point (only one side can occupy a point). */
  occupant: Player | null;
  count: number;
  selected: boolean;
  legal: boolean;
}

/**
 * The SVG half of a point: its triangle, its stack of checkers, the target
 * ring on the next free slot when the point is a legal destination and the
 * count badge on tall stacks. The clickable `<button>` is rendered by
 * `Board` in an HTML overlay.
 */
export function Point({ point, occupant, count, selected, legal }: PointProps) {
  const x = pointX(point);
  const baseY = pointBaseY(point);
  const apexY = baseY + stackDirection(point) * POINT_H;
  const half = COL_W / 2 - 3;
  const r = checkerRadius();
  const checkers = occupant
    ? Array.from({ length: count }, (_, i) => {
        const { x: cx, y: cy } = checkerCenter(point, i, count);
        return (
          <Checker
            key={i}
            player={occupant}
            cx={cx}
            cy={cy}
            testId={`checker-${occupant}-${point}-${i}`}
            selected={selected && i === count - 1}
          />
        );
      })
    : null;
  const topSlot = checkerCenter(point, Math.max(count - 1, 0), Math.max(count, 1));
  const nextSlot = checkerCenter(point, count, count + 1);

  return (
    <g
      className="board__point"
      data-point={point}
      data-side={isTopPoint(point) ? "top" : "bottom"}
      data-parity={point % 2 === 1 ? "a" : "b"}
    >
      <polygon className="board__triangle" points={`${x - half},${baseY} ${x + half},${baseY} ${x},${apexY}`} />
      <text className="board__label" x={x} y={isTopPoint(point) ? 16 : 692}>
        {String(point)}
      </text>
      {checkers}
      {legal ? <circle className="board__target" cx={nextSlot.x} cy={nextSlot.y} r={TARGET_RING_R} /> : null}
      {count >= BADGE_FROM ? (
        <g className="stack-badge" data-testid={`stack-badge-${point}`} transform={`translate(${topSlot.x} ${topSlot.y})`}>
          <circle r={r * 0.55} />
          <text dy="0.35em">{String(count)}</text>
        </g>
      ) : null}
    </g>
  );
}
