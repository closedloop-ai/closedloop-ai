/**
 * Raw HTTP request/response plumbing for the relay's /health and /dispatch
 * endpoints. Extracted from index.ts so the body-size bound, the JSON response
 * shape, the request-URL parse, and the internal-error responder can be
 * unit-tested directly instead of only through a route.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { log } from "@repo/observability/log";

const MAX_BODY_SIZE = 1_048_576; // 1 MB

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body exceeds 1 MB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Resolve a request's absolute URL, or `null` when it names no valid authority.
 *
 * `req.headers.host` is attacker-controlled and lands in the URL *base*, where
 * any unparseable value throws `ERR_INVALID_URL`. The relay's request handler
 * is `async`, so that throw becomes a rejected promise nothing awaits, and
 * Node's default `--unhandled-rejections=throw` takes the whole process down —
 * pre-auth, on any route, since the parse precedes every routing and auth
 * decision (ISS-8232). Callers answer 400 rather than sanitizing the host: a
 * request that cannot name its own authority does not get routed.
 *
 * `?? "localhost"` reproduces the absent-Host default exactly, and is
 * deliberately not `||` — an empty `Host:` header is a malformed authority
 * rather than an absent one, so it resolves to `null` here.
 */
export function parseRequestUrl(
  req: Pick<IncomingMessage, "url" | "headers">
): URL | null {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

/**
 * Log a dispatch-route failure and answer it, when there is still an open
 * response to answer on.
 *
 * The 1 MB body cap is the one failure that reaches here today, and `readBody`
 * above has already called `req.destroy()` by then, tearing down the shared
 * socket before this runs -- so the client has ALREADY observed a transport
 * error and an unconditional write lands nowhere. The log is the signal that
 * survives that path, which is why it is unconditional and the write is not.
 * Every other throw still answers a real 500 (ISS-7976).
 */
export function respondInternalError(
  res: ServerResponse,
  label: string,
  error: unknown
): void {
  log.error(label, { error });
  const socketGone = !res.socket || res.socket.destroyed;
  if (res.headersSent || res.writableEnded || res.destroyed || socketGone) {
    return;
  }
  jsonResponse(res, 500, { error: "Internal server error" });
}
