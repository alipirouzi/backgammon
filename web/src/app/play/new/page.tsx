import type { Metadata } from "next";

import { parseFormat, parseLevel, parseSeed } from "../game-options";
import { NewGameForm } from "./NewGameForm";

export const metadata: Metadata = {
  title: "New game · Backgammon",
};

interface NewGamePageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * `/play/new`: choose format, level and board, then start. `?seed=` pins the
 * dice (used by the e2e suite); `?format=`/`?level=` preselect the options.
 */
export default async function NewGamePage({ searchParams }: NewGamePageProps) {
  const params = await searchParams;
  return (
    <main className="new-game" aria-labelledby="new-game-title">
      <NewGameForm seed={parseSeed(params.seed)} initialFormat={parseFormat(params.format)} initialLevel={parseLevel(params.level)} />
    </main>
  );
}
