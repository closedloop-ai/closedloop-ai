/**
 * FEA-3425 (PLN-1437 Phase 3 / Phase 4a): outcome matrix for the HTTP
 * product-analytics lane. HTTP-only since Phase 4a — there is no socket
 * fallback, so every non-terminal outcome is a best-effort DROP. The genuinely
 * load-bearing logic is: never double-count a captured PostHog event, latch on a
 * coded feature-disabled verdict, and never crash or retry on a failure.
 */
import assert from "node:assert/strict";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopAnalyticsRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { test } from "vitest";
import { DesktopAnalyticsEventName } from "../src/main/cloud/cloud-protocol.js";
import {
  ANALYTICS_FEATURE_DISABLED_RECHECK_MS,
  ANALYTICS_UNAVAILABLE_RECHECK_MS,
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
    now?: () => number;
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
    now: overrides?.now,
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

test("FEA-3425: a coded feature-disabled 403 suppresses later sends inside the recheck window", async () => {
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

test("ISS-7704: a coded analytics-unavailable rejection recovers on its own shorter window, not the disabled one", async () => {
  let clock = 1_000_000;
  let unavailable = true;
  const { lane, calls } = makeLane(
    () =>
      unavailable
        ? jsonResponse(503, {
            success: false,
            error: "Desktop analytics feature flag is unavailable",
            code: DesktopAnalyticsRestErrorCode.AnalyticsUnavailable,
          })
        : capturedResponse(),
    { now: () => clock }
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // Bounded: an unanswered lookup can be permanent (an API with no PostHog key
  // never answers), so an unbounded re-probe would be one POST per event.
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // But its window is its own and SHORTER than the disabled one — at a point
  // still inside the disabled window, this lane has already recovered.
  unavailable = false;
  clock += ANALYTICS_UNAVAILABLE_RECHECK_MS;
  assert.ok(
    ANALYTICS_UNAVAILABLE_RECHECK_MS < ANALYTICS_FEATURE_DISABLED_RECHECK_MS
  );
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 2);

  // Recovered: no residual suppression once the server answers again.
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 3);
});

test("ISS-7704: the feature-disabled latch lapses after the recheck window and re-evaluates the gate", async () => {
  let clock = 1_000_000;
  let featureDisabled = true;
  const { lane, calls } = makeLane(
    () =>
      featureDisabled
        ? jsonResponse(403, {
            success: false,
            error: "Forbidden",
            code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
          })
        : capturedResponse(),
    { now: () => clock }
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // Inside the window the lane stays suppressed — one probe, not a flood.
  clock += ANALYTICS_FEATURE_DISABLED_RECHECK_MS - 1;
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // The rollout is widened while the app is still running. Once the window
  // lapses the lane re-asks instead of staying dark until the process exits.
  featureDisabled = false;
  clock += 1;
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 2);

  // And having re-enabled, it keeps sending rather than re-suppressing.
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 3);
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

// PRD-736 P1: the lane's kill switch is an edge-WAF deny rule on
// `/desktop/analytics`, which answers with a non-JSON 403 carrying no `code`.
// That must stay a silent per-event drop — never a latch, because no rollout
// verdict was learned, and command/control traffic is unaffected.
test("PRD-736: an uncoded edge-WAF 403 drops the event silently without latching the lane", async () => {
  const { lane, calls } = makeLane(
    () =>
      new Response("Access Denied", {
        status: 403,
        headers: { "Content-Type": "text/html" },
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

test("ISS-7704: a feature-disabled verdict that lands after resetForSession does not suppress the next user's analytics", async () => {
  const gate = deferred();
  const reachedServer = deferred();
  let featureDisabled = true;
  const { lane, calls } = makeLane(async () => {
    if (featureDisabled) {
      reachedServer.resolve();
      await gate.promise;
      return jsonResponse(403, {
        success: false,
        error: "Forbidden",
        code: DesktopAnalyticsRestErrorCode.FeatureDisabled,
      });
    }
    return capturedResponse();
  });

  // Awaited rather than asserted synchronously: `send()` is fire-and-forget and
  // the POST is only issued after the token read resolves, so a bare
  // `calls.length` here reads 0 and proves nothing.
  lane.send(makeEvent(), TARGET);
  await reachedServer.promise;
  assert.equal(calls.length, 1);

  // The desktop auth session changes while that POST is still outstanding, so
  // the verdict now in flight is about a user who is no longer signed in.
  featureDisabled = false;
  lane.resetForSession();

  // Only now does the stale 403 land. Applying it would pin the NEW user's
  // analytics off for the whole five-minute window.
  gate.resolve();
  await lane.flush(FLUSH);

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 2);
});

test("ISS-7704: a lapsed window releases exactly one recheck probe, not one per queued event", async () => {
  let clock = 1_000_000;
  const gate = deferred();
  const probeReachedServer = deferred();
  let gateProbe = false;
  const { lane, calls } = makeLane(
    async () => {
      if (gateProbe) {
        probeReachedServer.resolve();
        await gate.promise;
      }
      return jsonResponse(503, {
        success: false,
        error: "Desktop analytics feature flag is unavailable",
        code: DesktopAnalyticsRestErrorCode.AnalyticsUnavailable,
      });
    },
    { now: () => clock }
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // The window lapses and a BURST arrives before the probe can be answered.
  // Suppression is only restored asynchronously, so without a single-flight
  // marker every one of these escapes as its own POST — one authenticated
  // request, ownership lookup and server warn per event, which is the exact
  // load this window exists to shed.
  gateProbe = true;
  clock += ANALYTICS_UNAVAILABLE_RECHECK_MS;
  lane.send(makeEvent(), TARGET);
  lane.send(makeEvent(), TARGET);
  lane.send(makeEvent(), TARGET);

  // Counted after the probe has settled and `flush` has drained everything, not
  // while sends are still pending: an unsuppressed sibling issues its POST a
  // microtask later, so an early count would report 2 either way.
  await probeReachedServer.promise;
  gate.resolve();
  await lane.flush(FLUSH);
  assert.equal(calls.length, 2);

  // Re-rejected, so the window moved forward rather than clearing: a further
  // event inside the NEW window still drops. Without this the assertion above
  // would also pass on a lane that simply stopped sending altogether.
  assert.equal(calls.length, 2);
  gateProbe = false;
  clock += ANALYTICS_UNAVAILABLE_RECHECK_MS;
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 3);
});

test("ISS-7704: an analytics-unavailable code on a non-503 status does not latch the lane", async () => {
  const clock = 1_000_000;
  const { lane, calls } = makeLane(
    () =>
      // Same code, wrong status. The contract on DesktopAnalyticsRestErrorCode
      // is that the desktop dispatches on code AND status, never either alone,
      // so this must fall through to the generic drop instead of suppressing.
      jsonResponse(500, {
        success: false,
        error: "Internal error",
        code: DesktopAnalyticsRestErrorCode.AnalyticsUnavailable,
      }),
    { now: () => clock }
  );

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 1);

  // No suppression window was opened, so the very next event still reaches the
  // network with the clock untouched.
  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);
  assert.equal(calls.length, 2);
});

// ISS-10503 (PRD-736 D5): the pre-auth twin and the alias-attach option.

const PRE_AUTH_DISTINCT_ID = "22222222-2222-4222-8222-222222222222";

test("ISS-10503: sendPreAuth posts unauthenticated — no bearer, no computeTargetId — with the distinct id envelope-level", async () => {
  const { lane, calls } = makeLane(() => capturedResponse());

  lane.sendPreAuth(makeEvent(), PRE_AUTH_DISTINCT_ID);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/desktop/analytics");
  assert.equal(url.searchParams.get("computeTargetId"), null);
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers[DESKTOP_PLUGIN_VERSION_HEADER], CLIENT_VERSION);
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  assert.equal(body.distinctId, PRE_AUTH_DISTINCT_ID);
  assert.equal(body.event, makeEvent().event);
});

test("ISS-10503: sendPreAuth drops silently without an API origin and never throws on a rejection", async () => {
  const noOrigin = makeLane(() => capturedResponse(), {
    getApiOrigin: () => undefined,
  });
  noOrigin.lane.sendPreAuth(makeEvent(), PRE_AUTH_DISTINCT_ID);
  await noOrigin.lane.flush(FLUSH);
  assert.equal(noOrigin.calls.length, 0);

  const rejected = makeLane(() => jsonResponse(403, { success: false }));
  rejected.lane.sendPreAuth(makeEvent(), PRE_AUTH_DISTINCT_ID);
  await rejected.lane.flush(FLUSH);
  assert.equal(rejected.calls.length, 1);
});

test("ISS-10503: a pre-auth 401 is version skew, not a session verdict — onUnauthorized must not fire", async () => {
  let unauthorized = 0;
  const { lane, calls } = makeLane(
    () => jsonResponse(401, { success: false }),
    {
      onUnauthorized: () => {
        unauthorized += 1;
      },
    }
  );

  lane.sendPreAuth(makeEvent(), PRE_AUTH_DISTINCT_ID);
  await lane.flush(FLUSH);

  assert.equal(calls.length, 1);
  assert.equal(unauthorized, 0);
});

function aliasedCapturedResponse(aliased: boolean): Response {
  return jsonResponse(200, {
    success: true,
    data: { captured: true, aliased },
  });
}

test("ISS-10503: an alias-bearing send clears the latch only on an ack attesting the merge", async () => {
  let delivered = 0;
  const responses = [
    jsonResponse(500, { success: false }),
    // PR #7768 review: `captured: true` without `aliased` (an alias failure on
    // a pre-#7768 API, which never aliases) must NOT clear the latch…
    capturedResponse(),
    aliasedCapturedResponse(false),
    // …only an ack that attests the merge does.
    aliasedCapturedResponse(true),
  ];
  const { lane, calls } = makeLane(
    () => responses.shift() ?? capturedResponse()
  );

  const sendOptions = {
    aliasDistinctId: PRE_AUTH_DISTINCT_ID,
    onAliasDelivered: () => {
      delivered += 1;
    },
  };
  for (const expected of [0, 0, 0, 1]) {
    lane.send(makeEvent(), TARGET, sendOptions);
    await lane.flush(FLUSH);
    assert.equal(delivered, expected);
  }

  for (const call of calls) {
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.equal(body.distinctId, PRE_AUTH_DISTINCT_ID);
  }
});

test("ISS-10503: a send without sendOptions carries no distinctId key at all", async () => {
  const { lane, calls } = makeLane(() => capturedResponse());

  lane.send(makeEvent(), TARGET);
  await lane.flush(FLUSH);

  const body = JSON.parse(String(calls[0].init.body)) as Record<
    string,
    unknown
  >;
  assert.equal("distinctId" in body, false);
});
