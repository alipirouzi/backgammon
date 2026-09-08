"use client";

import Link from "next/link";
import { useState } from "react";
import "./landing.css";
import { HeroBoard } from "./HeroBoard";
import { ThemeChooser } from "./ThemeChooser";
import { useLandingTheme } from "./use-landing-theme";

const CHOOSER_ID = "board-chooser";

/**
 * The landing page: the opening position as the hero, one primary action and
 * the board chooser. `<main id="board-mount">` and the h1 text "Backgammon"
 * are checked by the deploy verification and `e2e/landing.spec.ts`.
 */
export function Landing() {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [theme, setTheme] = useLandingTheme();

  return (
    <main id="board-mount" className="landing" data-chooser-open={chooserOpen ? "true" : undefined}>
      <header className="masthead">
        <p className="masthead__brand">
          backgammon<span className="masthead__tld">.automated.ink</span>
        </p>
        <p className="masthead__meta">
          <span>Club-strength engine</span>
          <span aria-hidden="true">·</span>
          <span>Runs in your browser</span>
        </p>
      </header>

      <section className="hero" aria-labelledby="hero-heading">
        <p className="hero__eyebrow">Single games · Matches · Doubling cube</p>
        <h1 id="hero-heading" className="hero__title">
          Backgammon
        </h1>
        <div className="hero__copy">
          <p className="hero__promise">
            Play the computer at club strength, on a board made for the long game.
          </p>
          <div className="hero__actions">
            <Link href="/play/new" className="cta cta--primary">
              Play the computer
            </Link>
            <button
              type="button"
              className="cta cta--ghost"
              aria-expanded={chooserOpen}
              aria-controls={CHOOSER_ID}
              onClick={() => setChooserOpen((open) => !open)}
            >
              Choose your board
              <span className="cta__chevron" aria-hidden="true">
                ⌄
              </span>
            </button>
          </div>
        </div>
        <HeroBoard />
      </section>

      <ThemeChooser id={CHOOSER_ID} open={chooserOpen} theme={theme} onSelect={setTheme} />

      <footer className="landing__foot">
        <p>Three boards. Every roll seeded, every game replayable.</p>
        <p>Engine written in Rust, compiled to WebAssembly.</p>
      </footer>
    </main>
  );
}
