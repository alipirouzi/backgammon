import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Drives a bot game through the real UI — "first legal source, first legal
 * target, confirm", taking (or dropping) every double — until the status line settles on
 * a `result` tone (a finished game, or a finished game of a match on show).
 * Every step synchronises on `[role=status][data-tone]`: `busy` while the
 * engine works, `info` when the person must act, `error` when the store
 * rejected something (it never throws to React, so a stalled game would
 * otherwise burn the whole cap silently).
 */

export const MAX_ITERATIONS = 400;
export const GAME_CAP_MS = 120_000;
export const SETTLED_WAIT_MS = 30_000; // covers worker + wasm load and the opening roll (650 ms delay) on the first pass
const SELECT_WAIT_MS = 1_500;
const SETTLE_WAIT_MS = 3_000;

export type Tone = "info" | "busy" | "error" | "result";

export async function settledTone(page: Page, timeout: number): Promise<{ tone: Tone; text: string }> {
  const status = page.locator('[role="status"][data-tone]:not([data-tone="busy"])');
  await expect(status).toBeVisible({ timeout });
  const tone = (await status.getAttribute("data-tone")) as Tone;
  const text = (await status.textContent()) ?? "";
  return { tone, text };
}

/** Waits (briefly) for the status line to move on from `previous`, so one action is not counted twice. */
async function statusMovedOn(page: Page, previous: string): Promise<void> {
  await expect(page.locator('[role="status"]'))
    .not.toHaveText(previous, { timeout: SETTLE_WAIT_MS })
    .catch(() => undefined);
}

async function clickIfEnabled(button: Locator, page: Page, previous: string): Promise<boolean> {
  if (!(await button.isEnabled())) {
    return false;
  }
  await button.click();
  await statusMovedOn(page, previous);
  return true;
}

/**
 * Picks up the first of White's checkers that has a legal move: the bar
 * first (the rules demand it while a checker sits there), then points
 * 24 → 1 in DOM order. Clicking a checker without a move is a no-op in the
 * store, so each candidate is tried until legal targets appear.
 */
async function pickFirstLegalSource(page: Page): Promise<boolean> {
  const legal = page.locator('[data-legal="true"]');
  const candidates: Locator[] = [
    page.locator('button[aria-label^="Bar, "]:not([aria-label^="Bar, 0 white"])'),
    page.locator('button[data-occupant="white"]'),
  ];
  for (const group of candidates) {
    const n = await group.count();
    for (let i = 0; i < n; i++) {
      await group.nth(i).click();
      const appeared = await legal
        .first()
        .waitFor({ state: "attached", timeout: SELECT_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      if (appeared) {
        return true;
      }
    }
  }
  return false;
}

export interface PlayOptions {
  /** Answer to the computer's double: `take` plays on for the cube; `drop` concedes a single game at once. */
  onDouble: "take" | "drop";
}

/** Plays until the status tone is `result`; returns the number of actions taken. */
export async function playUntilResult(page: Page, { onDouble }: PlayOptions = { onDouble: "take" }): Promise<number> {
  const roll = page.getByRole("button", { name: "Roll", exact: true });
  const confirm = page.getByRole("button", { name: "Confirm", exact: true });
  const cubeAnswer = page.getByRole("button", { name: onDouble === "take" ? "Take" : "Drop", exact: true });
  const legal = page.locator('[data-legal="true"]');

  const started = Date.now();
  let iteration = 0;
  for (; iteration < MAX_ITERATIONS; iteration++) {
    expect(Date.now() - started, "game did not finish within the time cap").toBeLessThan(GAME_CAP_MS);
    const { tone, text } = await settledTone(page, SETTLED_WAIT_MS);
    if (tone === "result") {
      break;
    }
    expect(tone, `store reported an error: ${text}`).not.toBe("error");

    if (await clickIfEnabled(cubeAnswer, page, text)) {
      continue; // the computer doubled
    }
    if (await clickIfEnabled(roll, page, text)) {
      continue;
    }
    if (await clickIfEnabled(confirm, page, text)) {
      continue;
    }
    if ((await legal.count()) > 0) {
      await legal.first().click();
      await statusMovedOn(page, text);
      continue;
    }
    expect(await pickFirstLegalSource(page), `no checker with a legal move found; status: ${text}`).toBe(true);
  }
  expect(iteration, "iteration cap reached before the game finished").toBeLessThan(MAX_ITERATIONS);
  return iteration;
}

/** `/play/new?seed=` → picks the format and level cards → "Start the game". */
export async function startFromForm(page: Page, seed: number, format: string, level: string): Promise<void> {
  await page.goto(`/play/new?seed=${String(seed)}`);
  // The radios are visually hidden inside their <label class="choice">; click the label as a person would.
  await page.locator("label.choice", { has: page.locator(`input[name="format"][value="${format}"]`) }).click();
  await page.locator("label.choice", { has: page.locator(`input[name="level"][value="${level}"]`) }).click();
  await page.getByRole("button", { name: "Start the game", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/play/local-${String(seed)}\\?format=${format}&level=${level}$`));
}
