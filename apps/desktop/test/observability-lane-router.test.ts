/**
 * FEA-3425 (PLN-1437 Phase 3 / Phase 4a): the observability-lane router. The
 * two HTTP twins own their own delivery policy (covered in
 * desktop-analytics-http-lane.test.ts / desktop-telemetry-http-client.test.ts);
 * the router's own logic is the send gate — HTTP-only since Phase 4a, so an
 * event is posted when a session is live and the compute-target identity is
 * known, and best-effort DROPPED otherwise (no socket fallback) — plus the
 * bounded shutdown drain and the feature-disabled latch reset.
 *
 * ISS-8687 added one exemption to that gate: the offline-deliverable analytics
 * family resolves the RETAINED compute-target identity instead of the
 * socket-live one, so `desktop_connection_lost` / `desktop_connection_degraded`
 * stop being undeliverable by construction. The telemetry twin is unchanged.
 */
import assert from "node:assert/strict";
import { DesktopAnalyticsRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
} from "@repo/api/src/types/surface-analytics";
import { test } from "vitest";
import { isHttpAgentSessionSyncReady } from "../src/main/agent-sync/agent-session-sync-transport.js";
import { DesktopAnalyticsEventName } from "../src/main/cloud/cloud-protocol.js";
import type { DesktopAnalyticsLaneEvent } from "../src/main/cloud/desktop-analytics-http-lane.js";
import type { DesktopTelemetryLaneEvent } from "../src/main/cloud/desktop-telemetry-http-client.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import {
  canDeliverTelemetry,
  setTelemetryDeliverable,
} from "../src/main/telemetry/telemetry-delivery-readiness.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

const ORIGIN = "https://api.example.test";
const TARGET = "target-1";
const TOKEN = "session-token-1";
// ISS-10503: a well-formed v4 UUID — the shape both pre-auth distinct ids share.
const NODE_UUID = "1f2e3d4c-5b6a-4788-99aa-bbccddeeff00";
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
    category: "queue.stats_changed",
    severity: "info",
    message: "queue stats changed",
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
  /**
   * ISS-8687: the retained identity the offline-deliverable analytics family
   * resolves. Defaults to `getComputeTargetId` so every case written before
   * that exemption keeps testing exactly the gate it was written for.
   */
  getRetainedComputeTargetId?: () => string | null;
  onUnauthorized?: () => void;
  getAuthStatus?: () => DesktopAuthStatus;
  getNodeUuid?: () => string;
  isSinglePlayerInstall?: () => boolean;
  isPreAuthSendEnabled?: () => boolean;
}): {
  router: ReturnType<typeof createObservabilityLaneRouter>;
  fetchCalls: URL[];
  fetchInits: RequestInit[];
} {
  const fetchCalls: URL[] = [];
  const fetchInits: RequestInit[] = [];
  const router = createObservabilityLaneRouter({
    getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
    getAppVersion: () => "0.17.482",
    fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      fetchCalls.push(url);
      fetchInits.push(init ?? {});
      const respond = overrides?.respond ?? (() => okResponse());
      return Promise.resolve(respond(url, init ?? {}));
    }) as typeof fetch,
    getAccessToken: async () => TOKEN,
    getApiOrigin: () => ORIGIN,
    getPluginVersion: () => "0.16.71",
    onUnauthorized: overrides?.onUnauthorized ?? (() => undefined),
    isHttpReady: overrides?.isHttpReady ?? (() => true),
    getComputeTargetId: overrides?.getComputeTargetId ?? (() => TARGET),
    getRetainedComputeTargetId:
      overrides?.getRetainedComputeTargetId ??
      overrides?.getComputeTargetId ??
      (() => TARGET),
    // ISS-10503: the pre-auth reads. Authenticated-by-default keeps every case
    // written before the pre-auth path testing exactly the gate it targets.
    getAuthStatus:
      overrides?.getAuthStatus ?? (() => DesktopAuthStatus.Authenticated),
    getNodeUuid: overrides?.getNodeUuid ?? (() => NODE_UUID),
    isSinglePlayerInstall: overrides?.isSinglePlayerInstall ?? (() => false),
    isPreAuthSendEnabled: overrides?.isPreAuthSendEnabled ?? (() => true),
  });
  return { router, fetchCalls, fetchInits };
}

/**
 * ISS-7704 (AC: "verify readyTargetId() resolves for a fresh install"). Walks a
 * first-run install through the REAL readiness predicate rather than a boolean
 * lambda, so the two halves of the gate stay separable: every other router test
 * collapses "not authenticated" and "cloud offline" into one `isHttpReady`
 * stub, which would let the auth half regress while staying green.
 */
test("ISS-7704: a fresh install resolves readyTargetId only once the session is authenticated AND the hello ack lands", async () => {
  let authStatus: DesktopAuthStatus = DesktopAuthStatus.Loading;
  let cloudOnline = false;
  let ackedTargetId: string | null = null;
  const { router, fetchCalls } = makeRouter({
    isHttpReady: () =>
      isHttpAgentSessionSyncReady({
        authStatus,
        hasComputeTargetIdentity: cloudOnline,
      }),
    getComputeTargetId: () => ackedTargetId,
    getRetainedComputeTargetId: () => ackedTargetId,
  });

  // First run: the session is still loading and the cloud socket has not been
  // started yet (it is deferred behind window reveal), so there is no target.
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 0);
  assert.equal(router.canSendTelemetry(), false);

  // The socket paired on a credential of its own and the hello ack registered a
  // compute target, but the first-party Desktop session is still not
  // authenticated. The two halves of the gate ride different credentials, so
  // this state is reachable — and it must still drop.
  cloudOnline = true;
  ackedTargetId = TARGET;
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 0);
  assert.equal(router.canSendTelemetry(), false);

  // Only with BOTH halves satisfied does a first-run install start emitting.
  authStatus = DesktopAuthStatus.Authenticated;
  assert.equal(router.canSendTelemetry(), true);
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].searchParams.get("computeTargetId"), TARGET);
});

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

test("FEA-3425: telemetry drops when no compute target is known", async () => {
  // The analytics twin has always had this case; telemetry did not, so the
  // signed-in-but-no-target half of the gate went unasserted for the lane that
  // carries store-integrity. A best-effort DROP is the router's documented
  // contract — pinned here so a change to it is a deliberate one.
  const { router, fetchCalls } = makeRouter({ getComputeTargetId: () => null });

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

/**
 * ISS-7496: the router owns the send gate, so it is the router that publishes
 * whether an event would be carried. These assert the PUBLISHED value tracks
 * the same two inputs the drop tests above use — a reporter that latches once
 * per process reads this, and if construction stopped registering it the
 * reporter would silently fall back to "always deliverable" and resume burning
 * its latch on dropped reports.
 */
test("ISS-7496: a ready router publishes its send gate as deliverable", () => {
  setTelemetryDeliverable(null);
  makeRouter();

  assert.equal(canDeliverTelemetry(), true);

  setTelemetryDeliverable(null);
});

test("ISS-7496: the published gate reports undeliverable while HTTP is not ready", () => {
  setTelemetryDeliverable(null);
  makeRouter({ isHttpReady: () => false });

  assert.equal(canDeliverTelemetry(), false);

  setTelemetryDeliverable(null);
});

test("ISS-7496: the published gate reports undeliverable with no compute target", () => {
  setTelemetryDeliverable(null);
  makeRouter({ getComputeTargetId: () => null });

  assert.equal(canDeliverTelemetry(), false);

  setTelemetryDeliverable(null);
});

function lostEvent(): DesktopAnalyticsLaneEvent {
  return {
    event: DesktopAnalyticsEventName.DesktopConnectionLost,
    occurredAt: "2026-09-01T00:00:00.000Z",
    properties: { reason: "ping timeout" },
  };
}

function gridviewRolloutDecisionEvent(): DesktopAnalyticsLaneEvent {
  return {
    event: DesktopAnalyticsEventName.GridviewRolloutDecision,
    occurredAt: "2026-09-11T00:00:00.000Z",
    properties: {
      component: SharedAnalyticsComponent.SessionsListSurfaceV2,
      outcome: GridviewRolloutDecisionOutcome.Disabled,
      reason: FeatureAssignmentDelivery.Offline,
      surface: Surface.Desktop,
    },
  };
}

test("ISS-8687: the loss family posts under the retained id with no live target", async () => {
  // The shipped shape of the defect: socket down, so no live target, but the
  // HTTPS path is fine and a retained id from the last hello is available.
  const { router, fetchCalls } = makeRouter({
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET,
  });

  router.sendAnalytics(lostEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].searchParams.get("computeTargetId"),
    TARGET,
    "the loss event must post under the retained target; with the socket down there is no live one, which is what made it undeliverable"
  );
});

test("ISS-9430: a rollout decision posts under the retained id with no live target", async () => {
  const { router, fetchCalls } = makeRouter({
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET,
  });

  router.sendAnalytics(gridviewRolloutDecisionEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].searchParams.get("computeTargetId"), TARGET);
});

test("ISS-8687: a non-family event still drops in that same state", async () => {
  // The counterfactual at the router's own level: identical gate inputs, and
  // the ordinary analytics event must still be dropped. If this posts, the
  // exemption became a blanket widening -- the fix ISS-8687 forbids.
  const { router, fetchCalls } = makeRouter({
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET,
  });

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

test("ISS-8687: the loss family still drops when the session is not live", async () => {
  // `isHttpReady` is ANDed for the family too: the exemption loosens WHICH
  // identity may be named, never whether a first-party session is required.
  const { router, fetchCalls } = makeRouter({
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET,
  });

  router.sendAnalytics(lostEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

test("ISS-8687: the telemetry twin is NOT exempt", async () => {
  // Deliberate scope line: the diagnostics half keeps the strict-online gate,
  // because the relay already logs every teardown reason server-side.
  const { router, fetchCalls } = makeRouter({
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET,
  });

  router.sendTelemetry(telemetryEvent());
  await router.flushTelemetry(FLUSH);

  assert.equal(fetchCalls.length, 0);
});

// ISS-10503 (PRD-736 D5): the pre-auth path. All fixtures below run signed
// out unless a case flips the status mid-run.

const ATTEMPT_FLOW_ID = "22222222-2222-4222-8222-222222222222";

function onboardingEvent(
  event: string,
  properties: Record<string, unknown>
): DesktopAnalyticsLaneEvent {
  return {
    event: event as DesktopAnalyticsLaneEvent["event"],
    occurredAt: "2026-09-22T00:00:00.000Z",
    properties,
  };
}

function flowStarted(flowId: string): DesktopAnalyticsLaneEvent {
  return onboardingEvent(OnboardingAnalyticsEvent.FlowStarted, {
    [OnboardingAnalyticsProperty.FlowId]: flowId,
  });
}

function preAuthBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

test("ISS-10503: an unauthenticated attempt event is sent pre-auth under its own flow_id, with no target param and no bearer", async () => {
  const { router, fetchCalls, fetchInits } = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].searchParams.get("computeTargetId"), null);
  const headers = fetchInits[0].headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
  assert.equal(preAuthBody(fetchInits[0]).distinctId, ATTEMPT_FLOW_ID);
});

test("ISS-10503: the skip_account transition switches the emission identity to node_uuid from that event on, and a new flow switches back", async () => {
  const { router, fetchInits } = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  router.sendAnalytics(
    onboardingEvent(OnboardingAnalyticsEvent.StepSkipped, {
      [OnboardingAnalyticsProperty.FlowId]: ATTEMPT_FLOW_ID,
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Account,
    })
  );
  router.sendAnalytics(
    onboardingEvent(OnboardingAnalyticsEvent.StepViewed, {
      [OnboardingAnalyticsProperty.FlowId]: ATTEMPT_FLOW_ID,
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.DashboardAvailable,
    })
  );
  const nextFlowId = "55555555-5555-4555-8555-555555555555";
  router.sendAnalytics(flowStarted(nextFlowId));
  await router.flushAnalytics(FLUSH);

  const distinctIds = fetchInits.map((init) => preAuthBody(init).distinctId);
  assert.deepEqual(distinctIds, [
    ATTEMPT_FLOW_ID,
    NODE_UUID,
    NODE_UUID,
    nextFlowId,
  ]);
});

test("ISS-10503: an unauthenticated non-flow event lands under node_uuid on a single-player install and drops on a multiplayer one", async () => {
  const singlePlayer = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    isSinglePlayerInstall: () => true,
  });
  singlePlayer.router.sendAnalytics(analyticsEvent());
  await singlePlayer.router.flushAnalytics(FLUSH);
  assert.equal(singlePlayer.fetchCalls.length, 1);
  assert.equal(preAuthBody(singlePlayer.fetchInits[0]).distinctId, NODE_UUID);

  const multiplayer = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    isSinglePlayerInstall: () => false,
  });
  multiplayer.router.sendAnalytics(analyticsEvent());
  await multiplayer.router.flushAnalytics(FLUSH);
  assert.equal(multiplayer.fetchCalls.length, 0);
});

test("ISS-12420: authenticated onboarding waits for readiness without anonymous fallback", async () => {
  let ready = false;
  const { router, fetchCalls } = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    isHttpReady: () => ready,
    getComputeTargetId: () => (ready ? TARGET : null),
    getRetainedComputeTargetId: () => null,
    // Even on a box whose operating mode reads single-player, a signed-in
    // session's identity is the clerk user, never node_uuid.
    isSinglePlayerInstall: () => true,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
  ready = true;
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].searchParams.get("computeTargetId"), TARGET);
});

function aliasAckResponse(): Response {
  return new Response(
    JSON.stringify({ success: true, data: { captured: true, aliased: true } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("ISS-10503: account establishment carries the attempt id as the alias trigger until an ack attests the merge, then stops", async () => {
  let authenticated = false;
  const { router, fetchCalls, fetchInits } = makeRouter({
    respond: () => aliasAckResponse(),
    getAuthStatus: () =>
      authenticated
        ? DesktopAuthStatus.Authenticated
        : DesktopAuthStatus.SignedOut,
    isHttpReady: () => authenticated,
    getComputeTargetId: () => (authenticated ? TARGET : null),
    getRetainedComputeTargetId: () => (authenticated ? TARGET : null),
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 1);

  authenticated = true;
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].searchParams.get("computeTargetId"), TARGET);
  assert.equal(preAuthBody(fetchInits[1]).distinctId, ATTEMPT_FLOW_ID);

  // The alias-bearing send was acked, so the id has done its one job.
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetchCalls.length, 3);
  assert.equal("distinctId" in preAuthBody(fetchInits[2]), false);
});

test("ISS-10503: a flow started while AUTHENTICATED never becomes an alias trigger", async () => {
  const { router, fetchCalls, fetchInits } = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 2);
  for (const init of fetchInits) {
    assert.equal("distinctId" in preAuthBody(init), false);
  }
});

test("ISS-10503: a skipped attempt is never aliased — authentication after skip_account carries no alias trigger", async () => {
  let authenticated = false;
  const { router, fetchInits } = makeRouter({
    getAuthStatus: () =>
      authenticated
        ? DesktopAuthStatus.Authenticated
        : DesktopAuthStatus.SignedOut,
    isHttpReady: () => authenticated,
    getComputeTargetId: () => (authenticated ? TARGET : null),
    getRetainedComputeTargetId: () => (authenticated ? TARGET : null),
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  router.sendAnalytics(
    onboardingEvent(OnboardingAnalyticsEvent.StepSkipped, {
      [OnboardingAnalyticsProperty.FlowId]: ATTEMPT_FLOW_ID,
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Account,
    })
  );
  authenticated = true;
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  const last = fetchInits.at(-1);
  assert.ok(last);
  assert.equal("distinctId" in preAuthBody(last), false);
});

test("ISS-10503: a malformed flow_id never becomes a PostHog person — the event falls through to the mode fallback", async () => {
  const singlePlayer = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    isSinglePlayerInstall: () => true,
  });

  singlePlayer.router.sendAnalytics(flowStarted("not-a-uuid"));
  await singlePlayer.router.flushAnalytics(FLUSH);

  assert.equal(singlePlayer.fetchCalls.length, 1);
  assert.equal(preAuthBody(singlePlayer.fetchInits[0]).distinctId, NODE_UUID);
});

test("ISS-10503: sign-out rotates the pre-auth identity — a pending alias never survives to the next user (shared machine)", async () => {
  let authenticated = false;
  const { router, fetchInits } = makeRouter({
    getAuthStatus: () =>
      authenticated
        ? DesktopAuthStatus.Authenticated
        : DesktopAuthStatus.SignedOut,
    isHttpReady: () => authenticated,
    getComputeTargetId: () => (authenticated ? TARGET : null),
    getRetainedComputeTargetId: () => (authenticated ? TARGET : null),
  });

  // User A's pre-auth attempt, then account establishment with the alias-bearing
  // send DROPPED (a 500), so the pending alias is still armed…
  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  authenticated = true;
  await router.flushAnalytics(FLUSH);

  // …when user A signs out. The session-change reset lands signed-out and must
  // rotate the id (PRD-736 invariant 2).
  authenticated = false;
  router.resetForSession();

  // User B signs in on the same machine; their sends must carry NO alias.
  authenticated = true;
  router.resetForSession();
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  const last = fetchInits.at(-1);
  assert.ok(last);
  assert.equal("distinctId" in preAuthBody(last), false);
});

test("ISS-10503 (#7768): the sign-in walk's intermediate statuses must not rotate the attempt id — the alias survives to Authenticated", async () => {
  let status: DesktopAuthStatus = DesktopAuthStatus.SignedOut;
  const { router, fetchInits } = makeRouter({
    respond: () => aliasAckResponse(),
    getAuthStatus: () => status,
    isHttpReady: () => status === DesktopAuthStatus.Authenticated,
    getComputeTargetId: () =>
      status === DesktopAuthStatus.Authenticated ? TARGET : null,
    getRetainedComputeTargetId: () =>
      status === DesktopAuthStatus.Authenticated ? TARGET : null,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));

  // The real sign-in path: every state change fires resetForSession
  // (app.ts wires it to desktopSessionManager.subscribe), and none of the
  // intermediate statuses is Authenticated.
  for (const step of [
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.AwaitingRedirect,
    DesktopAuthStatus.Exchanging,
    DesktopAuthStatus.Authenticated,
  ]) {
    status = step;
    router.resetForSession();
  }

  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  const last = fetchInits.at(-1);
  assert.ok(last);
  assert.equal(preAuthBody(last).distinctId, ATTEMPT_FLOW_ID);
});

test("ISS-10503 (#7768): a restored mid-flow run arms the attempt id from any flow-bearing event, not only flow_started", async () => {
  let authenticated = false;
  const { router, fetchInits } = makeRouter({
    respond: () => aliasAckResponse(),
    getAuthStatus: () =>
      authenticated
        ? DesktopAuthStatus.Authenticated
        : DesktopAuthStatus.SignedOut,
    isHttpReady: () => authenticated,
    getComputeTargetId: () => (authenticated ? TARGET : null),
    getRetainedComputeTargetId: () => (authenticated ? TARGET : null),
  });

  // Relaunch at the account step: no flow_started is ever re-emitted; the
  // session is lazily re-minted and stamps its flow_id on ordinary events.
  router.sendAnalytics(
    onboardingEvent(OnboardingAnalyticsEvent.StepViewed, {
      [OnboardingAnalyticsProperty.FlowId]: ATTEMPT_FLOW_ID,
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Account,
    })
  );
  authenticated = true;
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  const last = fetchInits.at(-1);
  assert.ok(last);
  assert.equal(preAuthBody(last).distinctId, ATTEMPT_FLOW_ID);
});

test("ISS-10503 (FEA-2199): an unpackaged launch keeps the pre-D5 drop — no pre-auth send leaves the machine", async () => {
  const { router, fetchCalls } = makeRouter({
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    isSinglePlayerInstall: () => true,
    isPreAuthSendEnabled: () => false,
  });

  router.sendAnalytics(flowStarted(ATTEMPT_FLOW_ID));
  router.sendAnalytics(analyticsEvent());
  await router.flushAnalytics(FLUSH);

  assert.equal(fetchCalls.length, 0);
});
