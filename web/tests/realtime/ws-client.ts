// Test-side transport for the realtime server suite: a `ws` client with an
// inbox (a frame that arrives before a test waits for it is not lost), an
// upgrade helper that surfaces the refusing HTTP status, and plain HTTP GET.
// Vitest-free apart from types so it can be reused by other suites.

import { request } from "node:http";

import WebSocket from "ws";

import { serverMsgSchema, type ServerMsg, type ServerMsgOf } from "../../src/realtime/protocol";

/** A connected client with an inbox, so a frame that arrives before a test waits for it is not lost. */
export class Client {
  readonly inbox: ServerMsg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: { type: ServerMsg["type"]; resolve: (msg: ServerMsg) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      const msg = serverMsgSchema.parse(JSON.parse(data.toString()));
      const i = this.waiters.findIndex((w) => w.type === msg.type);
      if (i === -1) {
        this.inbox.push(msg);
      } else {
        const [waiter] = this.waiters.splice(i, 1);
        waiter.resolve(msg);
      }
    });
  }

  /** The next frame of `type` (from the inbox first); fails after 3 s. */
  next<T extends ServerMsg["type"]>(type: T): Promise<ServerMsgOf<T>> {
    const queued = this.inbox.findIndex((m) => m.type === type);
    if (queued !== -1) {
      const [msg] = this.inbox.splice(queued, 1);
      return Promise.resolve(msg as ServerMsgOf<T>);
    }
    return new Promise<ServerMsgOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} within 3 s; inbox: ${JSON.stringify(this.inbox.map((m) => m.type))}`)), 3000);
      this.waiters.push({
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg as ServerMsgOf<T>);
        },
      });
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }
}

/** Opens a socket; rejects with the HTTP status when the upgrade is refused. */
export function connect(port: number, cookie: string | null, query: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const headers: { [key: string]: string } = cookie === null ? {} : { cookie };
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws${query}`, { headers, ...options });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      reject(new Error(`status ${String(res.statusCode)}`));
    });
    ws.on("error", (error) => reject(error));
    ws.on("open", () => resolve(new Client(ws)));
  });
}

export function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
}

/** Sends a raw upgrade request with `headers` and resolves with the HTTP status the server answered (never completes a handshake). */
export function rawUpgrade(port: number, path: string, headers: { [key: string]: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", ...headers },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
