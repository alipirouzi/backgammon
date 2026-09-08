import type { Dice as DiceValue } from "./types";

export const DIE_SIZE = 56;
const PIP_R = 5;
const OFF = 15;

const PIP_LAYOUT: Record<number, ReadonlyArray<readonly [number, number]>> = {
  1: [[0, 0]],
  2: [[-OFF, -OFF], [OFF, OFF]],
  3: [[-OFF, -OFF], [0, 0], [OFF, OFF]],
  4: [[-OFF, -OFF], [OFF, -OFF], [-OFF, OFF], [OFF, OFF]],
  5: [[-OFF, -OFF], [OFF, -OFF], [0, 0], [-OFF, OFF], [OFF, OFF]],
  6: [[-OFF, -OFF], [OFF, -OFF], [-OFF, 0], [OFF, 0], [-OFF, OFF], [OFF, OFF]],
};

function Die({ value, cx, cy, testId }: { value: number; cx: number; cy: number; testId: string }) {
  const pips = PIP_LAYOUT[value] ?? [];
  return (
    <g className="die" data-testid={testId} data-value={value} transform={`translate(${cx} ${cy})`}>
      <rect className="die__face" x={-DIE_SIZE / 2} y={-DIE_SIZE / 2} width={DIE_SIZE} height={DIE_SIZE} rx={11} />
      <rect className="die__gloss" x={-DIE_SIZE / 2 + 4} y={-DIE_SIZE / 2 + 3} width={DIE_SIZE - 8} height={DIE_SIZE / 2 - 4} rx={8} />
      {pips.map(([px, py], i) => (
        <circle key={i} className="die__pip" cx={px} cy={py} r={PIP_R} />
      ))}
    </g>
  );
}

export interface DiceProps {
  dice: DiceValue;
  /** Centre of the pair. */
  cx: number;
  cy: number;
}

/** The current roll as two pipped dice, high die first. */
export function Dice({ dice, cx, cy }: DiceProps) {
  const gap = DIE_SIZE / 2 + 10;
  return (
    <g className="board__dice" aria-hidden="true">
      <Die value={dice.hi} cx={cx - gap} cy={cy} testId="die-hi" />
      <Die value={dice.lo} cx={cx + gap} cy={cy} testId="die-lo" />
    </g>
  );
}
