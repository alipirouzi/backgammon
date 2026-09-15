// The level a local bot game was started at, kept beside its record under
// `bg.games.<id>.level` (web/src/game/local-games.ts): the record itself
// carries no level, and the level a game is resumed or posted with must be
// the one it was played at, not whatever the URL says later.

import { describe, expect, it } from "vitest";

import {
  GAMES_KEY_PREFIX,
  LEVEL_SUFFIX,
  levelKey,
  loadLocalGameLevel,
  removeLocalGame,
  saveLocalGame,
  saveLocalGameLevel,
  type StorageLike,
} from "../src/game/local-games";

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
  key = (i: number) => [...this.map.keys()][i] ?? null;
  get length() {
    return this.map.size;
  }
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error("storage disabled");
  },
  setItem: () => {
    throw new Error("storage full");
  },
  removeItem: () => {
    throw new Error("storage disabled");
  },
  key: () => null,
  length: 0,
};

describe("local game level", () => {
  it("lives under bg.games.<id>.level", () => {
    expect(levelKey("local-42")).toBe(`${GAMES_KEY_PREFIX}local-42${LEVEL_SUFFIX}`);
    expect(levelKey("local-42")).toBe("bg.games.local-42.level");
  });

  it("round-trips a level and reads null when absent or not a level", () => {
    const storage = new MemoryStorage();
    expect(loadLocalGameLevel("local-1", storage)).toBeNull();
    expect(saveLocalGameLevel("local-1", "club", storage)).toBe(true);
    expect(storage.getItem("bg.games.local-1.level")).toBe("club");
    expect(loadLocalGameLevel("local-1", storage)).toBe("club");
    storage.setItem("bg.games.local-2.level", "grandmaster");
    expect(loadLocalGameLevel("local-2", storage)).toBeNull();
  });

  it("goes with the record when the game is removed", () => {
    const storage = new MemoryStorage();
    saveLocalGame("local-3", { seed: 3, length: 0, rules: { jacoby: true, beavers: false, autoDoubles: false }, turns: [] }, storage);
    saveLocalGameLevel("local-3", "beginner", storage);
    removeLocalGame("local-3", storage);
    expect(storage.getItem("bg.games.local-3")).toBeNull();
    expect(storage.getItem("bg.games.local-3.level")).toBeNull();
  });

  it("degrades to nothing stored without storage or when storage throws", () => {
    expect(saveLocalGameLevel("local-1", "club", null)).toBe(false);
    expect(loadLocalGameLevel("local-1", null)).toBeNull();
    expect(saveLocalGameLevel("local-1", "club", throwing)).toBe(false);
    expect(loadLocalGameLevel("local-1", throwing)).toBeNull();
  });
});
