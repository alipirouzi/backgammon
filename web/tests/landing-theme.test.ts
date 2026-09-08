import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeId,
  readDocumentTheme,
  readStoredTheme,
} from "../src/components/landing/theme-store";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

class FakeRoot {
  readonly attrs = new Map<string, string>();
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
}

describe("landing theme store helpers", () => {
  it("uses the shared localStorage key and heritage as the default", () => {
    expect(THEME_STORAGE_KEY).toBe("bg.theme");
    expect(DEFAULT_THEME).toBe("heritage");
  });

  it("accepts exactly the three theme ids", () => {
    expect(isThemeId("heritage")).toBe(true);
    expect(isThemeId("broadcast")).toBe(true);
    expect(isThemeId("editorial")).toBe(true);
    expect(isThemeId("dark")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(42)).toBe(false);
  });

  it("reads a raw or JSON-encoded stored id and rejects anything else", () => {
    const storage = new MemoryStorage();
    expect(readStoredTheme(storage)).toBeNull();
    storage.setItem(THEME_STORAGE_KEY, "broadcast");
    expect(readStoredTheme(storage)).toBe("broadcast");
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify("editorial"));
    expect(readStoredTheme(storage)).toBe("editorial");
    storage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readStoredTheme(storage)).toBeNull();
    expect(readStoredTheme(null)).toBeNull();
  });

  it("treats a storage that throws as empty", () => {
    expect(readStoredTheme(new ThrowingStorage())).toBeNull();
  });

  it("reads the document theme with a heritage fallback", () => {
    const root = new FakeRoot();
    expect(readDocumentTheme(root)).toBe("heritage");
    root.setAttribute("data-theme", "editorial");
    expect(readDocumentTheme(root)).toBe("editorial");
    root.setAttribute("data-theme", "bogus");
    expect(readDocumentTheme(root)).toBe("heritage");
  });

  it("applies a theme to the root and persists the raw id", () => {
    const root = new FakeRoot();
    const storage = new MemoryStorage();
    applyTheme("broadcast", { root, storage });
    expect(root.getAttribute("data-theme")).toBe("broadcast");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("broadcast");
  });

  it("still sets the attribute when persistence fails", () => {
    const root = new FakeRoot();
    expect(() => applyTheme("editorial", { root, storage: new ThrowingStorage() })).not.toThrow();
    expect(root.getAttribute("data-theme")).toBe("editorial");
  });
});
