import assert from "node:assert/strict";
import { OnboardingAnalyticsDropReason as Reason } from "@closedloop-ai/telemetry-contract/app";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase as Phase } from "@repo/api/src/types/onboarding-phase";
import { afterEach, expect, test, vi } from "vitest";
import type { DesktopAnalyticsLaneEvent } from "../src/main/cloud/desktop-analytics-http-lane.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import {
  ONBOARDING_QUEUE_LIMIT,
  ONBOARDING_QUEUE_TTL_MS,
} from "../src/main/cloud/onboarding-analytics-queue.js";
import { routeDurableLogsToSink } from "../src/main/logging/durable-log-sink.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";

const FLOW = "90069504-7d38-4678-9e99-88637ed9333a";
const VERSION = "0.17.482";
const FLUSH = { timeoutMs: 1000 };
const routers: ReturnType<typeof createObservabilityLaneRouter>[] = [];
afterEach(() => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }
  routeDurableLogsToSink(null);
  gatewayLog.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function event(
  name: Event = Event.StepViewed,
  step: Phase = Phase.SyncPolicy,
  index = 0
): DesktopAnalyticsLaneEvent {
  return {
    event: name,
    occurredAt: new Date(index).toISOString(),
    properties: {
      [Property.FlowId]: FLOW,
      [Property.Step]: step,
      [Property.StepIndex]: index,
    },
  };
}

function fixture() {
  const state = {
    ready: false,
    status: DesktopAuthStatus.Authenticated as DesktopAuthStatus,
    identity: {
      userId: "user-1",
      organizationId: "org-1",
    } as SignedInUserIdentity | null,
    origin: "https://api.example.test",
    target: "target-1",
  };
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ success: true, data: { captured: true } }),
        { status: 200 }
      )
  );
  const log = vi.spyOn(gatewayLog, "info");
  const getAccessToken = vi.fn(async (): Promise<string | null> => "token-1");
  const router = createObservabilityLaneRouter({
    fetch: fetcher,
    getAccessToken,
    getApiOrigin: () => state.origin,
    getPluginVersion: () => "plugin-1",
    getAppVersion: () => VERSION,
    getIdentity: () => state.identity,
    getAuthStatus: () => state.status,
    isHttpReady: () => state.ready,
    getComputeTargetId: () => (state.ready ? state.target : null),
    getRetainedComputeTargetId: () => state.target,
    getNodeUuid: () => FLOW,
    isSinglePlayerInstall: () => true,
    isPreAuthSendEnabled: () => true,
    onUnauthorized() {},
  });
  routers.push(router);
  return { state, router, fetcher, log, getAccessToken };
}

test("both observed readiness gaps preserve all four original events once", async () => {
  const { state, router, fetcher } = fixture();
  const events = [
    event(Event.StepCompleted, Phase.CreateOrganization, 1),
    event(Event.StepViewed, Phase.SyncPolicy, 2),
    event(Event.StepCompleted, Phase.SyncPolicy, 3),
    event(Event.StepViewed, Phase.InviteTeam, 4),
  ];
  for (const pair of [events.slice(0, 2), events.slice(2)]) {
    state.ready = false;
    for (const item of pair) {
      router.sendAnalytics(item);
    }
    const count = fetcher.mock.calls.length;
    await router.flushAnalytics(FLUSH);
    assert.equal(fetcher.mock.calls.length, count);
    state.ready = true;
    router.refreshAnalyticsReadiness();
    router.refreshAnalyticsReadiness();
    await router.flushAnalytics(FLUSH);
  }
  assert.equal(fetcher.mock.calls.length, 4);
  assert.deepEqual(
    fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    events
  );
  for (const [url] of fetcher.mock.calls) {
    assert.equal(
      new URL(String(url)).searchParams.get("computeTargetId"),
      state.target
    );
  }
});

test("same-person same-org session refresh retains a snapshot of the accepted event", async () => {
  const { state, router, fetcher, log } = fixture();
  const original = event();
  const snapshot = structuredClone(original);
  router.sendAnalytics(original);
  original.properties = { secret: "changed" };
  router.resetForSession();
  state.identity = { ...state.identity! };
  state.ready = true;
  router.resetForSession();
  await router.flushAnalytics(FLUSH);
  assert.deepEqual(
    JSON.parse(String(fetcher.mock.calls[0][1]?.body)),
    snapshot
  );
  assert.equal(log.mock.calls.length, 0);
});

test.each([
  [
    Reason.UserSignedOut,
    (state: ReturnType<typeof fixture>["state"]) => {
      state.status = DesktopAuthStatus.SignedOut;
      state.identity = null;
    },
  ],
  [
    Reason.UserSignedOut,
    (state: ReturnType<typeof fixture>["state"]) => {
      state.status = DesktopAuthStatus.RefreshFailed;
      state.identity = null;
    },
  ],
  [
    Reason.IdentityChanged,
    (state: ReturnType<typeof fixture>["state"]) => {
      state.identity = { userId: "user-2", organizationId: "org-1" };
    },
  ],
  [
    Reason.OrganizationMismatch,
    (state: ReturnType<typeof fixture>["state"]) => {
      state.identity = { userId: "user-1", organizationId: "org-2" };
    },
  ],
  [
    Reason.IdentityChanged,
    (state: ReturnType<typeof fixture>["state"]) => {
      state.origin = "https://other.example.test";
    },
  ],
] as const)(
  "unsafe transition logs %s locally with no network",
  async (reason, change) => {
    vi.useFakeTimers();
    const { state, router, fetcher, log } = fixture();
    const original = event();
    original.properties = {
      ...original.properties,
      sensitive: "never-log-this",
    };
    router.sendAnalytics(original);
    vi.advanceTimersByTime(2000);
    change(state);
    router.resetForSession();
    router.refreshAnalyticsReadiness();
    assert.equal(fetcher.mock.calls.length, 0);
    assert.equal(log.mock.calls.length, 1);
    expect(JSON.parse(log.mock.calls[0][1])).toEqual({
      component: "onboarding_analytics",
      action: "event_dropped",
      reason,
      original_event: Event.StepViewed,
      step: Phase.SyncPolicy,
      flow_id: FLOW,
      queue_age_ms: 2000,
      app_version: VERSION,
      drop_id: expect.any(String),
    });
    state.ready = true;
    router.refreshAnalyticsReadiness();
    await router.flushAnalytics(FLUSH);
    assert.equal(fetcher.mock.calls.length, 0);
  }
);

test("overflow evicts oldest; capacity remains 100 and the retained events flush FIFO", async () => {
  vi.useFakeTimers();
  const { state, router, fetcher, log } = fixture();
  for (let i = 0; i <= ONBOARDING_QUEUE_LIMIT; i += 1) {
    router.sendAnalytics(event(Event.StepViewed, Phase.SyncPolicy, i));
  }
  assert.equal(log.mock.calls.length, 1);
  expect(JSON.parse(log.mock.calls[0][1])).toEqual({
    component: "onboarding_analytics",
    action: "event_dropped",
    reason: Reason.QueueOverflow,
    original_event: Event.StepViewed,
    step: Phase.SyncPolicy,
    flow_id: FLOW,
    queue_age_ms: 0,
    app_version: VERSION,
    drop_id: expect.any(String),
  });
  state.ready = true;
  router.refreshAnalyticsReadiness();
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, ONBOARDING_QUEUE_LIMIT);
  assert.deepEqual(
    fetcher.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)).properties[Property.StepIndex]
    ),
    Array.from({ length: ONBOARDING_QUEUE_LIMIT }, (_, i) => i + 1)
  );
});

test("expiry diagnoses each event at ten minutes even if readiness never changes", () => {
  vi.useFakeTimers();
  const { router, log, fetcher } = fixture();
  router.sendAnalytics(event());
  vi.advanceTimersByTime(ONBOARDING_QUEUE_TTL_MS - 1);
  assert.equal(log.mock.calls.length, 0);
  vi.advanceTimersByTime(1);
  expect(JSON.parse(log.mock.calls[0][1])).toEqual({
    component: "onboarding_analytics",
    action: "event_dropped",
    reason: Reason.QueueExpired,
    original_event: Event.StepViewed,
    step: Phase.SyncPolicy,
    flow_id: FLOW,
    queue_age_ms: ONBOARDING_QUEUE_TTL_MS,
    app_version: VERSION,
    drop_id: expect.any(String),
  });
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("dispose clears timers and pending events without claiming crash durability", async () => {
  vi.useFakeTimers();
  const { state, router, fetcher } = fixture();
  router.sendAnalytics(event());
  assert.equal(vi.getTimerCount(), 1);
  router.dispose();
  assert.equal(vi.getTimerCount(), 0);
  state.ready = true;
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 0);
});

test("an ambiguous HTTP failure never requeues or retries", async () => {
  const { state, router, fetcher } = fixture();
  fetcher.mockRejectedValue(new Error("connection reset after request"));
  router.sendAnalytics(event());
  state.ready = true;
  await router.flushAnalytics(FLUSH);
  router.refreshAnalyticsReadiness();
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 1);
});

test("identity is rechecked after the asynchronous credential read", async () => {
  const { state, router, fetcher, getAccessToken, log } = fixture();
  let resolveToken: (token: string) => void = () =>
    assert.fail("token read did not start");
  getAccessToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToken = resolve;
      })
  );
  router.sendAnalytics(event());
  state.ready = true;
  router.refreshAnalyticsReadiness();
  state.identity = { userId: "other-user", organizationId: "org-1" };
  resolveToken("other-token");
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(JSON.parse(log.mock.calls[0][1]).reason, Reason.IdentityChanged);
});

test("compatible refresh during token retrieval does not cancel the queued send", async () => {
  const { state, router, fetcher, getAccessToken } = fixture();
  let resolveToken: (token: string) => void = () =>
    assert.fail("token read did not start");
  getAccessToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToken = resolve;
      })
  );
  router.sendAnalytics(event());
  state.ready = true;
  router.refreshAnalyticsReadiness();
  router.resetForSession();
  resolveToken("refreshed-token");
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 1);
});

test("HTTP readiness alone cannot flush without a live target", async () => {
  const { state, router, fetcher } = fixture();
  state.ready = true;
  state.target = "";
  router.sendAnalytics(event());
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 0);
  state.target = "target-2";
  router.refreshAnalyticsReadiness();
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 1);
});

test("sign-out remains terminal even if the same user signs back in during token retrieval", async () => {
  const { state, router, fetcher, getAccessToken, log } = fixture();
  let resolveToken: (token: string) => void = () =>
    assert.fail("token read did not start");
  getAccessToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToken = resolve;
      })
  );
  router.sendAnalytics(event());
  state.ready = true;
  router.refreshAnalyticsReadiness();
  state.status = DesktopAuthStatus.SignedOut;
  router.resetForSession();
  state.status = DesktopAuthStatus.Authenticated;
  router.resetForSession();
  resolveToken("new-session-token");
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(JSON.parse(log.mock.calls[0][1]).reason, Reason.UserSignedOut);
});

test("buffering freezes the pre-auth alias before a later authenticated flow starts", async () => {
  const { state, router, fetcher } = fixture();
  state.status = DesktopAuthStatus.SignedOut;
  router.sendAnalytics(event(Event.FlowStarted));
  await router.flushAnalytics(FLUSH);
  state.status = DesktopAuthStatus.Authenticated;
  router.sendAnalytics(event());
  const later = event(Event.FlowStarted);
  later.properties = {
    ...later.properties,
    [Property.FlowId]: "4f2a1c90-832b-46cd-8f99-f02a48e12abc",
  };
  router.sendAnalytics(later);
  state.ready = true;
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 3);
  assert.equal(
    JSON.parse(String(fetcher.mock.calls[1][1]?.body)).distinctId,
    FLOW
  );
});

test("identical discards each reach the persistent logger sink", () => {
  vi.useFakeTimers();
  const { router, state } = fixture();
  const lines: string[] = [];
  routeDurableLogsToSink((_level, line) => lines.push(line));
  // Installing the sink first drains logs buffered before this test.
  lines.length = 0;
  router.sendAnalytics(event());
  router.sendAnalytics(event());
  state.status = DesktopAuthStatus.SignedOut;
  router.resetForSession();
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0], lines[1]);
  for (const line of lines) {
    assert.ok(line.includes(Reason.UserSignedOut));
  }
});

test("sign-out during token refresh diagnoses an entry when the token resolves null", async () => {
  const { state, router, fetcher, getAccessToken, log } = fixture();
  let resolveToken: (token: string | null) => void = () =>
    assert.fail("token read did not start");
  getAccessToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveToken = resolve;
      })
  );
  router.sendAnalytics(event());
  state.ready = true;
  router.refreshAnalyticsReadiness();
  state.status = DesktopAuthStatus.SignedOut;
  router.resetForSession();
  resolveToken(null);
  await router.flushAnalytics(FLUSH);
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(log.mock.calls.length, 1);
  assert.equal(JSON.parse(log.mock.calls[0][1]).reason, Reason.UserSignedOut);
});
