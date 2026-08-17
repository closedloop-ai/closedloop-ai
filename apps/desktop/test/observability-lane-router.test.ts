/**
 * FEA-3425 (PLN-1437 Phase 3 / Phase 4a): the observability-lane router. The
 * two HTTP twins own their own delivery policy (covered in
 * desktop-analytics-http-lane.test.ts / desktop-telemetry-http-client.test.ts);
 * the router's own logic is the send gate — HTTP-only since Phase 4a, so an
 * event is posted when a session is live and the compute-target identity is
 * known, and best-effort DROPPED otherwise (no socket fallback) — plus the
 * bounded shutdown drain and the feature-disabled latch reset.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopAnalyticsRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { DesktopAnalyticsEventName } from "../src/main/cloud/cloud-protocol.js";
import type { DesktopAnalyticsLaneEvent } from "../src/main/cloud/desktop-analytics-http-lane.js";
import type { DesktopTelemetryLaneEvent } from "../src/main/cloud/desktop-telemetry-http-client.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";

const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const TOKEN = "session-token-1";
const FLUSH = { timeoutMs: 1000 };

function analyticsEvent(): DesktopAnalyticsLaneEvent {
  return {
    event: DesktopAnalyticsEventName.CommandCompleted,
    occurredAt: "2026-07-23T00:00:00.000Z",
    properties: { command_id: "cmd-1" },
  };
}

function telemetryEvent(): DesktopTelemetryLaneEvent {
  return {
    schemaVersion: "1",
    category: "loop.perf.run",
    severity: "info",
    message: "loop perf run",
    trace: { computeTargetId: TARGET },
  };
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({ success: true, data: { captured: true } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function codedResponse(status: number, code?: string): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "rejected",
      ...(code ? { code } : {}),
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function makeRouter(overrides?: {
  respond?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  isHttpReady?: () => boolean;
  getComputeTargetId?: () => string | null;
  onUnauthorized?: () => void;
}): {
  router: ReturnType<typeof createObservabilityLaneRouter>;
  fetchCalls: URL[];
} {
  const fetchCalls: URL[] = [];
  const router = createObservabilityLaneRouter({
    fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      fetchCalls.push(url);
      const respond = overrides?.respond ?? (() => okResponse());
      return Promise.resolve(respond(url, init ?? {}));
    }) as typeof fetch,
    getAccessToken: async () => TOKEN,
    getApiOrigin: () => ORIGIN,
    getPluginVersion: () => "0.16.71",
    onUnauthorized: overrides?.onUnauthorized ?? (() => undefined),
    isHttpReady: overrides?.isHttpReady ?? (() => true),
    getComputeTargetId: overrides?.getComputeTargetId ?? (() => TARGET),
  });
  return { router, fetchCalls };
}

test("FEA-3425: a ready analytics event posts to the authenticated route", async () => {
  const { router, fetchCalls } = makeRouter();

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].pathname, "/desktop/analytics");
  assert.equal(fetchCalls[0].searchParams.get("computeTargetId"), TARGET);
});

test("FEA-3425: analytics drops when HTTP is not ready", async () => {
  const { router, fetchCalls } = makeRouter({ isHttpReady: () => false });

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

test("FEA-3425: analytics drops when no compute target is known", async () => {
  const { router, fetchCalls } = makeRouter({ getComputeTargetId: () => null });

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

test("FEA-3425: a ready telemetry event posts to the authenticated route", async () => {
  const { router, fetchCalls } = makeRouter();

  router.sendTelemetry(telemetryEvent());
  await router.flushTelemetry(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].pathname, "/desktop/telemetry");
});

test("FEA-3425: telemetry drops when HTTP is not ready", async () => {
  const { router, fetchCalls } = makeRouter({ isHttpReady: () => false });

  router.sendTelemetry(telemetryEvent());
  await router.flushTelemetry(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

test("FEA-3425: flushAnalytics awaits the in-flight HTTP send before resolving", async () => {
  // Held on an object so TypeScript does not narrow the capture to `null`: the
  // assignment happens inside the Promise executor, which control-flow analysis
  // cannot see.
  const gateLock: { release: (() => void) | null } = { release: null };
  let settled = false;
  const gate = new Promise<void>((resolve) => {
    gateLock.release = resolve;
  });
  const { router } = makeRouter({
    respond: async () => {
      await gate;
      return okResponse();
    },
  });

  router.sendAnalytics(analyticsEvent());
  const flushed = router.flushAnalytics({ timeoutMs: 5000 }).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  gateLock.release?.();
  await flushed;
  assert.equal(settled, true);
});

test("FEA-3425: resetForSession clears the analytics feature-disabled latch", async () => {
  let featureDisabled = true;
  const { router, fetchCalls } = makeRouter({
    respond: () =>
      featureDisabled
        ? codedResponse(403, DesktopAnalyticsRestErrorCode.FeatureDisabled)
        : okResponse(),
  });

  // First send latches on the feature-disabled verdict.
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  // Second send is suppressed by the latch — no fetch.
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 1);

  // A new auth session clears the latch; the next send re-evaluates the gate.
  featureDisabled = false;
  router.resetForSession();
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 2);
});

test("FEA-3425: an HTTP 401 invalidates the token and drops the analytics event", async () => {
  let unauthorizedCalls = 0;
  const { router, fetchCalls } = makeRouter({
    respond: () => codedResponse(401),
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(unauthorizedCalls, 1);
  assert.equal(fetchCalls.length, 1);
});
