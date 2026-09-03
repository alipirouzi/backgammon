import { describe, expect, it } from "vitest";
import { GET } from "../src/app/health/route";

describe("GET /health", () => {
  it("returns status ok with 200", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
