import { StaticBoard } from "./StaticBoard";

/** Pip count of either side in the opening position. */
export const OPENING_PIPS = 167;

/** The landing hero: the opening position on a shadowed table with a broadcast-style caption. */
export function HeroBoard() {
  return (
    <figure className="hero-board">
      <StaticBoard className="hero-board__table" />
      <figcaption className="hero-board__caption">
        <span>Opening position</span>
        <span>{String(OPENING_PIPS)} pips a side</span>
        <span>Cube centred</span>
      </figcaption>
    </figure>
  );
}
