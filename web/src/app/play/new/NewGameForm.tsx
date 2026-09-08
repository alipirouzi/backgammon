"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { StaticBoard } from "@/components/landing/StaticBoard";
import { THEMES } from "@/components/landing/themes-meta";
import { ThemeSwitch } from "@/components/theme/ThemeSwitch";
import { useTheme } from "@/components/theme/useTheme";
import type { Level } from "@/engine/types";
import { randomSeed } from "@/game/record";
import type { GameFormat } from "@/game/store";

import "./new-game.css";
import { DEFAULT_OPTIONS, LEVELS, LEVEL_LABELS, MATCH_LENGTHS, formatParam, gameHref } from "../game-options";

export interface NewGameFormProps {
  /** Pinned dice seed from `?seed=`; a fresh 53-bit random one when `null`. */
  seed: number | null;
  initialFormat: GameFormat | null;
  initialLevel: Level | null;
}

const FORMATS: { value: string; label: string; note: string }[] = [
  { value: "single", label: "Single game", note: "Money rules, Jacoby on" },
  ...MATCH_LENGTHS.map((n) => ({ value: String(n), label: `Match to ${String(n)}`, note: "Crawford rule, cube in play" })),
];

function toFormat(value: string): GameFormat {
  return value === "single" ? "single" : { matchTo: Number(value) };
}

/** The `/play/new` form: format, level and board, then straight to the table. */
export function NewGameForm({ seed, initialFormat, initialLevel }: NewGameFormProps) {
  const router = useRouter();
  const [theme] = useTheme();
  const [format, setFormat] = useState<string>(formatParam(initialFormat ?? DEFAULT_OPTIONS.format));
  const [level, setLevel] = useState<Level>(initialLevel ?? DEFAULT_OPTIONS.level);
  const [starting, setStarting] = useState(false);
  const themeMeta = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setStarting(true);
    router.push(gameHref(seed ?? randomSeed(), { format: toFormat(format), level }));
  };

  return (
    <form className="new-game__form" onSubmit={start}>
      <header className="new-game__head">
        <p className="new-game__eyebrow">Play the computer</p>
        <h1 id="new-game-title" className="new-game__title">
          Set the table
        </h1>
        <p className="new-game__lede">You play White and bear off bottom right. Every roll is seeded; every game can be replayed.</p>
      </header>

      <div className="new-game__options">
        <fieldset className="option-group">
          <legend className="option-group__legend">Format</legend>
          <div className="option-group__choices">
            {FORMATS.map((f) => (
              <label key={f.value} className="choice" data-checked={format === f.value ? "true" : undefined}>
                <input
                  className="choice__input"
                  type="radio"
                  name="format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                />
                <span className="choice__label">{f.label}</span>
                <span className="choice__note">{f.note}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="option-group">
          <legend className="option-group__legend">Level</legend>
          <div className="option-group__choices">
            {LEVELS.map((l) => (
              <label key={l} className="choice" data-checked={level === l ? "true" : undefined}>
                <input className="choice__input" type="radio" name="level" value={l} checked={level === l} onChange={() => setLevel(l)} />
                <span className="choice__label">{LEVEL_LABELS[l].name}</span>
                <span className="choice__note">{LEVEL_LABELS[l].blurb}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="new-game__submit">
          <button type="submit" className="cta cta--primary" disabled={starting}>
            {starting ? "Setting up…" : "Start the game"}
          </button>
          {seed !== null ? <p className="new-game__seed">{`Dice seed ${String(seed)}`}</p> : null}
        </div>
      </div>

      <figure className="new-game__preview">
        <StaticBoard className="new-game__board" />
        <figcaption className="new-game__preview-caption">
          <span className="new-game__theme-name">{themeMeta.name}</span>
          <ThemeSwitch />
        </figcaption>
      </figure>
    </form>
  );
}
