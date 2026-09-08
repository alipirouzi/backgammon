import { offTrayRect } from "./geometry";
import type { Player } from "./types";

const SLAB_H = 9;
const SLAB_GAP = 3;
const SLAB_INSET = 8;

export interface OffTrayProps {
  player: Player;
  count: number;
  legal: boolean;
}

/**
 * A player's bear-off tray: borne-off checkers drawn as flat slabs stacked
 * from the tray's outer edge (White from the bottom, Black from the top),
 * with the count as a numeral. Black's tray is top-right, White's bottom-right.
 */
export function OffTray({ player, count, legal }: OffTrayProps) {
  const rect = offTrayRect(player);
  const slabW = rect.width - 2 * SLAB_INSET;
  const slabs = Array.from({ length: count }, (_, i) => {
    const step = i * (SLAB_H + SLAB_GAP);
    const y = player === "white" ? rect.y + rect.height - SLAB_INSET - SLAB_H - step : rect.y + SLAB_INSET + step;
    return <rect key={i} className="tray__slab" x={rect.x + SLAB_INSET} y={y} width={slabW} height={SLAB_H} rx={2} />;
  });
  const labelY = player === "white" ? rect.y + 30 : rect.y + rect.height - 18;
  return (
    <g className="tray" data-player={player} data-target={legal ? "true" : undefined}>
      <rect className="tray__well" x={rect.x} y={rect.y + 6} width={rect.width} height={rect.height - 12} rx={6} />
      {legal ? <rect className="tray__target" x={rect.x + 2} y={rect.y + 8} width={rect.width - 4} height={rect.height - 16} rx={5} fill="none" /> : null}
      {slabs}
      <text className="tray__count" data-testid={`off-count-${player}`} x={rect.x + rect.width / 2} y={labelY}>
        {String(count)}
      </text>
    </g>
  );
}
