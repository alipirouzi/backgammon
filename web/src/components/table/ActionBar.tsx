"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, RefObject } from "react";

import type { ResultKind } from "@/engine/types";

export interface ActionAvailability {
  roll: boolean;
  undo: boolean;
  confirm: boolean;
  double: boolean;
  take: boolean;
  drop: boolean;
  resign: boolean;
}

export interface ActionBarProps {
  can: ActionAvailability;
  /** Disables every control while an engine call is in flight. */
  busy: boolean;
  /** What resigning as `kind` concedes now — the rules' answer (Jacoby included), see `concededPointsFor`. */
  pointsFor(kind: ResultKind): number;
  onRoll(): void;
  onUndo(): void;
  onConfirm(): void;
  onDouble(): void;
  onTake(): void;
  onDrop(): void;
  onResign(kind: ResultKind): void;
  /**
   * Where focus parks when the activated control disables itself (Roll once
   * rolled, Undo on the last pending move, Confirm/Take/Drop while the
   * computer replies): the status line, which then reads what happened.
   */
  focusFallback?: RefObject<HTMLElement | null>;
}

const RESIGN_KINDS: { kind: ResultKind; label: string }[] = [
  { kind: "single", label: "Single game" },
  { kind: "gammon", label: "Gammon" },
  { kind: "backgammon", label: "Backgammon" },
];

const pointsText = (n: number): string => `${String(n)} point${n === 1 ? "" : "s"}`;

/**
 * Roll · Undo · Confirm · Double · Take · Drop · Resign. Every button is a
 * real `disabled` control (never `aria-disabled`), so the store's `can*`
 * selectors are the only source of truth for what the person may do.
 * Resign opens an inline chooser for the kind conceded: focus moves to its
 * first option, Escape or "Keep playing" closes it and returns focus to Resign.
 */
export function ActionBar({ can, busy, pointsFor, onRoll, onUndo, onConfirm, onDouble, onTake, onDrop, onResign, focusFallback }: ActionBarProps) {
  const [resignOpen, setResignOpen] = useState(false);
  const resignId = useId();
  const resignButton = useRef<HTMLButtonElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  /** The last activated control, until it either disables (focus is parked) or focus moves on. */
  const activated = useRef<HTMLButtonElement | null>(null);
  const enabled = (flag: boolean): boolean => flag && !busy;
  const resignEnabled = enabled(can.resign);
  const chooserOpen = resignOpen && resignEnabled;

  // A `disabled` control drops keyboard focus to <body>; park it on the fallback instead.
  useEffect(() => {
    const control = activated.current;
    if (!control) return;
    const active = document.activeElement;
    if (active !== control && active !== document.body && active !== null) {
      activated.current = null;
      return;
    }
    if (control.disabled) {
      activated.current = null;
      focusFallback?.current?.focus();
    }
  });

  useEffect(() => {
    if (chooserOpen) firstOption.current?.focus();
  }, [chooserOpen]);

  /** Capture-phase click on the turn and cube groups: remember which control was activated. */
  const remember = (event: MouseEvent<HTMLDivElement>): void => {
    activated.current = event.target instanceof HTMLButtonElement ? event.target : null;
  };

  const closeChooser = (): void => {
    setResignOpen(false);
    resignButton.current?.focus();
  };

  const onResignKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && chooserOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeChooser();
    }
  };

  const choose = (kind: ResultKind): void => {
    activated.current = resignButton.current;
    closeChooser();
    onResign(kind);
  };

  return (
    <div className="actions" data-busy={busy ? "true" : undefined}>
      <div className="actions__group actions__group--turn" role="group" aria-label="Turn" onClickCapture={remember}>
        <button type="button" className="action action--primary" disabled={!enabled(can.roll)} onClick={onRoll}>
          Roll
        </button>
        <button type="button" className="action" disabled={!enabled(can.undo)} onClick={onUndo}>
          Undo
        </button>
        <button type="button" className="action action--primary" disabled={!enabled(can.confirm)} onClick={onConfirm}>
          Confirm
        </button>
      </div>

      <div className="actions__group actions__group--cube" role="group" aria-label="Cube" onClickCapture={remember}>
        <button type="button" className="action" disabled={!enabled(can.double)} onClick={onDouble}>
          Double
        </button>
        <button type="button" className="action action--primary" disabled={!enabled(can.take)} onClick={onTake}>
          Take
        </button>
        <button type="button" className="action action--danger" disabled={!enabled(can.drop)} onClick={onDrop}>
          Drop
        </button>
      </div>

      <div className="actions__group actions__group--resign" onKeyDown={onResignKeyDown}>
        <button
          ref={resignButton}
          type="button"
          className="action action--quiet"
          disabled={!resignEnabled}
          aria-expanded={chooserOpen}
          aria-controls={resignId}
          onClick={() => setResignOpen((open) => !open)}
        >
          Resign
        </button>
        <div id={resignId} className="resign" hidden={!chooserOpen} role="group" aria-label="Resign as">
          {RESIGN_KINDS.map(({ kind, label }, i) => (
            <button
              key={kind}
              ref={i === 0 ? firstOption : undefined}
              type="button"
              className="action action--danger resign__option"
              onClick={() => choose(kind)}
            >
              <span className="resign__kind">{label}</span>
              <span className="resign__points">{pointsText(pointsFor(kind))}</span>
            </button>
          ))}
          <button type="button" className="action action--quiet" onClick={closeChooser}>
            Keep playing
          </button>
        </div>
      </div>
    </div>
  );
}
