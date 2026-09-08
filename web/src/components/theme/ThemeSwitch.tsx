"use client";

import { THEMES } from "@/components/landing/themes-meta";

import "./theme.css";
import { useTheme } from "./useTheme";

export interface ThemeSwitchProps {
  /** Show the full theme names instead of the one-word short forms. */
  verbose?: boolean;
  className?: string;
}

const SHORT_NAME = { heritage: "Heritage", broadcast: "Broadcast", editorial: "Editorial" } as const;

/**
 * Segmented control over the three boards. Each option carries a swatch
 * scoped to its own `data-theme`, so it shows that board's felt and point
 * colours whatever theme the page is in.
 */
export function ThemeSwitch({ verbose = false, className }: ThemeSwitchProps) {
  const [theme, setTheme] = useTheme();
  return (
    <div className={["theme-switch", className].filter(Boolean).join(" ")} role="group" aria-label="Board theme">
      {THEMES.map((t) => {
        const current = t.id === theme;
        return (
          <button
            key={t.id}
            type="button"
            className="theme-switch__option"
            aria-pressed={current}
            aria-label={t.name}
            title={t.tagline}
            onClick={() => setTheme(t.id)}
          >
            <span className="theme-switch__swatch" data-theme={t.id} aria-hidden="true" />
            <span className="theme-switch__name">{verbose ? t.name : SHORT_NAME[t.id]}</span>
          </button>
        );
      })}
    </div>
  );
}
