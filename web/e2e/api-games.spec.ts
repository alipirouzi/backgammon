import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import type { Record as GameRecord } from "../src/engine/types";

/**
 * The games API end to end against the real server and a real PostgreSQL
 * (plan Task 11): a malformed body and an unfinished record are refused with
 * 400 and a reason (spec §8), a finished record is stored and read back as
 * exactly `{ record, result, seats }`, an unknown id is 404, and a finished
 * game reopened in the browser is posted once (`bg.games.<id>.posted`).
 *
 * Needs `DATABASE_URL` in the environment of `pnpm test:e2e` (the Playwright
 * `webServer` inherits it): `docker compose -f web/docker-compose.dev.yml up
 * -d --wait`, export the URL, `pnpm --filter web prisma:migrate:deploy`.
 * Without it the file is skipped locally and fails under `CI`, where the
 * `web` job provides a postgres service container. Rows created here are
 * left in place: both databases are throwaways.
 */

const FIXTURE = path.resolve(__dirname, "../tests/fixtures/finished-record.json");
const SEATS = { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "beginner" } } as const;
const CUID = /^c[a-z0-9]{20,}$/;
const SETTLED_WAIT_MS = 30_000;

const fixture = (): GameRecord => JSON.parse(readFileSync(FIXTURE, "utf8")) as GameRecord;

test.skip(
  !process.env.DATABASE_URL && !process.env.CI,
  "DATABASE_URL is not set: start web/docker-compose.dev.yml and export it (CI runs this file always)",
);

test("a body that is not a game is refused with 400 and a reason", async ({ request }) => {
  // A Buffer goes over the wire as is; a string `data` under a JSON content
  // type would be JSON-serialised by Playwright into the valid document `"{"`.
  const notJson = await request.post("/api/games", { headers: { "content-type": "application/json" }, data: Buffer.from("{", "utf8") });
  expect(notJson.status()).toBe(400);
  expect(await notJson.json()).toEqual({ error: "the request body is not valid JSON" });

  const noSeats = await request.post("/api/games", { data: { record: fixture() } });
  expect(noSeats.status()).toBe(400);
  expect((await noSeats.json()).error).toMatch(/`record` and `seats`/);

  const malformed = await request.post("/api/games", { data: { record: { seed: 1 }, seats: SEATS } });
  expect(malformed.status()).toBe(400);
  const { error } = (await malformed.json()) as { error: string };
  expect(error.length).toBeGreaterThan(0);
});

test("an unfinished record is refused with 400", async ({ request }) => {
  const record = fixture();
  const cut = { ...record, turns: record.turns.slice(0, 30) };
  const response = await request.post("/api/games", { data: { record: cut, seats: SEATS } });
  expect(response.status()).toBe(400);
  expect((await response.json()).error).toMatch(/finished/);
});

test("a finished record is stored with 201 and read back as { record, result, seats }", async ({ request }) => {
  const record = fixture();
  const post = await request.post("/api/games", { data: { record, seats: SEATS } });
  expect(post.status()).toBe(201);
  const { id } = (await post.json()) as { id: string };
  expect(id).toMatch(CUID);

  const get = await request.get(`/api/games/${id}`);
  expect(get.status()).toBe(200);
  expect(get.headers()["cache-control"]).toBe("no-store");
  const body = (await get.json()) as { record: GameRecord; result: { winner: string; kind: string; points: number; score: { white: number; black: number } }; seats: unknown };
  expect(Object.keys(body).sort()).toEqual(["record", "result", "seats"]);
  expect(body.record).toEqual(record);
  expect(body.seats).toEqual(SEATS);
  expect(body.result.winner).toMatch(/^(white|black)$/);
  expect(body.result.points).toBeGreaterThan(0);
  expect(body.result.score[body.result.winner as "white" | "black"]).toBe(body.result.points);
});

test("an unknown id is 404 with a reason", async ({ request }) => {
  for (const id of ["cxxxxxxxxxxxxxxxxxxxxxxxx", "not-an-id"]) {
    const response = await request.get(`/api/games/${id}`);
    expect(response.status(), id).toBe(404);
    expect(await response.json()).toEqual({ error: "no such game" });
  }
});

test("a finished game reopened in the browser is posted once and remembered", async ({ page }) => {
  const record = fixture();
  const id = `local-${String(record.seed)}`;
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [`bg.games.${id}`, JSON.stringify(record)] as const,
  );
  await page.goto(`/play/${id}?format=single&level=intermediate`);
  await expect(page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ })).toBeVisible({ timeout: SETTLED_WAIT_MS });

  // PlayGame posts once the (resumed) game is over; success is remembered as { serverId }.
  await expect
    .poll(() => page.evaluate((key) => window.localStorage.getItem(key), `bg.games.${id}.posted`), { timeout: SETTLED_WAIT_MS })
    .toMatch(/^\{"serverId":"c[a-z0-9]{20,}"\}$/);
  await expect(page.locator(".play-save")).toHaveCount(0); // the could-not-save note appears only on failure

  const marker = JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), `bg.games.${id}.posted`)) ?? "{}") as { serverId: string };
  const stored = await page.request.get(`/api/games/${marker.serverId}`);
  expect(stored.status()).toBe(200);
  const body = (await stored.json()) as { record: GameRecord; seats: { black: { level: string } } };
  expect(body.record).toEqual(record);
  expect(body.seats.black.level).toBe("intermediate");

  // A reload posts nothing more: the marker stays the same.
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: /^(You win|The computer wins)\b/ })).toBeVisible({ timeout: SETTLED_WAIT_MS });
  expect(await page.evaluate((key) => window.localStorage.getItem(key), `bg.games.${id}.posted`)).toBe(JSON.stringify(marker));
});
