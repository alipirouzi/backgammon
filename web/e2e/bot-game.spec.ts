import { expect, test } from "@playwright/test";

import { GAME_CAP_MS, playUntilResult, startFromForm } from "./helpers/play";

/**
 * A whole bot game, driven through the real UI: `/play/new` with a pinned
 * dice seed, single game at beginner, then "first legal source, first legal
 * target, confirm" until the finish banner appears (see helpers/play.ts).
 * The person is always White, so the Board's absolute point numbers equal
 * the engine's relative ones and no coordinate mapping is needed here.
 */

const SEED = 42;

test.setTimeout(GAME_CAP_MS + 60_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });

test("a seeded beginner game is played to the finish banner", async ({ page }) => {
  await startFromForm(page, SEED, "single", "beginner");
  await expect(page.getByRole("radio", { name: "Single game" })).toBeChecked({ timeout: 1 }).catch(() => undefined);

  const iterations = await playUntilResult(page);

  const banner = page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ });
  await expect(banner).toBeVisible();
  // The board behind the banner leaves the tab order and focus lands on the result.
  await expect(page.locator(".table__board")).toHaveAttribute("inert", "");
  await expect(banner).toBeFocused();
  const title = (await banner.textContent()) ?? "";
  expect(title).toMatch(/\bwins?\b/);
  expect(title).toMatch(/\bpoints?\b/);
  await expect(page.getByRole("button", { name: "Play again", exact: true })).toBeEnabled();
  test.info().annotations.push({ type: "result", description: `${title} after ${String(iterations)} actions` });
});
