/**
 * In-memory HTTP request/response doubles for the desktop gateway router tests.
 *
 * Extracted from `gateway-server.test.ts` so that file carries the suites while
 * this module owns one responsibility: standing in for `node:http`'s
 * `IncomingMessage`/`ServerResponse` pair so a `GatewayRouter` can be driven
 * directly, without binding a socket.
 *
 * `TestResponse` records status, headers, and the written body (as buffers, so
 * streamed chunks and binary payloads survive) and resolves the router's
 * `finish` signal; `dispatchMockRequest` feeds a router one request built from
 * plain values and returns the settled response.
 */
import { EventEmitter } from "node:events";
import type http from "node:http";
import { Readable } from "node:stream";
import type { GatewayRouter } from "../src/server/router.js";

export class TestResponse extends EventEmitter {
  statusCode = 200;
  finished = false;
  socket = { setNoDelay: () => {} };
  readonly headers = new Map<string, string | number | readonly string[]>();
  readonly chunks: Buffer[] = [];

  /**
   * ISS-5299: streaming gateway handlers gate their writes on the real
   * `ServerResponse` liveness flags — `codex.ts` guards every SSE write with
   * `if (!response.destroyed && response.writable)`. Leaving these undefined
   * made the guard false, so the writes were skipped and a suite driving the
   * handler passed while covering nothing.
   */
  destroyed = false;
  writable = true;

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {}

  /**
   * ISS-5299: simulate the client hanging up. Streaming handlers register
   * `response.once("close", …)` to stop their keepalive interval, so without a
   * way to fire it that timer never clears and can leak the test process. This
   * is also the only route to the client-disconnect branches.
   */
  simulateClose(): void {
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }

  write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error) => void)
  ): boolean {
    this.appendChunk(chunk, encodingOrCallback);
    return true;
  }

  end(
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void
  ): this {
    if (chunk != null && typeof chunk !== "function") {
      this.appendChunk(chunk, encodingOrCallback);
    }
    this.finished = true;
    this.writable = false;
    this.emit("finish");
    // ISS-5299: `end(callback)`, `end(payload, callback)` and
    // `end(payload, encoding, callback)` are ALL real `ServerResponse`
    // signatures, and `update-and-restart.ts` does its actual work (and clears
    // a 30s safety timer) only inside that callback. Dropping it covered
    // nothing and leaked the timer. All three forms are honoured so the double
    // cannot silently swallow the callback for the one overload it missed.
    endCallbackOf(chunk, encodingOrCallback, callback)?.();
    return this;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.text()) as Record<string, unknown>;
  }

  private appendChunk(
    chunk: unknown,
    encodingOrCallback?:
      | BufferEncoding
      | ((error?: Error) => void)
      | (() => void)
  ): void {
    if (typeof chunk === "string") {
      this.chunks.push(
        Buffer.from(
          chunk,
          typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8"
        )
      );
      return;
    }
    if (Buffer.isBuffer(chunk)) {
      this.chunks.push(chunk);
      return;
    }
    if (chunk instanceof Uint8Array) {
      this.chunks.push(Buffer.from(chunk));
    }
  }
}

/**
 * Pick the completion callback out of `end`'s overloads: `end(callback)` puts it
 * first, `end(payload, callback)` second, `end(payload, encoding, callback)`
 * third. Returns null when none of those forms was used.
 */
function endCallbackOf(
  chunk: unknown,
  encodingOrCallback: BufferEncoding | (() => void) | undefined,
  callback: (() => void) | undefined
): (() => void) | null {
  if (typeof chunk === "function") {
    return chunk as () => void;
  }
  if (typeof encodingOrCallback === "function") {
    return encodingOrCallback;
  }
  if (typeof callback === "function") {
    return callback;
  }
  return null;
}

export async function dispatchMockRequest(input: {
  router: GatewayRouter;
  method?: string;
  path: string;
  headers?: http.IncomingHttpHeaders;
  chunks?: Array<string | Buffer>;
  remoteAddress?: string;
}): Promise<TestResponse> {
  const request = Readable.from(input.chunks ?? []) as Readable & {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    socket: { remoteAddress?: string };
  };
  request.method = input.method ?? "POST";
  request.url = input.path;
  request.headers = input.headers ?? {};
  request.socket = { remoteAddress: input.remoteAddress ?? "127.0.0.1" };

  const response = new TestResponse();
  await input.router.handle(
    request as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );
  if (!response.finished) {
    await new Promise<void>((resolve) =>
      response.once("finish", () => resolve())
    );
  }
  return response;
}
