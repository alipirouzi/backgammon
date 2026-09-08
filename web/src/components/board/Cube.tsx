import { cubeCenter } from "./geometry";
import type { Cube as CubeValue } from "./types";

export const CUBE_SIZE = 64;

export interface CubeProps {
  cube: CubeValue;
}

/**
 * The doubling cube on the bar. Centred (no owner) it sits in the middle
 * showing the conventional 64 face; once owned it moves to the owner's edge
 * of the bar and shows the current value.
 */
export function Cube({ cube }: CubeProps) {
  const { x, y } = cubeCenter(cube.owner);
  const face = cube.owner === null && cube.value === 1 ? 64 : cube.value;
  return (
    <g
      className="cube"
      data-testid="cube"
      data-owner={cube.owner ?? "centred"}
      transform={`translate(${x} ${y})`}
    >
      <rect className="cube__face" x={-CUBE_SIZE / 2} y={-CUBE_SIZE / 2} width={CUBE_SIZE} height={CUBE_SIZE} rx={12} />
      <rect className="cube__bevel" x={-CUBE_SIZE / 2 + 3} y={-CUBE_SIZE / 2 + 3} width={CUBE_SIZE - 6} height={CUBE_SIZE - 6} rx={10} fill="none" />
      <text className="cube__text" dy="0.36em">
        {String(face)}
      </text>
    </g>
  );
}
