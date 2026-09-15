import type { Player, Record as GameRecord, Turn } from "@/engine/types";
import type { AnalysisByTurn } from "@/game/store";

import { GradeBadge } from "./GradeBadge";
import { diceText } from "./format";

export interface MoveListProps {
  record: GameRecord | null;
  /** Club-strength grades by turn index (the person's confirmed plays during a game). */
  analysisByTurn: AnalysisByTurn;
  /** The seat the person plays; the other side is "Computer". */
  human: Player;
}

function turnText(turn: Turn, index: number): string {
  switch (turn.action) {
    case "roll":
      return turn.dice ? (index === 0 ? `wins the opening roll ${diceText(turn.dice)}` : `rolls ${diceText(turn.dice)}`) : "rolls";
    case "move":
      return turn.play ? turn.play : "no legal move";
    case "double":
      return "doubles";
    case "take":
      return "takes";
    case "drop":
      return "drops";
    case "resign":
      return `resigns (${String(turn.resignPoints ?? 0)} pt)`;
  }
}

/**
 * The record as a move list: one row per logged turn — who, the dice, what
 * was done — with the grade of every analysed play. The newest turn is last
 * and marked `aria-current`.
 */
export function MoveList({ record, analysisByTurn, human }: MoveListProps) {
  const turns = record?.turns ?? [];
  if (turns.length === 0) {
    return <p className="moves__empty">No moves yet.</p>;
  }
  return (
    <div className="moves">
      <table className="moves__table">
        <caption className="analysis__sr">Moves</caption>
        <thead>
          <tr>
            <th scope="col" className="moves__index">
              #
            </th>
            <th scope="col">Who</th>
            <th scope="col">Dice</th>
            <th scope="col">Action</th>
            <th scope="col">Grade</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn, index) => {
            const analysis = analysisByTurn[index] ?? null;
            return (
              <tr key={index} data-action={turn.action} data-player={turn.player} aria-current={index === turns.length - 1 ? "true" : undefined}>
                <td className="moves__index">{index + 1}</td>
                <td>{turn.player === human ? "You" : "Computer"}</td>
                <td className="moves__dice">{turn.action === "move" && turn.dice ? diceText(turn.dice) : ""}</td>
                <td className="moves__action">{turnText(turn, index)}</td>
                <td className="moves__grade">{analysis ? <GradeBadge category={analysis.category} errorSize={analysis.errorSize} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
