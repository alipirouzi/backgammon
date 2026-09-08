import { checkerRadius } from "./geometry";
import type { Player } from "./types";

export interface CheckerProps {
  player: Player;
  cx: number;
  cy: number;
  /** `data-testid`, e.g. `checker-white-13-4`. */
  testId: string;
  selected?: boolean;
}

/**
 * One checker: a layered disc (base, edge ring, inner ring, top highlight)
 * coloured by theme tokens. A selected checker lifts via a CSS transform on
 * `.checker__body`, so the group's position stays the point's slot.
 */
export function Checker({ player, cx, cy, testId, selected = false }: CheckerProps) {
  const r = checkerRadius();
  return (
    <g
      className="checker"
      data-player={player}
      data-selected={selected ? "true" : undefined}
      data-testid={testId}
      transform={`translate(${cx} ${cy})`}
    >
      <g className="checker__body">
        <circle className="checker__base" r={r} />
        <circle className="checker__edge" r={r - 1} fill="none" />
        <circle className="checker__ring" r={r * 0.62} fill="none" />
        <ellipse className="checker__highlight" cy={-r * 0.38} rx={r * 0.5} ry={r * 0.2} />
      </g>
    </g>
  );
}
