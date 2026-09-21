/**
 * Plain-HTTP and frame helpers of the realtime server (server.ts), kept
 * apart from the routing so that file stays about authentication, dispatch
 * and lifecycle.
 */

import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { RawData } from "ws";

import type { Logger } from "./log";

export const HEALTH_PATH = "/healthz";

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** Answers a rejected upgrade with a real HTTP response, then drops the connection. */
export function refuseUpgrade(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

/** The plain-HTTP side of the server: `GET /healthz` is 200 while `healthCheck` resolves and 503 (logged) when it rejects; anything else is 404. */
export function healthHandler(healthCheck: () => Promise<void>, log: Logger): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== HEALTH_PATH) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    healthCheck().then(
      () => sendJson(res, 200, { status: "ok" }),
      (error: unknown) => {
        log.warn("health check failed", { error: errorField(error) });
        sendJson(res, 503, { status: "error" });
      },
    );
  };
}

export function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
}

export const errorField = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Starts listening and resolves with the bound address; rejects when the port cannot be bound. */
export function listenOn(http: HttpServer, port: number, host: string): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => {
      http.off("error", reject);
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("realtime server is not listening on a TCP port"));
        return;
      }
      resolve(address);
    });
  });
}
