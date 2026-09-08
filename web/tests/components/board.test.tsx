// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { Board } from "../../src/components/board/Board";
import type { BoardProps } from "../../src/components/board/Board";
import { openingBoard } from "../../src/components/board/types";
import type { Board as BoardState } from "../../src/components/board/types";

const here = dirname(fileURLToPath(import.meta.url));

function baseProps(overrides: Partial<BoardProps> = {}): BoardProps {
  return {
    board: openingBoard(),
    onRoll: "white",
    dice: null,
    cube: { value: 1, owner: null },
    selectedFrom: null,
    legalTargets: [],
    pending: [],
    onPointClick: vi.fn(),
    onBarClick: vi.fn(),
    onOffClick: vi.fn(),
    perspective: "white",
    ...overrides,
  };
}

function withCounts(edit: (b: BoardState) => void): BoardState {
  const b = openingBoard();
  edit(b);
  return b;
}

afterEach(cleanup);

describe("<Board>", () => {
  it("renders 30 checkers for the opening position with stable test ids", () => {
    const { container } = render(<Board {...baseProps()} />);
    const checkers = container.querySelectorAll('[data-testid^="checker-"]');
    expect(checkers).toHaveLength(30);
    expect(container.querySelector('[data-testid="checker-white-24-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="checker-white-24-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="checker-black-1-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="checker-white-13-4"]')).not.toBeNull();
  });

  it("exposes every point as a labelled button in movement order 24 → 1", () => {
    render(<Board {...baseProps()} />);
    const buttons = screen.getAllByRole("button", { name: /^Point \d+/ });
    expect(buttons).toHaveLength(24);
    expect(buttons[0]).toHaveAccessibleName("Point 24, 2 white checkers");
    expect(buttons[11]).toHaveAccessibleName("Point 13, 5 white checkers");
    expect(buttons[23]).toHaveAccessibleName("Point 1, 2 black checkers");
    expect(screen.getByRole("button", { name: "Point 10, empty" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Point 8, 3 white checkers" })).toBeTruthy();
  });

  it("marks legal targets and reports a click on one", async () => {
    const onPointClick = vi.fn();
    render(<Board {...baseProps({ selectedFrom: 13, legalTargets: [10, 7], onPointClick })} />);
    const target = screen.getByRole("button", { name: /^Point 10/ });
    expect(target).toHaveAttribute("data-legal", "true");
    expect(screen.getByRole("button", { name: /^Point 7/ })).toHaveAttribute("data-legal", "true");
    expect(screen.getByRole("button", { name: /^Point 8/ })).not.toHaveAttribute("data-legal");
    expect(screen.getByRole("button", { name: /^Point 13/ })).toHaveAttribute("data-selected", "true");
    await userEvent.click(target);
    expect(onPointClick).toHaveBeenCalledTimes(1);
    expect(onPointClick).toHaveBeenCalledWith(10);
  });

  it("is keyboard operable: Enter on a focused point fires onPointClick", async () => {
    const onPointClick = vi.fn();
    render(<Board {...baseProps({ legalTargets: [10], onPointClick })} />);
    screen.getByRole("button", { name: /^Point 10/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onPointClick).toHaveBeenCalledWith(10);
  });

  it("lifts the selected checker and rings the legal slot", () => {
    const { container } = render(<Board {...baseProps({ selectedFrom: 13, legalTargets: [10] })} />);
    expect(container.querySelector('[data-testid="checker-white-13-4"]')).toHaveAttribute("data-selected", "true");
    expect(container.querySelector('[data-testid="checker-white-13-3"]')).not.toHaveAttribute("data-selected");
    expect(container.querySelectorAll(".board__target")).toHaveLength(1);
  });

  it("reports bar and off-tray clicks through their own callbacks", async () => {
    const onBarClick = vi.fn();
    const onOffClick = vi.fn();
    const board = withCounts((b) => {
      b.white[24] = 1;
      b.white[0] = 1;
      b.white[6] = 2;
      b.white[25] = 3;
    });
    render(<Board {...baseProps({ board, legalTargets: [0], onBarClick, onOffClick })} />);
    const bar = screen.getByRole("button", { name: "Bar, 1 white checker, 0 black checkers" });
    const off = screen.getByRole("button", { name: "White off tray, 3 checkers, legal destination" });
    expect(off).toHaveAttribute("data-legal", "true");
    expect(screen.getByRole("button", { name: "Black off tray, 0 checkers" })).not.toHaveAttribute("data-legal");
    await userEvent.click(bar);
    await userEvent.click(off);
    expect(onBarClick).toHaveBeenCalledTimes(1);
    expect(onOffClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("checker-white-0-0")).toBeTruthy();
    expect(screen.getByTestId("off-count-white")).toHaveTextContent("3");
  });

  it("shows a stack badge beyond five checkers and still renders every checker", () => {
    const board = withCounts((b) => {
      b.white[13] = 7;
      b.white[24] = 0;
    });
    const { container } = render(<Board {...baseProps({ board })} />);
    expect(container.querySelectorAll('[data-testid^="checker-white-13-"]')).toHaveLength(7);
    expect(screen.getByTestId("stack-badge-13")).toHaveTextContent("7");
    expect(screen.queryByTestId("stack-badge-6")).toBeNull();
  });

  it("renders dice with pips and the doubling cube", () => {
    const { container, rerender } = render(
      <Board {...baseProps({ dice: { hi: 6, lo: 3 }, cube: { value: 1, owner: null } })} />,
    );
    const dice = container.querySelectorAll("[data-testid^='die-']");
    expect(dice).toHaveLength(2);
    expect(dice[0].querySelectorAll(".die__pip")).toHaveLength(6);
    expect(dice[1].querySelectorAll(".die__pip")).toHaveLength(3);
    expect(screen.getByTestId("cube")).toHaveTextContent("64");
    expect(screen.getByTestId("cube")).toHaveAttribute("data-owner", "centred");
    rerender(<Board {...baseProps({ dice: null, cube: { value: 4, owner: "black" } })} />);
    expect(container.querySelectorAll("[data-testid^='die-']")).toHaveLength(0);
    expect(screen.getByTestId("cube")).toHaveTextContent("4");
    expect(screen.getByTestId("cube")).toHaveAttribute("data-owner", "black");
  });

  it("marks pending destinations", () => {
    render(
      <Board
        {...baseProps({
          pending: [{ from: 13, to: 10, hit: false }],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /^Point 10/ })).toHaveAttribute("data-pending", "true");
  });

  it("names legal destinations and the lifted point in the accessible label instead of aria-pressed", () => {
    render(<Board {...baseProps({ selectedFrom: 13, legalTargets: [10, 7] })} />);
    expect(screen.getByRole("button", { name: "Point 10, empty, legal destination" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Point 7, empty, legal destination" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Point 13, 5 white checkers, selected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Point 8, 3 white checkers" })).toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /^Point \d+/ })) expect(b).not.toHaveAttribute("aria-pressed");
  });

  it("labels a lifted bar checker as selected", () => {
    const board = withCounts((b) => {
      b.white[24] = 1;
      b.white[0] = 1; // slot 0 is the bar in the Board's absolute arrays; Move coordinates call it 25
    });
    render(<Board {...baseProps({ board, selectedFrom: 25, legalTargets: [20] })} />);
    expect(screen.getByRole("button", { name: "Bar, 1 white checker, 0 black checkers, selected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Point 20, empty, legal destination" })).toBeInTheDocument();
  });

  it("asks to clear the selection on Escape only while a checker is lifted", async () => {
    const onDeselect = vi.fn();
    const { rerender } = render(<Board {...baseProps({ selectedFrom: 13, legalTargets: [10], onDeselect })} />);
    screen.getByRole("button", { name: /^Point 10/ }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onDeselect).toHaveBeenCalledTimes(1);
    rerender(<Board {...baseProps({ onDeselect })} />);
    screen.getByRole("button", { name: /^Point 10/ }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });
});

describe("themes.css", () => {
  const REQUIRED_TOKENS = [
    "--board-frame",
    "--board-felt",
    "--board-bar",
    "--point-a",
    "--point-b",
    "--checker-white",
    "--checker-white-edge",
    "--checker-black",
    "--checker-black-edge",
    "--die-face",
    "--die-pip",
    "--cube-face",
    "--cube-text",
    "--ui-bg",
    "--ui-fg",
    "--ui-accent",
    "--font-display",
    "--radius-board",
    "--shadow-checker",
    "--ui-muted",
    "--ui-accent-text",
    "--ui-cta-bg",
    "--ui-cta-fg",
  ];
  const css = readFileSync(join(here, "../../src/styles/themes.css"), "utf8");

  function block(theme: string): string {
    const m = css.match(new RegExp(`\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`));
    if (!m) throw new Error(`no block for ${theme}`);
    return m[1];
  }

  function token(theme: string, name: string): string {
    const m = block(theme).match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    if (!m) throw new Error(`${theme} lacks ${name}`);
    return m[1].trim();
  }

  it("defines every binding token in all three themes", () => {
    for (const theme of ["heritage", "broadcast", "editorial"]) {
      for (const name of REQUIRED_TOKENS) expect(token(theme, name)).not.toBe("");
    }
  });

  it("gives each theme a distinct felt and the palette from the plan", () => {
    const felts = ["heritage", "broadcast", "editorial"].map((t) => token(t, "--board-felt"));
    expect(new Set(felts).size).toBe(3);
    expect(token("heritage", "--board-felt")).toBe("#1f3a2e");
    expect(token("heritage", "--ui-accent")).toBe("#d9b75a");
    expect(token("broadcast", "--ui-accent")).toBe("#f5c542");
    expect(token("editorial", "--ui-accent")).toBe("#b86a45");
    expect(token("broadcast", "--font-display")).toMatch(/sans-serif$/);
    expect(token("heritage", "--font-display")).toMatch(/[^-]serif$/);
    expect(token("editorial", "--font-display")).toMatch(/[^-]serif$/);
  });

  it("makes heritage the default on :root", () => {
    expect(css).toMatch(/:root\s*,?\s*(\[data-theme="heritage"\])?\s*\{/);
  });
});
