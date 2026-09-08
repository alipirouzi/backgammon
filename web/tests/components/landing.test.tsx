// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Landing } from "../../src/components/landing/Landing";
import { THEME_STORAGE_KEY } from "../../src/components/landing/theme-store";

const THEME_NAMES = ["Tournament Heritage", "Broadcast Modern", "Editorial Light"];

/** Node's experimental Web Storage global shadows jsdom's; install a memory Storage when it is unusable. */
class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

beforeAll(() => {
  const existing = (window as { localStorage?: Partial<Storage> }).localStorage;
  if (typeof existing?.clear !== "function") {
    Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
  }
});

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(cleanup);

async function openChooser() {
  const toggle = screen.getByRole("button", { name: "Choose your board" });
  await userEvent.click(toggle);
  return toggle;
}

describe("<Landing>", () => {
  it("keeps the board mount and the exact h1 the deploy check looks for", () => {
    render(<Landing />);
    const main = document.getElementById("board-mount");
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe("MAIN");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/^Backgammon$/);
  });

  it("shows the opening position as a decorative hero board", () => {
    const { container } = render(<Landing />);
    const hero = container.querySelector(".hero-board");
    expect(hero).not.toBeNull();
    expect(hero?.querySelectorAll('[data-testid^="checker-"]')).toHaveLength(30);
    // Decorative: not in the accessibility tree and not in the Tab order.
    expect(screen.queryAllByRole("button", { name: /^Point \d+/ })).toHaveLength(0);
    const inertHost = hero?.querySelector("[inert]");
    expect(inertHost).not.toBeNull();
    expect(inertHost).toHaveAttribute("aria-hidden", "true");
  });

  it("links the primary action to /play/new", () => {
    render(<Landing />);
    const cta = screen.getByRole("link", { name: "Play the computer" });
    expect(cta).toHaveAttribute("href", "/play/new");
  });

  it("reveals the three board previews from 'Choose your board'", async () => {
    render(<Landing />);
    const toggle = screen.getByRole("button", { name: "Choose your board" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Tournament Heritage/ })).toBeNull();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = document.getElementById(panelId ?? "");
    expect(panel).not.toBeNull();
    expect(panel).toBeVisible();
    const options = within(panel as HTMLElement)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining(THEME_NAMES.map((n) => expect.stringContaining(n))));
    expect(options).toHaveLength(3);
    // Each preview renders a full board in its own theme scope, kept out of the a11y tree.
    const previews = (panel as HTMLElement).querySelectorAll("[data-theme][inert]");
    expect(Array.from(previews).map((p) => p.getAttribute("data-theme"))).toEqual(["heritage", "broadcast", "editorial"]);
    for (const p of previews) expect(p.querySelectorAll('[data-testid^="checker-"]')).toHaveLength(30);
    expect(screen.queryAllByRole("button", { name: /^Point \d+/ })).toHaveLength(0);
  });

  it("marks heritage as the current board by default", async () => {
    render(<Landing />);
    await openChooser();
    expect(screen.getByRole("button", { name: /Tournament Heritage/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Broadcast Modern/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("applies and persists a chosen theme", async () => {
    render(<Landing />);
    await openChooser();
    await userEvent.click(screen.getByRole("button", { name: /Broadcast Modern/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("broadcast");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("broadcast");
    expect(screen.getByRole("button", { name: /Broadcast Modern/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Tournament Heritage/ })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: /Editorial Light/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("editorial");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("editorial");
  });

  it("restores a stored theme when the document has none yet", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "editorial");
    render(<Landing />);
    await openChooser();
    expect(document.documentElement.getAttribute("data-theme")).toBe("editorial");
    expect(screen.getByRole("button", { name: /Editorial Light/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows a theme already set on the document (e.g. by the layout's inline script)", async () => {
    document.documentElement.setAttribute("data-theme", "broadcast");
    render(<Landing />);
    await openChooser();
    expect(screen.getByRole("button", { name: /Broadcast Modern/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the chooser again from the same toggle", async () => {
    render(<Landing />);
    const toggle = await openChooser();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Tournament Heritage/ })).toBeNull();
  });
});
