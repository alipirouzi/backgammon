/**
 * `GET /api/games/[id]` — a stored game for the review page: exactly
 * `{ record, result, seats }` (plan: record persistence API), 404 `{ error }`
 * when the id is unknown or cannot be a game id, 500 with a generic message
 * (detail logged) when the lookup or the stored row is broken. While a
 * remote game is still live (`created`/`active`) the record is sent without
 * its seed — the dice stream follows from the seed, and both players know
 * the game id — exactly as the realtime protocol does (`toWireRecord`).
 */

import { toWireRecord } from "@/realtime/protocol-engine";
import { getGame } from "@/server/games";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Prisma cuids: lower-case alphanumerics; anything else is a 404 without a query. */
const GAME_ID = /^[a-z0-9]{1,64}$/;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const { id } = await params;
  if (!GAME_ID.test(id)) {
    return Response.json({ error: "no such game" }, { status: 404, headers: NO_STORE });
  }
  try {
    const game = await getGame(id);
    if (game === null) {
      return Response.json({ error: "no such game" }, { status: 404, headers: NO_STORE });
    }
    const over = game.status === "finished" || game.status === "abandoned";
    return Response.json({ record: toWireRecord(game.record, over), result: game.result, seats: game.seats }, { status: 200, headers: NO_STORE });
  } catch (failure) {
    console.error(`GET /api/games/${id} failed:`, failure instanceof Error ? failure.message : String(failure));
    return Response.json({ error: "the game could not be read" }, { status: 500, headers: NO_STORE });
  }
}
