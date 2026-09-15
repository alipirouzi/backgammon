import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { GAME_CAP_MS, SETTLED_WAIT_MS, playUntilResult, startFromForm } from "./helpers/play";

/**
 * Post-game review, end to end: a seeded beginner single game is played to
 * the finish banner (helpers/play.ts), "Review this game" opens
 * `/review/local-<seed>?level=beginner`, the summary shows the result, one
 * step to the right lands on White's first play (graded during the game and
 * handed over by the store) and shows its grade badge, and jumping to the
 * computer's first play grades it lazily in the review's own engine worker.
 */

const SEED = 42;
const SCREENS_DIR = path.resolve(__dirname, "../test-results/screens");

test.setTimeout(GAME_CAP_MS + 90_000);
test.use({ contextOptions: { reducedMotion: "reduce" } });

test("a finished game can be reviewed turn by turn with grades", async ({ page }) => {
  await startFromForm(page, SEED, "single", "beginner");
  await playUntilResult(page);

  const review = page.getByRole("link", { name: "Review this game", exact: true });
  await expect(review).toHaveAttribute("href", `/review/local-${String(SEED)}?level=beginner`);
  await review.click();
  await expect(page).toHaveURL(new RegExp(`/review/local-${String(SEED)}\\?level=beginner$`));

  // Summary: the result heading, both side cards, the level.
  const result = page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ });
  await expect(result).toBeVisible({ timeout: SETTLED_WAIT_MS });
  await expect(page.getByRole("group", { name: "You", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Computer", exact: true })).toBeVisible();
  await expect(page.getByText(/Single game · Beginner/)).toBeVisible();

  // Stop 0: the opening roll; the slider spans every turn of the record.
  const slider = page.getByRole("slider", { name: "Turn", exact: true });
  await expect(slider).toHaveValue("0");
  await expect(page.getByTestId("stop-caption")).toContainText("opening roll");
  const stops = Number(await slider.getAttribute("max"));
  expect(stops).toBeGreaterThan(2);

  // → : White's first play, graded during the game; the badge comes from the store's hand-over.
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.getByTestId("stop-caption")).toContainText(/^Turn 2 of \d+You play /);
  const panel = page.getByRole("region", { name: "Analysis of this turn" });
  await expect(panel.locator(".grade")).toBeVisible({ timeout: SETTLED_WAIT_MS });
  await expect(panel.getByRole("table", { name: /Candidates for your/ })).toBeVisible();
  await expect(panel.locator("tr[data-played='true']")).toHaveCount(1);
  await expect(page.getByTestId("grade-announcement")).toHaveText(/^(Best|Fine|Error|Blunder): your /);

  // The computer's first play: graded lazily here (its choosePlay output is never in the store's grades).
  const computerPlay = page.getByRole("list", { name: "Moves", exact: true }).locator("button[data-player='black'][data-action='move']").first();
  await computerPlay.click();
  await expect(page.getByTestId("stop-caption")).toContainText("The computer plays");
  await expect(panel.locator(".grade")).toBeVisible({ timeout: SETTLED_WAIT_MS });
  await expect(panel.getByRole("table", { name: /Candidates for the computer's/ })).toBeVisible();
  await expect(computerPlay).toHaveAttribute("aria-current", "step");

  // Every play is graded in the background; the overall progress line settles on n of n.
  const progress = page.locator(".review-summary__progress");
  await expect(progress).toHaveText(/^(\d+) of \1 plays graded/, { timeout: 60_000 });
  await expect(page.locator(".review-summary")).toHaveAttribute("data-complete", "true");

  // The move list never ellipsizes a play's notation: rows wrap instead.
  const clipped = await page.locator(".turn__text").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length);
  expect(clipped).toBe(0);

  // End: the final position and the result note.
  await page.keyboard.press("End");
  await expect(slider).toHaveValue(String(stops));
  await expect(page.getByTestId("stop-caption")).toContainText("Final position");

  mkdirSync(SCREENS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENS_DIR, "review-1280.png"), fullPage: true, animations: "disabled" });

  // Back to the table: the finished game is shown finished.
  await page.getByRole("link", { name: "Back to table", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/play/local-${String(SEED)}\\?format=single&level=beginner$`));
  await expect(page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ })).toBeVisible({ timeout: SETTLED_WAIT_MS });
});

/**
 * A record stored in this browser with no game store to hand grades over
 * (a returning visitor): every grade is computed lazily in the review's own
 * worker. Phone width, so the stacked layout and the sticky-free move list
 * are exercised and captured.
 */
test("a stored record is reviewed at phone width with lazily computed grades", async ({ browser }) => {
  const record = readFileSync(path.resolve(__dirname, "../tests/fixtures/finished-record.json"), "utf8");
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
  try {
    await context.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [`bg.games.local-${String(SEED)}`, record] as const,
    );
    const page = await context.newPage();
    await page.goto(`/review/local-${String(SEED)}?level=club`);
    await expect(page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ })).toBeVisible({ timeout: SETTLED_WAIT_MS });
    await expect(page.getByText(/Single game · Club strength/)).toBeVisible();

    await page.getByRole("button", { name: "Next turn", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Turn", exact: true })).toHaveValue("1");
    const panel = page.getByRole("region", { name: "Analysis of this turn" });
    await expect(panel.locator(".grade")).toBeVisible({ timeout: SETTLED_WAIT_MS });
    await expect(panel.locator("tbody td.cands__sample").first()).toHaveText(/^n=\d+ ±\d\.\d{3}$/);

    // The grade and probability colours are theme tokens: they apply here, outside the table's drawer.
    const trackBackground = await panel.locator(".prob__track").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(trackBackground).not.toBe("rgba(0, 0, 0, 0)");
    const badgeBackground = await panel.locator(".grade").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const ruleStrong = await panel.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.background = "var(--rule-strong)";
      el.appendChild(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    });
    expect(badgeBackground).not.toBe(ruleStrong);
    // The candidate table scrolls sideways at this width and says so.
    await expect(panel.locator(".cands__hint")).toBeVisible();

    // No horizontal overflow at 375px.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    mkdirSync(SCREENS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENS_DIR, "review-375.png"), fullPage: true, animations: "disabled" });
  } finally {
    await context.close();
  }
});

test("an unknown local game explains itself", async ({ page }) => {
  await page.goto("/review/local-987654321");
  const empty = page.getByRole("region", { name: "No such game" });
  await expect(empty.getByRole("heading", { level: 2, name: "No such game" })).toBeVisible();
  await expect(empty.getByText(/this browser only/)).toBeVisible();
  // The site header links "New game" too; the notice carries its own.
  await expect(empty.getByRole("link", { name: "New game", exact: true })).toHaveAttribute("href", "/play/new");
});
