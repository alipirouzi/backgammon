"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { humanPlayer } from "@/game/selectors";
import type { BotAnalysis, GameStore, HumanAnalysis } from "@/game/store";

import "./analysis.css";
import { CandidateList } from "./CandidateList";
import { GradeBadge } from "./GradeBadge";
import { MoveList } from "./MoveList";
import { LEVEL_SEARCH, botVerdict, countText, diceText, formatLoss, gradeAnnouncement, humanVerdict } from "./format";

export interface AnalysisDrawerProps {
  /** The game store (`getGameStore()` in the app, a MockEngine-backed one in tests). */
  store: StoreApi<GameStore>;
}

type TabId = "analysis" | "moves" | "chat";

const TABS: { id: TabId; label: string; disabled?: boolean }[] = [
  { id: "analysis", label: "Analysis" },
  { id: "moves", label: "Moves" },
  { id: "chat", label: "Chat", disabled: true },
];

const EMPTY_TEXT = "Candidates and grades appear here as the game goes on.";

/** What the server renders for `analysis.visible` (spec §5.2: on in bot games); the stored choice applies once hydrated. */
const SERVER_VISIBLE = true;

/** Set on `<html>` while the panel is open; under 900px analysis.css locks the page's scroll on it. */
export const SHEET_ATTRIBUTE = "data-analysis-sheet";

/**
 * The analysis drawer under the board (spec §5.2). Collapsed it is one strip:
 * the grade of the person's last play ("your 24/18 13/10 lost 0.035") and
 * the computer's last choice ("Computer played 13/8 6/5 · +0.021 · 74
 * candidates"). Expanded it adds tabs — Analysis (both decisions with their
 * candidate lists), Moves (the record) and Chat (planned, disabled).
 *
 * Two switches: the store's `analysis.visible` (on by default in bot games,
 * persisted under `bg.analysis`) turns the analysis on or off; `expanded`
 * is this component's own — collapsed on every table load and again when
 * the analysis is hidden, so the board stays the hero and a phone is not
 * opened on a full-height sheet unasked. Under 900px the expanded panel is
 * a bottom sheet with a grab handle; it moves on `transform` only, the page
 * behind it does not scroll (`data-analysis-sheet` on `<html>`, styled in
 * analysis.css), and Escape, the handle or the scrim close it. Focus
 * follows: into the first tab on open, back to the toggle on close. Grades
 * are announced through an always-mounted polite live region.
 *
 * `visible` is read through `useSyncExternalStore` with a server snapshot of
 * `true`: the store loads the persisted choice from `localStorage` when it
 * is created in the browser, which the server-rendered HTML cannot know, so
 * hydration renders the default and the stored value takes over right after
 * (no hydration mismatch when the drawer was hidden).
 */
export function AnalysisDrawer({ store }: AnalysisDrawerProps) {
  const analysis = useStore(store, (s) => s.analysis);
  const visible = useSyncExternalStore(
    store.subscribe,
    () => store.getState().analysis.visible,
    () => SERVER_VISIBLE,
  );
  const analysisByTurn = useStore(store, (s) => s.analysisByTurn);
  const record = useStore(store, (s) => s.record);
  const level = useStore(store, (s) => s.botLevel);
  const human = useStore(store, humanPlayer) ?? "white";
  const setVisible = useStore(store, (s) => s.setAnalysisVisible);

  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabId>("analysis");
  const baseId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<{ [K in TabId]: HTMLButtonElement | null }>>({});
  /** Where focus goes after the next open/close, set by the action that caused it. */
  const focusAfter = useRef<"panel" | "toggle" | null>(null);

  const { forBot, forHuman } = analysis;
  const open = visible && expanded;
  const panelId = `${baseId}-panel`;

  useEffect(() => {
    if (focusAfter.current === "panel" && open) {
      tabRefs.current[tab]?.focus();
      focusAfter.current = null;
    } else if (focusAfter.current === "toggle" && !open) {
      toggle.current?.focus();
      focusAfter.current = null;
    }
  }, [open, tab]);

  // The page behind the open sheet does not scroll; the attribute is styled under 900px only.
  useEffect(() => {
    if (!open) {
      return;
    }
    const root = document.documentElement;
    root.setAttribute(SHEET_ATTRIBUTE, "true");
    return () => root.removeAttribute(SHEET_ATTRIBUTE);
  }, [open]);

  const openPanel = (): void => {
    focusAfter.current = "panel";
    setExpanded(true);
  };
  const closePanel = (): void => {
    focusAfter.current = "toggle";
    setExpanded(false);
  };
  /** Hiding collapses the panel too, so "Show analysis" returns to the strip; focus stays on the switch. */
  const switchVisible = (): void => {
    if (visible) {
      setExpanded(false);
    }
    setVisible(!visible);
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  };

  /** Roving tabindex with automatic activation: arrows, Home and End move among the enabled tabs. */
  const onTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = TABS.filter((t) => !t.disabled).map((t) => t.id);
    const current = enabled.indexOf(tab);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = (current + 1) % enabled.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = enabled[next];
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const grade = forHuman?.analysis ?? null;

  return (
    <aside className="analysis table__drawer" aria-label="Analysis" data-open={open ? "true" : undefined} data-visible={visible ? "true" : "false"}>
      <div className="analysis__strip">
        <span className="analysis__label">Analysis</span>
        <div className="analysis__verdicts">
          {!visible ? (
            <p className="verdict verdict--empty">Analysis is off.</p>
          ) : forHuman === null && forBot === null ? (
            <p className="verdict verdict--empty">{EMPTY_TEXT}</p>
          ) : (
            <>
              {forHuman ? (
                <p className="verdict" data-side="you" data-testid="verdict-you">
                  {grade ? <GradeBadge category={grade.category} /> : null}
                  <span className="verdict__text">{humanVerdict(forHuman)}</span>
                </p>
              ) : null}
              {forBot ? (
                <p className="verdict" data-side="computer" data-testid="verdict-computer">
                  <span className="verdict__text">{botVerdict(forBot)}</span>
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="analysis__controls">
          {visible ? (
            <button
              ref={toggle}
              type="button"
              className="action action--quiet analysis__toggle"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={open ? closePanel : openPanel}
            >
              {open ? "Close" : "Open"}
            </button>
          ) : null}
          <button type="button" className="action action--quiet analysis__switch" data-on={visible ? "true" : "false"} onClick={switchVisible}>
            {visible ? "Hide analysis" : "Show analysis"}
          </button>
        </div>
      </div>

      <p className="analysis__sr" aria-live="polite" aria-atomic="true" data-testid="grade-announcement">
        {visible && forHuman ? gradeAnnouncement(forHuman) : ""}
      </p>

      {open ? (
        <>
          <button type="button" className="analysis__scrim" aria-hidden="true" tabIndex={-1} onClick={closePanel} />
          <section id={panelId} className="analysis__panel" aria-label="Analysis details" onKeyDown={onPanelKeyDown}>
            <button type="button" className="analysis__grab" aria-label="Close analysis" onClick={closePanel}>
              <span className="analysis__grab-bar" aria-hidden="true" />
            </button>
            <div role="tablist" aria-label="Analysis sections" className="tabs" onKeyDown={onTabListKeyDown}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    tabRefs.current[t.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${t.id}`}
                  className="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`${baseId}-tabpanel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  disabled={t.disabled}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  {t.disabled ? <span className="tab__planned"> (planned)</span> : null}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`${baseId}-tabpanel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`} className="tabpanel" tabIndex={0}>
              {tab === "analysis" ? (
                <AnalysisTab forHuman={forHuman} forBot={forBot} level={level} />
              ) : tab === "moves" ? (
                <MoveList record={record} analysisByTurn={analysisByTurn} human={human} />
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </aside>
  );
}

interface AnalysisTabProps {
  forHuman: HumanAnalysis | null;
  forBot: BotAnalysis | null;
  level: GameStore["botLevel"];
}

/** Both decisions, the person's first, each with its caption line and candidate list. */
function AnalysisTab({ forHuman, forBot, level }: AnalysisTabProps) {
  if (forHuman === null && forBot === null) {
    return <p className="analysis__empty">{EMPTY_TEXT}</p>;
  }
  return (
    <div className="decisions">
      {forHuman ? <HumanDecision forHuman={forHuman} /> : null}
      {forBot ? <BotDecision forBot={forBot} level={level} /> : null}
    </div>
  );
}

function HumanDecision({ forHuman }: { forHuman: HumanAnalysis }) {
  const { analysis, dice, played, error } = forHuman;
  const best = analysis?.candidates[0]?.play.notation;
  const meta = analysis
    ? [
        `with ${diceText(dice)}`,
        analysis.category === "best" ? "the best play" : `lost ${formatLoss(analysis.errorSize)} to ${best ?? "the best play"}`,
        "club analysis: 2-ply + rollouts",
      ]
    : [`with ${diceText(dice)}`, `analysis unavailable${error ? `: ${error}` : ""}`];
  return (
    <section className="decision" data-side="you" aria-label="Your move">
      <header className="decision__head">
        <h3 className="decision__title">
          {analysis ? <GradeBadge category={analysis.category} errorSize={analysis.errorSize} /> : null}
          <span>{`You played ${played || "no move"}`}</span>
        </h3>
        <p className="decision__meta">{meta.join(" · ")}</p>
      </header>
      {analysis ? <CandidateList candidates={analysis.candidates} playedIndex={analysis.playedIndex} caption={`Candidates for your ${diceText(dice)}`} /> : null}
    </section>
  );
}

function BotDecision({ forBot, level }: { forBot: BotAnalysis; level: GameStore["botLevel"] }) {
  const { chosen, dice } = forBot;
  return (
    <section className="decision" data-side="computer" aria-label="Computer's move">
      <header className="decision__head">
        <h3 className="decision__title">{chosen.play.notation ? `Computer played ${chosen.play.notation}` : "Computer had no legal move"}</h3>
        <p className="decision__meta">{[`with ${diceText(dice)}`, countText(chosen.candidates.length, "candidate"), LEVEL_SEARCH[level]].join(" · ")}</p>
      </header>
      {chosen.candidates.length > 0 ? (
        <CandidateList candidates={chosen.candidates} playedIndex={0} caption={`Candidates for the computer's ${diceText(dice)}`} />
      ) : null}
    </section>
  );
}
