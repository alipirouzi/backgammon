import { describe, expect, it } from "vitest";
import {
  BAR_W,
  FRAME,
  HALF_H,
  VIEW_H,
  VIEW_W,
  barX,
  checkerCenter,
  checkerRadius,
  isTopPoint,
  offTrayX,
  pointBaseY,
  pointX,
  stackOffset,
  toAbsolute,
} from "../src/components/board/geometry";

const points = Array.from({ length: 24 }, (_, i) => i + 1);

describe("board geometry", () => {
  it("uses the binding frame: viewBox 1000x700, frame 24, bar 60", () => {
    expect(VIEW_W).toBe(1000);
    expect(VIEW_H).toBe(700);
    expect(FRAME).toBe(24);
    expect(BAR_W).toBe(60);
    expect(HALF_H).toBe((700 - 2 * 24) / 2);
  });

  it("mirrors columns vertically: point p sits above/below point 25 - p", () => {
    for (let p = 1; p <= 12; p++) {
      expect(pointX(p)).toBe(pointX(25 - p));
    }
  });

  it("orders the bottom row 12…7 | bar | 6…1 from left to right", () => {
    const bottom = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(pointX);
    for (let i = 1; i < bottom.length; i++) expect(bottom[i]).toBeGreaterThan(bottom[i - 1]);
    expect(pointX(7)).toBeLessThan(barX());
    expect(barX()).toBeLessThan(pointX(6));
  });

  it("orders the top row 13…18 | bar | 19…24 from left to right", () => {
    const top = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].map(pointX);
    for (let i = 1; i < top.length; i++) expect(top[i]).toBeGreaterThan(top[i - 1]);
    expect(pointX(18)).toBeLessThan(barX());
    expect(barX()).toBeLessThan(pointX(19));
  });

  it("spaces columns evenly within each half and by bar + pitch across the bar", () => {
    const pitch = pointX(11) - pointX(12);
    for (let p = 12; p > 7; p--) expect(pointX(p - 1) - pointX(p)).toBe(pitch);
    for (let p = 6; p > 1; p--) expect(pointX(p - 1) - pointX(p)).toBe(pitch);
    expect(pointX(6) - pointX(7)).toBe(BAR_W + pitch);
    expect(pointX(12) - pitch / 2).toBe(FRAME);
    expect(barX() - BAR_W / 2).toBe(pointX(7) + pitch / 2);
  });

  it("keeps every column inside the frame and left of the off trays", () => {
    for (const p of points) {
      expect(pointX(p) - checkerRadius()).toBeGreaterThanOrEqual(FRAME);
      expect(pointX(p) + checkerRadius()).toBeLessThan(offTrayX("white"));
    }
    expect(offTrayX("white")).toBe(offTrayX("black"));
    expect(offTrayX("white")).toBeLessThan(VIEW_W - FRAME);
  });

  it("puts 13..24 on the top edge and 1..12 on the bottom edge", () => {
    for (const p of points) {
      expect(isTopPoint(p)).toBe(p >= 13);
      expect(pointBaseY(p)).toBe(p >= 13 ? FRAME : VIEW_H - FRAME);
    }
  });

  it("stacks five checkers touching, then compresses", () => {
    const r = checkerRadius();
    for (let n = 0; n < 5; n++) expect(stackOffset(n)).toBe(r + n * 2 * r);
    expect(stackOffset(4) + r).toBeLessThanOrEqual(HALF_H);
    expect(stackOffset(5, 6)).toBeLessThan(stackOffset(4, 6) + 2 * r);
    expect(stackOffset(0, 15)).toBe(r);
  });

  it("fits fifteen stacked checkers within half the board height", () => {
    const r = checkerRadius();
    for (let n = 0; n < 15; n++) {
      expect(stackOffset(n, 15) + r).toBeLessThanOrEqual(HALF_H);
      if (n > 0) expect(stackOffset(n, 15)).toBeGreaterThan(stackOffset(n - 1, 15));
    }
  });

  it("places checker centres growing away from the point base", () => {
    const r = checkerRadius();
    expect(checkerCenter(6, 0, 5)).toEqual({ x: pointX(6), y: VIEW_H - FRAME - r });
    expect(checkerCenter(6, 1, 5).y).toBe(VIEW_H - FRAME - 3 * r);
    expect(checkerCenter(19, 0, 5)).toEqual({ x: pointX(19), y: FRAME + r });
    expect(checkerCenter(19, 1, 5).y).toBe(FRAME + 3 * r);
  });

  it("converts mover-relative points to absolute numbering", () => {
    expect(toAbsolute("white", 13)).toBe(13);
    expect(toAbsolute("black", 13)).toBe(12);
    expect(toAbsolute("black", 1)).toBe(24);
    expect(toAbsolute("white", 25)).toBe(25);
    expect(toAbsolute("black", 25)).toBe(25);
    expect(toAbsolute("black", 0)).toBe(0);
  });
});
