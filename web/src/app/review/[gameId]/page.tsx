import type { Metadata } from "next";

import { parseLevel } from "../../play/game-options";
import { ReviewGame } from "./ReviewGame";

export const metadata: Metadata = {
  title: "Review · Backgammon",
};

interface ReviewPageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * `/review/<gameId>`: the post-game review of a finished game. A
 * `local-<seed>` id is read from this browser's storage, any other id from
 * the games API, both on the client (`ReviewGame`), so the server renders
 * the frame and a loading line. `?level=` names the computer's level for
 * the captions (the finish banner adds it; a local id carries none).
 */
export default async function ReviewPage({ params, searchParams }: ReviewPageProps) {
  const [{ gameId }, search] = await Promise.all([params, searchParams]);
  return (
    <main className="review" aria-labelledby="review-title">
      {/* Visually hidden (review.css): the summary's result heading is the visible title. */}
      <h1 id="review-title" className="review__title">
        Post-game review
      </h1>
      <ReviewGame gameId={gameId} level={parseLevel(search.level)} />
    </main>
  );
}
