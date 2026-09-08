"use client";

import { Board } from "../board/Board";
import { openingBoard } from "../board/types";
import type { Board as BoardState, ThemeId } from "../board/types";

const OPENING: BoardState = openingBoard();
const CENTRED_CUBE = { value: 1, owner: null } as const;

function noop(): void {}

export interface StaticBoardProps {
  /** Scopes the theme tokens to this preview; omit to inherit the page theme. */
  theme?: ThemeId;
  className?: string;
}

/**
 * A purely decorative Board in the opening position: `inert` keeps its 27
 * overlay buttons out of the Tab order and `aria-hidden` out of the
 * accessibility tree, so the landing exposes only its own controls.
 */
export function StaticBoard({ theme, className }: StaticBoardProps) {
  return (
    <div className={className} data-theme={theme} inert aria-hidden="true">
      <Board
        board={OPENING}
        onRoll={null}
        dice={null}
        cube={CENTRED_CUBE}
        selectedFrom={null}
        legalTargets={[]}
        pending={[]}
        onPointClick={noop}
        onBarClick={noop}
        onOffClick={noop}
        perspective="white"
      />
    </div>
  );
}
