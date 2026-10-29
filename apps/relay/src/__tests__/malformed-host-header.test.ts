/**
 * ISS-8232 — a malformed `Host` header must not be able to kill the relay.
 *
 * The request handler resolves `req.url` against `http://<Host>`, so the
 * attacker-controlled header lands in the URL base. llhttp accepts every form
 * below and dispatches the request, so the unparseable value reaches the
 * constructor: before the guard, the resulting `ERR_INVALID_URL` escaped the
 * `async` handler as an unhandled rejection and exited the process — pre-auth,
 * ahead of every routing and auth decision, on a bare `GET /health`.
 *
 * Each malformed case therefore asserts BOTH halves. The 400 alone would still
 * pass if a throw were merely caught somewhere useless, so every malformed case
 * follows it with a well-formed request on a NEW connection: that second
 * response can only arrive from a process that is still running. It is awaited,
 * never slept on.
 */

import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reserveTestPort } from "./helpers/reserve-test-port.js";

const TEST_PORT = await reserveTestPort(31_000, 1500);
const TEST_SECRET = "test-internal-secret";
const TEST_API_URL = "http://127.0.0.1:19877";
const ORIGINAL_ENV = { ...process.env };

/** Failsafe only — a hung socket must fail the case, not stall the suite. */
const RAW_SOCKET_TIMEOUT_MS = 5000;

/**
 * Every case below states its own budget rather than inheriting Vitest's
 * default, which is 5000ms — the same as the failsafe above, so it would fire
 * first on a slow runner and report a bare test timeout in place of the useful
 * `No response for Host: …`. Derived from that failsafe so the two cannot
 * drift: each is twice the socket budget the case can actually spend, and a
 * malformed case spends it twice because it issues a second request to prove
 * the process is still serving.
 */
const ONE_REQUEST_CASE_TIMEOUT_MS = RAW_SOCKET_TIMEOUT_MS * 2;
const TWO_REQUEST_CASE_TIMEOUT_MS = RAW_SOCKET_TIMEOUT_MS * 4;

const STATUS_400_LINE = /^HTTP\/1\.1 400\b/;
const STATUS_200_LINE = /^HTTP\/1\.1 200\b/;

/** RFC 9112 request-target forms a client may put on the request line. */
const ORIGIN_FORM_TARGET = "/health";
const ABSOLUTE_FORM_TARGET = "http://relay.internal/health";

let stopRelay: (() => Promise<void>) | null = null;

vi.mock("socket.io", () => ({
  Server: class MockServer {
    // Engine.IO stub: index.ts attaches a `connection_error` listener to
    // `io.engine` at module load, so a Server double without one crashes on import.
    engine = { on: vi.fn() };
    of() {
      return { use: vi.fn(), on: vi.fn() };
    }
    close() {
      return Promise.resolve();
    }
  },
}));

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.RELAY_PORT = String(TEST_PORT);
  process.env.CLOSEDLOOP_API_URL = TEST_API_URL;

  const relayModule = await import("../index");
  await relayModule.startRelayServer("127.0.0.1");
  stopRelay = relayModule.stopRelayServer;
}, 30_000);

afterAll(async () => {
  if (stopRelay) {
    await stopRelay();
  }
  process.env = { ...ORIGINAL_ENV };
});

/**
 * Issue a raw `GET` for `requestTarget` carrying `hostHeader` verbatim and
 * resolve the whole response text. Bypasses `node:http`'s client, which would
 * refuse to send most of these values.
 */
function rawHealthRequest(
  hostHeader: string,
  requestTarget = ORIGIN_FORM_TARGET
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(TEST_PORT, "127.0.0.1", () => {
      socket.write(
        `GET ${requestTarget} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`
      );
    });

    let received = "";
    socket.setTimeout(RAW_SOCKET_TIMEOUT_MS, () => {
      socket.destroy(
        new Error(`No response for Host: ${JSON.stringify(hostHeader)}`)
      );
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

/**
 * Every form the hunter reproduced. `""` earns its place separately from the
 * absent header: the handler's `?? "localhost"` default is nullish, not falsy,
 * so an empty `Host:` yields the base `"http://"` and throws where an absent
 * one resolves to localhost.
 */
const MALFORMED_HOSTS: readonly [string, string][] = [
  ["unclosed IPv6 bracket", "["],
  ["space inside the authority", "a b"],
  ["non-numeric port", "host:abc"],
  ["empty Host header", ""],
];

describe("malformed Host header", () => {
  it.each(MALFORMED_HOSTS)(
    "answers 400 and leaves the process serving — %s",
    async (_label, hostHeader) => {
      const response = await rawHealthRequest(hostHeader);

      expect(response).toMatch(STATUS_400_LINE);
      expect(response).toContain('{"error":"Invalid request"}');

      // The half that kills the mutation: only a live process answers this.
      const afterwards = await rawHealthRequest(`127.0.0.1:${TEST_PORT}`);
      expect(afterwards).toMatch(STATUS_200_LINE);
      expect(afterwards).toContain('"status":"ok"');
    },
    TWO_REQUEST_CASE_TIMEOUT_MS
  );
});

/**
 * The constraint half of ISS-8232: a well-formed authority must route exactly
 * as it did before the guard. An IPv6 literal and an explicit port are the
 * two shapes most likely to be broken by a careless host "sanitizer".
 */
const WELL_FORMED_HOSTS: readonly [string, string][] = [
  ["bare hostname", "relay.internal"],
  ["hostname with port", "relay.internal:3020"],
  ["IPv6 literal with port", "[::1]:3020"],
];

describe("well-formed Host header", () => {
  it.each(WELL_FORMED_HOSTS)(
    "still routes /health to 200 — %s",
    async (_label, hostHeader) => {
      const response = await rawHealthRequest(hostHeader);

      expect(response).toMatch(STATUS_200_LINE);
      expect(response).toContain('"status":"ok"');
    },
    ONE_REQUEST_CASE_TIMEOUT_MS
  );
});

/**
 * An absolute-form request target reads like a way around the guard — the URL
 * input already names an authority, so the malformed base looks unused — and it
 * is not one: `new URL(input, base)` parses the BASE first and throws when it
 * fails, whether or not `input` is absolute. llhttp passes the full URI through
 * as `req.url`, so the header still decides. Pinned because the shape is
 * plausible enough to be re-argued.
 */
describe("malformed Host header with an absolute-form request target", () => {
  it.each(MALFORMED_HOSTS)(
    "still answers 400 and leaves the process serving — %s",
    async (_label, hostHeader) => {
      const response = await rawHealthRequest(hostHeader, ABSOLUTE_FORM_TARGET);

      expect(response).toMatch(STATUS_400_LINE);
      expect(response).toContain('{"error":"Invalid request"}');

      const afterwards = await rawHealthRequest(`127.0.0.1:${TEST_PORT}`);
      expect(afterwards).toMatch(STATUS_200_LINE);
      expect(afterwards).toContain('"status":"ok"');
    },
    TWO_REQUEST_CASE_TIMEOUT_MS
  );

  /**
   * The non-vacuity control for the four cases above: without it, they would
   * still pass if the relay rejected every absolute-form target for some
   * unrelated reason, and would prove nothing about the Host header.
   */
  it(
    "routes by pathname when that same target carries a well-formed Host",
    async () => {
      const response = await rawHealthRequest(
        "relay.internal",
        ABSOLUTE_FORM_TARGET
      );

      expect(response).toMatch(STATUS_200_LINE);
      expect(response).toContain('"status":"ok"');
    },
    ONE_REQUEST_CASE_TIMEOUT_MS
  );
});
