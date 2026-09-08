"use client";

import type { Cube, Player } from "@/engine/types";

export interface PlayerCardProps {
  player: Player;
  /** Accessible name of the card ("Computer", "You"). */
  name: string;
  /** Small line under the name: bot level or the colour played. */
  caption: string;
  score: number;
  /** `0` for a single (money) game. */
  matchLength: number;
  pips: number;
  cube: Cube;
  onRoll: boolean;
  /** Where the card sits on wide screens; on narrow ones it becomes a bar above (left) or below (right) the board. */
  side: "left" | "right";
}

/**
 * A broadcast-style player panel: name, score, pip count and the cube when
 * this player owns it. The clock slot is reserved but hidden until clocks
 * exist (spec §5.2 "clock (if on)").
 */
export function PlayerCard({ player, name, caption, score, matchLength, pips, cube, onRoll, side }: PlayerCardProps) {
  const ownsCube = cube.owner === player;
  return (
    <section
      className="player-card"
      aria-label={name}
      data-player={player}
      data-side={side}
      data-on-roll={onRoll ? "true" : undefined}
    >
      <header className="player-card__head">
        <span className="player-card__checker" aria-hidden="true" />
        <div className="player-card__who">
          <h2 className="player-card__name">{name}</h2>
          <p className="player-card__caption">{caption}</p>
        </div>
      </header>

      <dl className="player-card__stats">
        <div className="player-card__stat player-card__stat--score">
          <dt>{matchLength === 0 ? "Points" : "Score"}</dt>
          <dd>
            <span className="player-card__score">{String(score)}</span>
            {matchLength > 0 ? <span className="player-card__of">{`/${String(matchLength)}`}</span> : null}
          </dd>
        </div>
        <div className="player-card__stat">
          <dt>Pips</dt>
          <dd>{String(pips)}</dd>
        </div>
        <div className="player-card__stat player-card__stat--clock" hidden>
          <dt>Clock</dt>
          <dd>—</dd>
        </div>
        {ownsCube ? (
          <div className="player-card__stat player-card__stat--cube">
            <dt>Cube</dt>
            <dd>
              <span className="player-card__cube-value">{String(cube.value)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <footer className="player-card__foot">
        <p className="player-card__turn" aria-hidden={onRoll ? undefined : "true"}>
          {onRoll ? "On roll" : " "}
        </p>
      </footer>
    </section>
  );
}
