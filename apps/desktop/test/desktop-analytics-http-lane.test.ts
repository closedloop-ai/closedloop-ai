/**
 * FEA-3425 (PLN-1437 Phase 3 / Phase 4a): outcome matrix for the HTTP
 * product-analytics lane. HTTP-only since Phase 4a — there is no socket
 * fallback, so every non-terminal outcome is a best-effort DROP. The genuinely
 * load-bearing logic is: never double-count a captured PostHog event, latch on a
 * coded feature-disabled verdict, and never crash or retry on a failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { DesktopAnalyticsEventName } from "../src/main/cloud/cloud-protocol.js";
import {
  createDesktopAnalyticsHttpLane,
  type DesktopAnalyticsLaneEvent,
} from "../src/main/cloud/desktop-analytics-http-lane.js";
import { deferred } from "./deferred.js";

const TOKEN = "session-token-1";
const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const CLIENT_VERSION = "0.16.71";
const FLUSH = { timeoutMs: 1000 };

function makeEvent(): DesktopAnalyticsLaneEvent {
  return {
    event: DesktopAnalyticsEventName.CommandCompleted,
    occurredAt: "2026-07-23T00:00:00.000Z",
    properties: { command_id: "cmd-1" },
  };
}

type FetchCall = { url: URL; init: RequestInit };

function makeLane(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
  overrides?: {
    getAccessToken?: () => Promise<string | null>;
    getApiOrigin?: () => string | undefined;
    getPluginVersion?: () => string;
    onUnauthorized?: () => void;
  }
): {
  lane: ReturnType<typeof createDesktopAnalyticsHttpLane>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const lane = createDesktopAnalyticsHttpLane({
    fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    }) as typeof fetch,
    getAccessToken: overrides?.getAccessToken ?? (async () => TOKEN),
    getApiOrigin: overrides?.getApiOrigin ?? (() => ORIGIN),
    getPluginVersion: overrides?.getPluginVersion ?? (() => CLIENT_VERSION),
    onUnauthorized: overrides?.onUnauthorized,
  });
  return { lane, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function capturedResponse(): Response {
  return jsonResponse(200, { success: true, data: { captured: true } });
}

test("FEA-3425: a captured event posts the socket payload shape to the authenticated route", async () => {
  const { lane, calls } = makeLane(() => capturedResponse());

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/desktop/analytics");
  assert.equal(url.searchParams.get("computeTargetId"), TARGET);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers[DESKTOP_PLUGIN_VERSION_HEADER], CLIENT_VERSION);
  assert.deepEqual(JSON.parse(String(init.body)), makeEvent());
});

test("FEA-3425: a missing session token drops the event without touching the network", async () => {
  const { lane, calls } = makeLane(() => capturedResponse(), {
    getAccessToken: async () => null,
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 0);
});

test("FEA-3425: a thrown token read drops the event without touching the network", async () => {
  const { lane, calls } = makeLane(() => capturedResponse(), {
    getAccessToken: () => Promise.reject(new Error("keychain unavailable")),
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 0);
});

test("FEA-3425: a missing API origin drops the event without touching the network", async () => {
  const { lane, calls } = makeLane(() => capturedResponse(), {
    getApiOrigin: () => undefined,
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 0);
});

test("FEA-3425: a connection-level failure drops the event without throwing", async () => {
  const { lane, calls } = makeLane(() => {
    throw new TypeError("fetch failed");
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  // The request was attempted (fetch threw) but the lane drops it — no retry.
  assert.equal(calls.length, 1);
});

test("FEA-3425: an abort timeout drops the event — the server may have captured it", async () => {
  const { lane, calls } = makeLane(() => {
    throw new DOMException("The operation timed out", "TimeoutError");
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 1);
});

test("FEA-3425: HTTP 401 invalidates the cached token and drops the event", async () => {
  let unauthorizedCalls = 0;
  const { lane, calls } = makeLane(
    () => jsonResponse(401, { success: false, error: "Unauthorized" }),
    {
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
    }
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(unauthorizedCalls, 1);
  assert.equal(calls.length, 1);
});

test("FEA-3425: a coded feature-disabled 403 latches the lane for the session", async () => {
  const { lane, calls } = makeLane(() =>
    jsonResponse(403, {
      success: false,
      error: "Forbidden",
      code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
    })
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  // Latched after the first coded rejection: the second send never fetches.
  assert.equal(calls.length, 1);
});

test("FEA-3425: resetForSession clears the feature-disabled latch so the next send re-evaluates the gate", async () => {
  let featureDisabled = true;
  const { lane, calls } = makeLane(() =>
    featureDisabled
      ? jsonResponse(403, {
          success: false,
          error: "Forbidden",
          code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
        })
      : capturedResponse()
  );

  // First identity latches on a feature-disabled verdict.
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // A new auth session (identity change) re-scopes the per-clerkUserId gate;
  // resetForSession lets the lane discover the new verdict instead of staying
  // pinned off for the process lifetime.
  featureDisabled = false;
  lane.resetForSession();
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 2);
});

test("FEA-3425: a target-ownership 403 drops the event without latching the lane", async () => {
  const { lane, calls } = makeLane(() =>
    jsonResponse(403, {
      success: false,
      error: "Forbidden",
      code: DesktopAnalyticsRestErrorCode.TargetNotOwned,
    })
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 2);
});

test("FEA-3425: server-answered rejections (429, 5xx) drop and never latch", async () => {
  for (const status of [429, 500]) {
    const { lane, calls } = makeLane(() =>
      jsonResponse(status, { success: false, error: "rejected" })
    );

    lane.send(makeEvent(), TARGET);
    await lane.flush(FLUSH);
    lane.send(makeEvent(), TARGET);
    await lane.flush(FLUSH);

    assert.equal(calls.length, 2, `status ${status} must not latch`);
  }
});

test("FEA-3425: HTTP 404/405 (route absent on an older API) drops without throwing", async () => {
  for (const status of [404, 405]) {
    const { lane, calls } = makeLane(() =>
      jsonResponse(status, { success: false, error: "Not Found" })
    );

    lane.send(makeEvent(), TARGET);
    await lane.flush(FLUSH);

    // Version skew: the API predates the route. Best-effort → drop, no retry.
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("FEA-3425: a 2xx with an unexpected body drops without throwing", async () => {
  const { lane, calls } = makeLane(() =>
    jsonResponse(200, { unexpected: true })
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 1);
});

test("FEA-3425: the client-version header is omitted when no version is known", async () => {
  const { lane, calls } = makeLane(() => capturedResponse(), {
    getPluginVersion: () => "",
  });

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(DESKTOP_PLUGIN_VERSION_HEADER in headers, false);
});

test("FEA-3425: flush awaits in-flight sends before resolving", async () => {
  let settled = false;
  const gate = deferred();
  const { lane } = makeLane(async () => {
    await gate.promise;
    return capturedResponse();
  });

  lane.send(makeEvent(), TARGET);
  const flushPromise = lane.flush({ timeoutMs: 5000 }).then(() => {
    settled = true;
  });

  assert.equal(settled, false);
  gate.resolve();
  await flushPromise;
  assert.equal(settled, true);
});
