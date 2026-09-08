"use client";

import { useEffect, useRef } from "react";
import type { ThemeId } from "../board/types";
import { StaticBoard } from "./StaticBoard";
import { THEMES } from "./themes-meta";

export interface ThemeChooserProps {
  /** Element id the "Choose your board" toggle points at via `aria-controls`. */
  id: string;
  open: boolean;
  theme: ThemeId;
  onSelect(theme: ThemeId): void;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The three boards as live previews, each rendered inside its own
 * `data-theme` scope. The section stays in the DOM (so `aria-controls`
 * always resolves) but the previews mount only while open.
 */
export function ThemeChooser({ id, open, theme, onSelect }: ThemeChooserProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = `${id}-title`;

  useEffect(() => {
    if (!open) return;
    const title = titleRef.current;
    if (!title) return;
    title.focus({ preventScroll: true });
    if (typeof title.scrollIntoView === "function") {
      title.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    }
  }, [open]);

  return (
    <section id={id} className="chooser" hidden={!open} aria-labelledby={titleId}>
      <div className="chooser__head">
        <h2 id={titleId} ref={titleRef} className="chooser__title" tabIndex={-1}>
          Choose your board
        </h2>
        <p className="chooser__note">Remembered on this device. You can change it again at the table.</p>
      </div>
      {open ? (
        <ul className="chooser__list">
          {THEMES.map((t, i) => {
            const current = t.id === theme;
            const nameId = `${id}-${t.id}-name`;
            const taglineId = `${id}-${t.id}-tagline`;
            return (
              <li key={t.id} className="swatch" data-theme-id={t.id} data-current={current ? "true" : undefined}>
                <StaticBoard theme={t.id} className="swatch__board" />
                <button
                  type="button"
                  className="swatch__select"
                  aria-pressed={current}
                  aria-labelledby={nameId}
                  aria-describedby={taglineId}
                  onClick={() => onSelect(t.id)}
                >
                  <span className="swatch__index">{`0${String(i + 1)}`}</span>
                  <span id={nameId} className="swatch__name">
                    {t.name}
                  </span>
                  <span id={taglineId} className="swatch__tagline">
                    {t.tagline}
                  </span>
                  <span className="swatch__state">{current ? "Current board" : "Use this board"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
