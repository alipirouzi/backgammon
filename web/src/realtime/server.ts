/**
 * The realtime process's network layer (plan Task 4; spec §5.4, §8): a plain
 * `http.Server` with `GET /healthz` and a `ws` server on `/ws`. Everything
 * about the game lives in `GameSession` (session.ts) and the registry
 * (sessions.ts, Task 3); this module only authenticates sockets, routes
 * frames and fans replies out.
 *
 * Upgrade: `GET /ws?game=<gameId>` with the seat cookie of that game
 * (`auth.ts`), from an `Origin` the policy allows (`origin.ts`: the
 * `ALLOWED_ORIGINS` list, or none outside production). Anything else is
 * refused before the handshake with a real HTTP status: 404 (other path,
 * unknown game), 400 (no `game`), 403 (`Origin` not allowed), 401 (no or
 * wrong seat cookie), 503 (shutting down), 500 (the check itself failed).
 * A seat holds at most `MAX_SOCKETS_PER_SEAT` sockets: when one more
 * attaches, the oldest is closed with `TOO_MANY_SOCKETS_CLOSE_CODE` (4001).
 *
 * Frames: parsed with `protocol.ts`, counted against the seat's rate limit
 * (`connections.ts`, one budget per seat of a game shared by all its
 * sockets; over it → `rejected rateLimited`), handed to `session.handle(seat,
 * msg)`; `reply` goes to the sender, `broadcast` to every socket of the
 * game. A frame over 8 KiB closes the socket with 1009. When `handle`
 * throws (persistence failed — the session's state is untouched) the socket
 * is closed with 1011 and the error logged: the browser transport
 * reconnects, gets a snapshot and resends its unacked action (Task 6),
 * which no `rejected` code would make it do.
 *
 * Sessions: a socket holds a registry *lease* (`acquire` → `release`) for
 * its lifetime, which keeps the session in memory; frames are dispatched
 * to `registry.get` so a session the registry rebuilt meanwhile (a finished
 * one after its grace period) is the one that answers.
 *
 * Presence: a seat is online while any of its sockets is open — the server
 * is the source of truth and pushes both seats' flags into the session on
 * every connect and last-socket close, and into any session the registry
 * hands out that it has not synced yet (a rebuilt one starts with nobody
 * online), then broadcasts the resulting `presence`.
 * Heartbeat: the server pings every socket on an interval and terminates
 * one that has sent nothing (frame or pong) for `timeoutMs`.
 *
 * Close codes the server initiates: 1001 on shutdown, 1009 frame too large,
 * 1011 internal error, `ABANDONED_CLOSE_CODE` (4000) when the registry
 * reports the game abandoned (there is no protocol message for it; the
 * client reconnects and finds a read-only session), `TOO_MANY_SOCKETS_CLOSE_CODE`
 * (4001) on the seat's oldest socket when a fifth one attaches.
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { parseSeatCookie, type SeatIndex } from "./auth";
import { ConnectionTable, MAX_SOCKETS_PER_SEAT, type Connection } from "./connections";
import { MAX_FRAME_BYTES } from "./limits";
import type { Logger } from "./log";
import { isOriginAllowed, type OriginPolicy } from "./origin";
import { invalidMessage, parseClientMsg, rejectedMessage, type ClientMsg, type ServerMsg } from "./protocol";
import { errorField, healthHandler, listenOn, refuseUpgrade, textOf } from "./server-io";
import type { HandleResult } from "./session-types";

/** What the server needs of a `GameSession` (structural, so tests can fake it). */
export interface Session {
  handle(seat: SeatIndex, msg: ClientMsg): Promise<HandleResult>;
  setPresence(seat: SeatIndex, online: boolean): ServerMsg[];
}

/** A socket's hold on a session; `release` is idempotent (Task 3's `SessionLease`). */
export interface SessionLease {
  session: Session;
  release(): void;
}

/** What the server needs of the sessions registry (Task 3's `SessionRegistry`, structurally). */
export interface Registry {
  /** The live session of `gameId`, loaded on demand; `null` when no such game exists. */
  get(gameId: string): Promise<Session | null>;
  /** `get` plus a lease that keeps the session in memory while a socket is attached. */
  acquire(gameId: string): Promise<SessionLease | null>;
  /** Called with the game id when the sweep marks a game abandoned. */
  onAbandoned(cb: (gameId: string) => void): void;
  /** Receives the broadcasts a session emits on its own (the next-game timer). */
  onBroadcast(cb: (gameId: string, msgs: ServerMsg[]) => void): void;
  /** Stops the sweep and releases sessions; called once on shutdown. */
  stop(): void | Promise<void>;
}

export interface HeartbeatOptions {
  /** How often every socket is pinged. */
  intervalMs: number;
  /** Silence (no frame, no pong) after which a socket is terminated. */
  timeoutMs: number;
}

export interface RealtimeServerOptions {
  registry: Registry;
  /** `auth.ts`'s `verifySeat` bound to the database. */
  verifySeat: (gameId: string, seat: SeatIndex, secret: string) => Promise<boolean>;
  /** Resolves when the process is healthy (a trivial DB query); `/healthz` is 503 when it rejects. */
  healthCheck: () => Promise<void>;
  /** Which `Origin` headers (or none) may open a socket; anything else is refused with 403. */
  origins: OriginPolicy;
  log: Logger;
  heartbeat?: HeartbeatOptions;
  /** Clock in milliseconds (rate limit, heartbeat); `Date.now` by default. */
  now?: () => number;
}

export interface RealtimeServer {
  readonly http: HttpServer;
  listen(port: number, host: string): Promise<AddressInfo>;
  /** Closes every socket with 1001, the listener and the registry; idempotent. */
  shutdown(): Promise<void>;
}

export { HEALTH_PATH } from "./server-io";

export const WS_PATH = "/ws";
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How long shutdown waits for close handshakes before terminating sockets. */
export const SHUTDOWN_GRACE_MS = 2_000;
export const SHUTDOWN_CLOSE_CODE = 1001;
export const INTERNAL_ERROR_CLOSE_CODE = 1011;
export const ABANDONED_CLOSE_CODE = 4000;
/** Sent to the oldest socket of a seat when the seat opens one beyond `MAX_SOCKETS_PER_SEAT`. */
export const TOO_MANY_SOCKETS_CLOSE_CODE = 4001;

const SEATS: readonly SeatIndex[] = [0, 1];

export function createRealtimeServer(options: RealtimeServerOptions): RealtimeServer {
  const { registry, verifySeat, healthCheck, log, origins } = options;
  const now = options.now ?? Date.now;
  const heartbeat = options.heartbeat ?? { intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS };
  const connections = new ConnectionTable(now);
  /** The session object of each game whose presence the server last pushed; a different one is a rebuild to correct. */
  const synced = new Map<string, Session>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;

  const send = (ws: WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const broadcast = (gameId: string, msgs: readonly ServerMsg[]): void => {
    if (msgs.length === 0) {
      return;
    }
    for (const conn of connections.of(gameId)) {
      for (const msg of msgs) {
        send(conn.ws, msg);
      }
    }
  };

  /** Pushes the server's view of who is online into `session` and broadcasts the result. */
  const syncPresence = (gameId: string, session: Session): void => {
    const msgs = SEATS.flatMap((seat) => session.setPresence(seat, connections.seatOnline(gameId, seat)));
    if (connections.of(gameId).length > 0) {
      synced.set(gameId, session);
    } else {
      synced.delete(gameId);
    }
    broadcast(gameId, msgs.slice(-1));
  };

  /** `syncPresence` for a session the registry handed out that the server has not pushed presence into yet. */
  const syncIfRebuilt = (gameId: string, session: Session): void => {
    if (synced.get(gameId) !== session) {
      syncPresence(gameId, session);
    }
  };

  const http = createServer(healthHandler(healthCheck, log));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const handleFrame = async (conn: Connection, data: RawData): Promise<void> => {
    conn.lastSeenAt = now();
    const parsed = parseClientMsg(textOf(data));
    const id = parsed.ok ? parsed.msg.id : parsed.id;
    if (!connections.hit(conn.gameId, conn.seat)) {
      log.debug("rate limited", { gameId: conn.gameId, seat: conn.seat });
      send(conn.ws, rejectedMessage(id ?? "", "rateLimited", "too many messages; wait a moment"));
      return;
    }
    if (!parsed.ok) {
      log.debug("invalid frame", { gameId: conn.gameId, seat: conn.seat, error: parsed.error });
      send(conn.ws, invalidMessage(parsed.id, parsed.error));
      return;
    }
    const session = await registry.get(conn.gameId);
    if (session === null) {
      log.error("session gone for open socket", { gameId: conn.gameId, seat: conn.seat });
      conn.ws.close(INTERNAL_ERROR_CLOSE_CODE, "session unavailable");
      return;
    }
    syncIfRebuilt(conn.gameId, session);
    let result: HandleResult;
    try {
      result = await session.handle(conn.seat, parsed.msg);
    } catch (error: unknown) {
      log.error("session failed to handle message", { gameId: conn.gameId, seat: conn.seat, type: parsed.msg.type, error: errorField(error) });
      conn.ws.close(INTERNAL_ERROR_CLOSE_CODE, "internal error");
      return;
    }
    for (const msg of result.reply) {
      send(conn.ws, msg);
    }
    broadcast(conn.gameId, result.broadcast);
  };

  const onConnectionClosed = (conn: Connection): void => {
    connections.remove(conn);
    conn.lease.release();
    log.info("socket closed", { gameId: conn.gameId, seat: conn.seat });
    if (connections.of(conn.gameId).length === 0) {
      synced.delete(conn.gameId);
    }
    if (closing || connections.seatOnline(conn.gameId, conn.seat)) {
      return;
    }
    registry.get(conn.gameId).then(
      (session) => {
        if (session !== null) {
          syncPresence(conn.gameId, session);
        }
      },
      (error: unknown) => log.error("presence update failed", { gameId: conn.gameId, seat: conn.seat, error: errorField(error) }),
    );
  };

  const attach = (ws: WebSocket, gameId: string, seat: SeatIndex, lease: SessionLease): void => {
    const conn: Connection = {
      ws,
      gameId,
      seat,
      lease,
      lastSeenAt: now(),
      closed: new Promise((resolve) => ws.once("close", () => resolve())),
    };
    connections.add(conn);
    ws.on("error", (error) => log.warn("socket error", { gameId, seat, error }));
    ws.on("pong", () => {
      conn.lastSeenAt = now();
    });
    ws.on("message", (data) => {
      handleFrame(conn, data).catch((error: unknown) => {
        log.error("frame handling failed", { gameId, seat, error: errorField(error) });
        ws.close(INTERNAL_ERROR_CLOSE_CODE, "internal error");
      });
    });
    ws.on("close", () => onConnectionClosed(conn));
    log.info("socket opened", { gameId, seat });
    for (const oldest of connections.beyondCap(gameId, seat)) {
      log.info("closing the seat's oldest socket: too many connections", { gameId, seat, max: MAX_SOCKETS_PER_SEAT });
      oldest.ws.close(TOO_MANY_SOCKETS_CLOSE_CODE, "too many connections");
    }
    syncPresence(gameId, lease.session);
  };

  /** The HTTP status that refuses the upgrade before any database work, or `null` to go on; `cookie` is the parsed seat cookie. */
  const refusalOf = (req: IncomingMessage, gameId: string | null, cookie: ReturnType<typeof parseSeatCookie>): number | null => {
    if (gameId === null || gameId.length === 0) {
      return 400;
    }
    if (!isOriginAllowed(req.headers.origin, origins)) {
      log.info("upgrade refused: origin not allowed", { gameId, origin: req.headers.origin ?? null });
      return 403;
    }
    if (cookie === null) {
      return 401;
    }
    return null;
  };

  const onUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      refuseUpgrade(socket, 404);
      return;
    }
    const gameId = url.searchParams.get("game");
    const cookie = gameId === null ? null : parseSeatCookie(req.headers.cookie, gameId);
    const refusal = refusalOf(req, gameId, cookie);
    if (refusal !== null || gameId === null || cookie === null) {
      refuseUpgrade(socket, refusal ?? 500);
      return;
    }
    let lease: SessionLease | null;
    try {
      if (!(await verifySeat(gameId, cookie.seat, cookie.secret))) {
        log.info("upgrade refused: seat check failed", { gameId, seat: cookie.seat });
        refuseUpgrade(socket, 401);
        return;
      }
      lease = await registry.acquire(gameId);
    } catch (error: unknown) {
      log.error("upgrade failed", { gameId, error: errorField(error) });
      refuseUpgrade(socket, 500);
      return;
    }
    if (lease === null) {
      refuseUpgrade(socket, 404);
      return;
    }
    if (closing || socket.destroyed) {
      lease.release();
      if (closing) {
        refuseUpgrade(socket, 503);
      }
      return;
    }
    const seat = cookie.seat;
    // `ws` aborts a malformed handshake itself (400) and never calls back: the lease must not outlive that socket.
    const releaseOnAbort = (): void => lease.release();
    socket.once("close", releaseOnAbort);
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", releaseOnAbort);
      attach(ws, gameId, seat, lease);
    });
  };

  http.on("upgrade", (req, socket, head) => {
    onUpgrade(req, socket, head).catch((error: unknown) => {
      log.error("upgrade handler threw", { error: errorField(error) });
      refuseUpgrade(socket, 500);
    });
  });

  const tick = (): void => {
    const deadline = now() - heartbeat.timeoutMs;
    for (const conn of connections.all()) {
      if (conn.lastSeenAt < deadline) {
        log.info("terminating unresponsive socket", { gameId: conn.gameId, seat: conn.seat });
        conn.ws.terminate();
      } else if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();
      }
    }
  };
  const heartbeatTimer = setInterval(tick, heartbeat.intervalMs);

  registry.onAbandoned((gameId) => {
    for (const conn of connections.of(gameId)) {
      conn.ws.close(ABANDONED_CLOSE_CODE, "game abandoned");
    }
  });
  registry.onBroadcast((gameId, msgs) => broadcast(gameId, msgs));

  const closeSockets = async (): Promise<void> => {
    const open = connections.all();
    for (const conn of open) {
      conn.ws.close(SHUTDOWN_CLOSE_CODE, "server shutting down");
    }
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    await Promise.race([Promise.all(open.map((c) => c.closed)), grace]);
    clearTimeout(graceTimer);
    for (const conn of connections.all()) {
      conn.ws.terminate();
    }
  };

  const shutdown = async (): Promise<void> => {
    closing = true;
    clearInterval(heartbeatTimer);
    log.info("shutting down", { sockets: connections.all().length });
    await closeSockets();
    wss.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    await registry.stop();
    log.info("shut down");
  };

  return {
    http,
    listen: async (port, host) => {
      const address = await listenOn(http, port, host);
      log.info("listening", { host: address.address, port: address.port });
      return address;
    },
    shutdown: () => {
      shutdownPromise ??= shutdown();
      return shutdownPromise;
    },
  };
}
