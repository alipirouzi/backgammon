import { expect, test } from "@playwright/test";

test("health endpoint answers ok", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("landing page renders the board mount", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#board-mount")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Backgammon");
});
