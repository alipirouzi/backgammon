import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { GAME_CAP_MS, SETTLED_WAIT_MS, playUntilResult, startFromForm, settledTone } from "./helpers/play";

/**
 * A match to 3 at beginner with a pinned seed: the first game is played to
 * its end (the computer's double is dropped — with seed 42 a taken double
 * ends in a 4-point gammon that decides the match in one game, which is the
 * final banner's path, not this one), the between-games banner shows the
 * result and the score, the
 * store's automatic driver stays paused until "Next game", and the next game
 * then starts (its opening roll is drawn and the table is live again).
 */

const SEED = 42;
/** Longer than the page's bot delay (650 ms): proves nothing starts the next game by itself. */
const PAUSE_PROOF_MS = 2_000;

test.setTimeout(GAME_CAP_MS + 90_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });

test("a match to 3 pauses on the first game's result until Next game", async ({ page }) => {
  await startFromForm(page, SEED, "3", "beginner");
  await expect(page.getByRole("region", { name: "You" })).toContainText("/3");

  await playUntilResult(page, { onDouble: "drop" });

  const banner = page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ });
  await expect(banner).toBeVisible();
  await expect(page.getByText(/^Score \d–\d in a match to 3$/)).toBeVisible();
  await expect(page.locator(".table__board")).toHaveAttribute("inert", "");
  const nextGame = page.getByRole("button", { name: "Next game", exact: true });
  await expect(nextGame).toBeEnabled();
  await expect(page.getByRole("button", { name: "Play again", exact: true })).toHaveCount(0);
  const screens = path.resolve(__dirname, "../test-results/screens");
  mkdirSync(screens, { recursive: true });
  await page.screenshot({ path: path.join(screens, "match-next-game.png"), fullPage: true, animations: "disabled" });

  // Paused: the banner is still there after the automatic driver would have acted.
  await page.waitForTimeout(PAUSE_PROOF_MS);
  await expect(banner).toBeVisible();
  await expect(nextGame).toBeEnabled();

  await nextGame.click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".table__board")).not.toHaveAttribute("inert", "");
  const { tone, text } = await settledTone(page, SETTLED_WAIT_MS);
  expect(tone, `after Next game: ${text}`).toBe("info");
  expect(text).toMatch(/^Your (turn|roll)/);
});
