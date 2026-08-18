/**
 * FEA-3425 (PLN-1437 Phase 3 / Phase 4a): outcome matrix for the HTTP
 * diagnostics telemetry client. HTTP-only since Phase 4a — there is no socket
 * fallback, so every non-terminal outcome is a best-effort DROP. The
 * fire-and-forget policy never re-sends (a duplicate POST duplicates the Datadog
 * log line).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_PLUGIN_VERSION_HEADER } from "@repo/api/src/types/desktop-write-lane";
import {
  createDesktopTelemetryHttpClient,
  type DesktopTelemetryLaneEvent,
} from "../src/main/cloud/desktop-telemetry-http-client.js";
import { deferred } from "./deferred.js";

const TOKEN = "session-token-1";
const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const CLIENT_VERSION = "0.16.71";

// The lane event is the wire event MINUS the protocol envelope
// (`protocolVersion`/`messageId`/`timestamp`), which belongs to the socket
// framing this HTTP lane replaced — the client posts the event verbatim and adds
// no envelope. The fixture is spelled to that contract rather than cast to it,
// so a field the lane does not actually carry cannot be asserted as posted.
function makeEvent(): DesktopTelemetryLaneEvent {
  return {
    schemaVersion: "1",
    category: "loop.perf.run",
    severity: "info",
    message: "loop perf sample",
    trace: { computeTargetId: TARGET },
  };
}

type FetchCall = { url: URL; init: RequestInit };

function makeClient(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
  overrides?: {
    getAccessToken?: () => Promise<string | null>;
    getApiOrigin?: () => string | undefined;
    onUnauthorized?: () => void;
  }
): {
  client: ReturnType<typeof createDesktopTelemetryHttpClient>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const client = createDesktopTelemetryHttpClient({
    fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    }) as typeof fetch,
    getAccessToken: overrides?.getAccessToken ?? (async () => TOKEN),
    getApiOrigin: overrides?.getApiOrigin ?? (() => ORIGIN),
    getPluginVersion: () => CLIENT_VERSION,
    onUnauthorized: overrides?.onUnauthorized,
  });
  return { client, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function receivedResponse(): Response {
  return jsonResponse(200, { success: true, data: { received: true } });
}

test("FEA-3425: a received event posts the socket payload shape to the authenticated route", async () => {
  const { client, calls } = makeClient(() => receivedResponse());

  await client.send(makeEvent(), TARGET);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/desktop/telemetry");
  assert.equal(url.searchParams.get("computeTargetId"), TARGET);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers[DESKTOP_PLUGIN_VERSION_HEADER], CLIENT_VERSION);
  assert.deepEqual(JSON.parse(String(init.body)), makeEvent());
});

test("FEA-3425: a missing session token drops the event without touching the network", async () => {
  const { client, calls } = makeClient(() => receivedResponse(), {
    getAccessToken: async () => null,
  });

  await client.send(makeEvent(), TARGET);

  assert.equal(calls.length, 0);
});

test("FEA-3425: a connection-level failure drops the event without throwing", async () => {
  const { client, calls } = makeClient(() => {
    throw new TypeError("fetch failed");
  });

  await client.send(makeEvent(), TARGET);

  assert.equal(calls.length, 1);
});

test("FEA-3425: an abort timeout drops the event — the server may have logged it", async () => {
  const { client, calls } = makeClient(() => {
    throw new DOMException("The operation timed out", "TimeoutError");
  });

  await client.send(makeEvent(), TARGET);

  assert.equal(calls.length, 1);
});

test("FEA-3425: HTTP 401 invalidates the cached token and drops the event", async () => {
  let unauthorizedCalls = 0;
  const { client, calls } = makeClient(
    () => jsonResponse(401, { success: false, error: "Unauthorized" }),
    {
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
    }
  );

  await client.send(makeEvent(), TARGET);

  assert.equal(unauthorizedCalls, 1);
  assert.equal(calls.length, 1);
});

test("FEA-3425: server-answered rejections drop without throwing", async () => {
  for (const status of [400, 403, 413, 500]) {
    const { client, calls } = makeClient(() =>
      jsonResponse(status, { success: false, error: "rejected" })
    );

    await client.send(makeEvent(), TARGET);

    assert.equal(calls.length, 1, `status ${status} must drop`);
  }
});

test("FEA-3425: HTTP 404/405 (route absent on an older API) drops without throwing", async () => {
  for (const status of [404, 405]) {
    const { client, calls } = makeClient(() =>
      jsonResponse(status, { success: false, error: "Not Found" })
    );

    await client.send(makeEvent(), TARGET);

    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("FEA-3425: flush drains an in-flight telemetry send before resolving", async () => {
  let settled = false;
  const gate = deferred();
  const { client } = makeClient(async () => {
    await gate.promise;
    return receivedResponse();
  });

  // Do NOT await send — it stays in-flight, gated on the fetch.
  client.send(makeEvent(), TARGET);
  const flushPromise = client.flush({ timeoutMs: 5000 }).then(() => {
    settled = true;
  });

  assert.equal(settled, false);
  gate.resolve();
  await flushPromise;
  assert.equal(settled, true);
});
