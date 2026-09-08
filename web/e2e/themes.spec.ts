import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Screenshot matrix: three themes × three widths of `/play/local-42` at the
 * opening position, written to `web/test-results/screens/<theme>-<width>.png`
 * (CI uploads that folder as the `screens` artifact on every run). The theme
 * is chosen the way a returning visitor's is — `localStorage['bg.theme']`
 * before the page loads, applied to `<html data-theme>` by the root layout's
 * inline bootstrap — and the gate is the computed `--board-felt` token, which
 * must differ across the three themes at every width.
 */

const THEMES = ["heritage", "broadcast", "editorial"] as const;
const WIDTHS = [375, 768, 1440] as const;
const HEIGHT: { [W in (typeof WIDTHS)[number]]: number } = { 375: 812, 768: 1024, 1440: 900 };
const SCREENS_DIR = path.resolve(__dirname, "../test-results/screens");
const STORAGE_KEY = "bg.theme";
const SEED = 42;

type ThemeId = (typeof THEMES)[number];

for (const width of WIDTHS) {
  test(`board at ${String(width)}px renders a distinct felt per theme`, async ({ browser }) => {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const felts = new Map<ThemeId, string>();

    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width, height: HEIGHT[width] }, reducedMotion: "reduce" });
      try {
        await context.addInitScript(
          ([key, value]) => {
            window.localStorage.setItem(key, value);
          },
          [STORAGE_KEY, theme] as const,
        );
        const page = await context.newPage();
        await page.goto(`/play/local-${String(SEED)}`);
        // The opening roll happens on its own shortly after load; wait for the
        // table to settle on the person's turn so every shot shows the same state.
        await expect(page.locator('[role="status"][data-tone="info"]')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByRole("button", { name: /^Point 24, 2 white checkers$/ })).toBeAttached();

        const felt = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--board-felt").trim());
        expect(felt, `${theme} defines --board-felt`).not.toBe("");
        felts.set(theme, felt);

        await page.screenshot({
          path: path.join(SCREENS_DIR, `${theme}-${String(width)}.png`),
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }

    expect([...felts.keys()]).toEqual([...THEMES]);
    expect(new Set(felts.values()).size, `felts: ${JSON.stringify([...felts])}`).toBe(THEMES.length);
  });
}
