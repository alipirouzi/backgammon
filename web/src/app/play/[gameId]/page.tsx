import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { seedFromLocalGameId } from "@/game/local-games";

import { LEVEL_LABELS, optionsFromSearch } from "../game-options";
import { PlayGame } from "./PlayGame";

export const metadata: Metadata = {
  title: "At the table · Backgammon",
};

interface PlayPageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * `/play/local-<seed>`: a bot game whose dice come from `<seed>`; format and
 * level come from the query string (see `../game-options.ts`). Any other id
 * is a 404 in this piece (invite games arrive with multiplayer).
 */
export default async function PlayPage({ params, searchParams }: PlayPageProps) {
  const [{ gameId }, search] = await Promise.all([params, searchParams]);
  const seed = seedFromLocalGameId(gameId);
  if (seed === null) {
    notFound();
  }
  const options = optionsFromSearch(search);
  const formatText = options.format === "single" ? "single game" : `match to ${String(options.format.matchTo)}`;
  return (
    <main className="play" aria-labelledby="play-title">
      {/* Visually hidden (table.css): the board is the hero, but heading navigation needs a page-level h1. */}
      <h1 id="play-title" className="play__title">
        {`You against the computer — ${formatText}, ${LEVEL_LABELS[options.level].name.toLowerCase()}`}
      </h1>
      <PlayGame gameId={gameId} seed={seed} format={options.format} level={options.level} />
    </main>
  );
}
