import type { IncomingMessage } from "node:http";

import { parsePositiveIntegerEnv } from "./env-parse.js";

/**
 * Reading an inbound HTTP body under a byte ceiling.
 *
 * Split out of `index.ts` (ISS-8272) because the ceiling and the readers that
 * enforce it are the one concern in that module with no dependency on MCP
 * sessions, transports, or OAuth state — every other entrypoint helper there
 * reaches for at least one of them.
 */

// Read once, at first evaluation of this module. A test that reaches it — even
// indirectly, by importing a module that imports this one — before setting
// `MCP_MAX_REQUEST_BODY_BYTES` freezes the default, and its size assertions then
// measure a bound it never set while still passing.
export const MAX_REQUEST_BODY_BYTES = parsePositiveIntegerEnv(
  "MCP_MAX_REQUEST_BODY_BYTES",
  1_048_576
);

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

/**
 * The ceiling is enforced as chunks arrive rather than against
 * `Content-Length`, so a request that lies about its length or sends none at
 * all is still cut off at the same bound.
 */
export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    totalBytes += bufferChunk.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(bufferChunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  const raw = await readRequestBody(req);
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function hasOversizedContentLength(req: IncomingMessage): boolean {
  const contentLengthHeader = req.headers["content-length"];
  const contentLength = Number(contentLengthHeader ?? 0);
  return (
    Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES
  );
}
