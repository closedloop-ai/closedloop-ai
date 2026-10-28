import assert from "node:assert/strict";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import ts from "typescript6";
import { afterEach, describe, test } from "vitest";
import { createSessionSyncIdentityAdapter } from "../src/main/agent-sync/retained-compute-target-identity.js";
import {
  type CloudSocketStatus,
  DesktopAnalyticsEventName,
  type DesktopHelloAckEvent,
  PROTOCOL_VERSION,
} from "../src/main/cloud/cloud-protocol.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import {
  type ConnectionLifecycleReporter,
  createConnectionLifecycleReporter,
} from "../src/main/cloud/connection-lifecycle-reporter.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryTraceContext } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { CloudSocketState } from "../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import {
  createStubOptions,
  FakeSocket,
} from "./helpers/cloud-socket-fixtures.js";
import {
  findCloudStatusAssignment,
  findMethodBody,
  findStatusBranch,
  parseAppSource,
} from "./helpers/desktop-application-ast.js";
import { forEachNode } from "./helpers/ts-ast.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

// ---------------------------------------------------------------------------
// ISS-7710: every desktop connection-lifecycle analytics event stopped reaching
// PostHog while `agent_session_sync_batch_failed` from the same clients kept
// flowing. Both families share one emitter (`Observability.captureAnalytics`)
// and one transport, so the transport was never the fault.
//
// The fault is an ORDERING one, and only an end-to-end drive can see it.
// `desktop.hello.ack` dispatches `onHelloAck` -- inside which the app emits
// `desktop_connection_established` -- and only THEN calls
// `notifyStatus({ state: "online" })`. The observability lane router gates every
// send on `cloudStatus.state === "online"`, so at the instant the emitter runs
// the gate is still shut and the event is silently dropped. Sync events fire
// later, in steady state, with the gate open -- hence one family survived.
//
// These tests therefore assert on the OUTBOUND HTTP REQUEST the lane actually
// makes. A test that stubbed `Observability` and asserted the stub fired would
// pass on the broken build: the emitter IS reached, and the event dies one
// layer below it.
// ---------------------------------------------------------------------------

const TARGET_ID = "compute-target-iss7710";
const GATEWAY_SESSION_ID = "gateway-session-iss7710";
const ANALYTICS_PATH = "/desktop/analytics";
const API_ORIGIN = "https://api.example.test";
const ESTABLISHED_EVENT =
  DesktopAnalyticsEventName.DesktopConnectionEstablished;
const RESUMED_EVENT = DesktopAnalyticsEventName.DesktopReconnectionResumed;
const COMMAND_INITIATED_EVENT = DesktopAnalyticsEventName.CommandInitiated;
const COMMAND_STARTED_EVENT = DesktopAnalyticsEventName.CommandStarted;
const LOST_EVENT = DesktopAnalyticsEventName.DesktopConnectionLost;
const DEGRADED_EVENT = DesktopAnalyticsEventName.DesktopConnectionDegraded;
/** What `CloudSocketService.describeDisconnect` produces for `transport close`. */
const DISCONNECT_DEGRADED_ERROR = "Cloud socket disconnected: transport close";
/** A distinct degradation cause, for the dedupe cases below. */
const RELAY_UNREACHABLE_ERROR =
  "Cloud socket connection failed: relay unreachable";
const RELAY_REFUSED_ERROR =
  "Cloud socket connection failed: connection refused";
const CLIENT_VERSION = "0.0.0-test";
const SIGNED_IN_IDENTITY = {
  organizationId: "org-iss8687",
  userId: "user-iss8687",
};

type Harness = {
  service: CloudSocketService;
  socket: FakeSocket;
  /** Every analytics event name the lane actually put on the wire, in order. */
  postedEventNames: () => string[];
  /** The `computeTargetId` query parameter of each analytics POST, in order. */
  postedTargetIds: () => string[];
  /** The property bag of each posted event with the given name, in order. */
  postedProperties: (eventName: string) => Record<string, unknown>[];
  /** The resolved trace each telemetry event of `category` carried, in order. */
  telemetryTraces: (category: string) => TelemetryTraceContext[];
  /** Every telemetry category emitted, in order. */
  telemetryCategories: () => string[];
  /** The same reporter instance the socket callbacks above are bound to. */
  connectionLifecycle: ConnectionLifecycleReporter;
  helloAckDispatches: number;
  router: ReturnType<typeof createObservabilityLaneRouter>;
};

/** A hello ack as the reporter receives it, for acks not delivered over the socket. */
function helloAckEvent(
  resumeFromSequence?: Record<string, number>
): DesktopHelloAckEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message-iss7710",
    timestamp: "2026-08-18T15:59:30.000Z",
    computeTargetId: TARGET_ID,
    sessionId: GATEWAY_SESSION_ID,
    serverTime: "2026-08-18T15:59:30.000Z",
    ...(resumeFromSequence ? { resumeFromSequence } : {}),
  };
}

/** Private-method access, matching the existing cloud-socket test convention. */
function protoOf(
  service: CloudSocketService
): Record<string, (...args: unknown[]) => unknown> {
  return Object.getPrototypeOf(service);
}

/**
 * Wires the production chain the way `DesktopApplication` does -- real
 * `CloudSocketService`, real `createObservabilityLaneRouter`, real
 * `createConnectionLifecycleReporter`, real `Observability`, real HTTP lane --
 * and fakes only the two declared injection seams: the socket and `fetch`.
 *
 * The router's three identity reads come from the REAL
 * `createSessionSyncIdentityAdapter` via the same
 * `observabilityLaneIdentity()` spread `app.ts` uses, so the gate under test is
 * the shipped gate rather than a restatement of it. That matters most for
 * ISS-8687: restating the gate here would let the retained-identity fallback
 * pass in the test while the shipped adapter did something else.
 */
function createHarness(): Harness {
  const requests: Array<{ url: string; body: unknown }> = [];
  const telemetryEvents: EnrichedTelemetryEvent[] = [];
  let cloudStatus: CloudSocketStatus = { state: CloudSocketState.Idle };
  let helloAckDispatches = 0;

  const sessionSyncIdentity = createSessionSyncIdentityAdapter({
    getIdentity: () => SIGNED_IN_IDENTITY,
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getApiOrigin: () => API_ORIGIN,
    getCloudStatus: () => cloudStatus,
  });

  const router = createObservabilityLaneRouter({
    getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
    getAppVersion: () => "0.17.482",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );
    }) as typeof fetch,
    getAccessToken: () => Promise.resolve("test-session-token"),
    getApiOrigin: () => API_ORIGIN,
    getPluginVersion: () => "1.0.0-test",
    onUnauthorized: () => undefined,
    ...sessionSyncIdentity.observabilityLaneIdentity(),
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getNodeUuid: () => "1f2e3d4c-5b6a-4788-99aa-bbccddeeff00",
    isSinglePlayerInstall: () => false,
    isPreAuthSendEnabled: () => true,
  });

  Observability.init({
    telemetrySend: (event) => telemetryEvents.push(event),
    analytics: {
      send: (event) => router.sendAnalytics(event),
      flush: (options) => router.flushAnalytics(options),
    },
    desktopClientVersion: CLIENT_VERSION,
  });

  const connectionLifecycle = createConnectionLifecycleReporter();

  const service = new CloudSocketService(
    createStubOptions({
      onStatusChange: (status) => {
        cloudStatus = status;
        if (status.state === CloudSocketState.Online) {
          // app.ts does this in the same branch, so the retained id under test
          // is bound the way production binds it.
          sessionSyncIdentity.remember(status);
          connectionLifecycle.reportOnline(status.targetId);
          router.refreshAnalyticsReadiness();
        }
        if (status.state === CloudSocketState.Degraded) {
          connectionLifecycle.reportDegraded(status.error);
        }
      },
      onDisconnect: (reason) => {
        connectionLifecycle.reportLost(reason);
      },
      onHelloAck: (event) => {
        helloAckDispatches += 1;
        connectionLifecycle.recordHelloAck(event);
      },
    })
  );

  const socket = new FakeSocket();
  const internals = service as unknown as Record<string, unknown>;
  internals.socket = socket;
  internals.stopped = false;
  internals.awaitingHelloAck = true;
  protoOf(service).registerSocketHandlers.call(service, socket);

  const analyticsRequests = () =>
    requests.filter((request) => request.url.includes(ANALYTICS_PATH));

  return {
    service,
    socket,
    connectionLifecycle,
    router,
    postedEventNames: () =>
      analyticsRequests().map((request) =>
        String((request.body as { event?: unknown } | null)?.event ?? "")
      ),
    postedTargetIds: () =>
      analyticsRequests().map(
        (request) =>
          new URL(request.url).searchParams.get("computeTargetId") ?? ""
      ),
    telemetryCategories: () => telemetryEvents.map((event) => event.category),
    telemetryTraces: (category) =>
      telemetryEvents
        .filter((event) => event.category === category)
        .map((event) => event.trace ?? {}),
    postedProperties: (eventName) =>
      analyticsRequests()
        .map((request) => request.body as Record<string, unknown> | null)
        .filter((body) => body?.event === eventName)
        .map((body) => (body?.properties ?? {}) as Record<string, unknown>),
    get helloAckDispatches() {
      return helloAckDispatches;
    },
  };
}

/** Delivers a real `desktop.hello.ack` frame through the production handler. */
function deliverHelloAck(harness: Harness): void {
  harness.socket.emit("desktop.hello.ack", {
    computeTargetId: TARGET_ID,
    serverCapabilities: { computeTargetSigning: false },
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  // Two tests below enable fake `setTimeout`. Without this restore they leak
  // into every later test in this file and into the next file sharing the
  // worker, where a never-firing timer reads as a hang rather than a failure.
  nodeTestTimers.reset();
  Observability.initNoOp();
  gatewayLog.clear();
});

describe("ISS-7710: the connection-lifecycle emitter reaches the wire", () => {
  test("a hello ack puts desktop_connection_established on the analytics lane", async () => {
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();

    assert.equal(
      harness.helloAckDispatches,
      1,
      "the production hello-ack handler must have run -- if this fails the drive itself is broken, not the emitter"
    );
    assert.deepEqual(
      harness.postedEventNames(),
      [ESTABLISHED_EVENT],
      `a new relay connection must put exactly ${ESTABLISHED_EVENT} on the analytics lane; an empty list is the ISS-7710 silent drop, where the emitter ran but the send gate was still shut`
    );
    harness.service.stop();
  });

  test("the established POST is attributed to the ack's compute target", async () => {
    const harness = createHarness();

    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      sessionId: GATEWAY_SESSION_ID,
      serverCapabilities: { computeTargetSigning: false },
    });
    await flushMicrotasks();

    // Attribution travels as the POST's query param, never as a property: the
    // cloud's schema FORBIDS an identity key in the properties bag.
    assert.deepEqual(
      harness.postedTargetIds(),
      [TARGET_ID],
      "the analytics POST must be attributed to the compute target the ack named, not to a stale or empty identity"
    );

    // `recordHelloAck` owns the telemetry IDENTITY since ISS-7710 moved it off
    // app.ts: it is what stamps every LATER diagnostic with the handshake's
    // compute target and gateway session. That claim cannot be pinned on
    // `connection.established` -- `connectionEstablished()` passes
    // `computeTargetId` in its OWN trace, so that event stays attributed even
    // with `setTargetId` deleted. `command.initiated` names neither id in its
    // trace, so the only way either can appear on it is the ambient context
    // `recordHelloAck` set.
    Observability.commandInitiated("command-1", "test_op");
    await flushMicrotasks();

    const [initiated] = harness.telemetryTraces("command.initiated");
    assert.equal(
      initiated?.computeTargetId,
      TARGET_ID,
      "recordHelloAck must apply the ack's compute target to the telemetry lane, or every later diagnostic is anonymous"
    );
    assert.equal(
      initiated?.gatewaySessionId,
      GATEWAY_SESSION_ID,
      "recordHelloAck must apply the ack's gateway session id too, or a later diagnostic cannot be tied back to the handshake that produced it"
    );
    harness.service.stop();
  });

  test("a reconnect after a real disconnect emits again", async () => {
    // The production reconnect shape, and the one the old code could never
    // report: `disconnect` drives the status to degraded FIRST, so the second
    // ack was evaluated against a shut gate exactly like the first. Without the
    // disconnect in between, a stale `online` status left over from the first
    // connection lets the second emission through and the drop hides.
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.socket.emit("disconnect", "transport close");
    await flushMicrotasks();
    (harness.service as unknown as Record<string, unknown>).awaitingHelloAck =
      true;
    deliverHelloAck(harness);
    await flushMicrotasks();

    // ISS-8687 changed this list: the intervening disconnect now also puts
    // degraded + lost on the wire, where before both were gate-dropped. What
    // this test pins -- that the SECOND establishment is emitted -- is
    // unchanged, so the list is widened to the new truth rather than loosened
    // to a subset match, which would stop pinning ordering.
    assert.deepEqual(
      harness.postedEventNames(),
      [ESTABLISHED_EVENT, DEGRADED_EVENT, LOST_EVENT, ESTABLISHED_EVENT],
      "a reconnect is a second connection and must emit again; collapsing to one would under-report the reconnect churn this event exists to measure"
    );
    harness.service.stop();
  });

  test("a resumed reconnect reports the replayed command count once", async () => {
    const harness = createHarness();

    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      serverCapabilities: { computeTargetSigning: false },
      resumeFromSequence: { "gateway-a": 7, "gateway-b": 9 },
    });
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [RESUMED_EVENT, ESTABLISHED_EVENT],
      "a resumed ack must report the resume before the establishment, in that order"
    );
    const [resumed] = harness.postedProperties(RESUMED_EVENT);
    assert.equal(
      resumed?.replay_command_count,
      2,
      "the replay count must be the number of resumed gateway sequences the ack named, carried intact across the deferral"
    );
    assert.equal(
      resumed?.reason,
      "relay_resumed",
      "the resume reason must survive the deferral"
    );
    assert.equal(
      resumed?.desktop_client_version,
      CLIENT_VERSION,
      "the shared analytics enrichment must still be applied to a deferred event"
    );
    harness.service.stop();
  });

  test("a resume count never attaches to a later connection", async () => {
    // The reporter latches the count between two callbacks. A latch that is not
    // consumed would report the previous connection's replay against the next
    // one -- a plausible-looking number that describes a different connection.
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      serverCapabilities: { computeTargetSigning: false },
      resumeFromSequence: { "gateway-a": 7 },
    });
    await flushMicrotasks();
    harness.socket.emit("disconnect", "transport close");
    await flushMicrotasks();
    (harness.service as unknown as Record<string, unknown>).awaitingHelloAck =
      true;
    deliverHelloAck(harness);
    await flushMicrotasks();

    // ISS-8687: the disconnect between the two connections now delivers
    // degraded + lost as well. What this test pins -- that the resume does NOT
    // reattach to the second connection -- is untouched.
    assert.deepEqual(
      harness.postedEventNames(),
      [
        RESUMED_EVENT,
        ESTABLISHED_EVENT,
        DEGRADED_EVENT,
        LOST_EVENT,
        ESTABLISHED_EVENT,
      ],
      "the second, unresumed connection must report establishment only -- a repeated resume event would invent a replay that never happened"
    );
    harness.service.stop();
  });

  test("a re-ack with no disconnect does not repeat the earlier resume", async () => {
    // The relay can re-ack an unbroken socket, so `reportOnline` can run twice
    // with no `reset()` in between. The disconnect in the test above clears the
    // latch on its own, which is why that test cannot see whether reporting
    // CONSUMES the count -- this one can, and it is the case the consume owns.
    const harness = createHarness();

    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      serverCapabilities: { computeTargetSigning: false },
      resumeFromSequence: { "gateway-a": 7 },
    });
    await flushMicrotasks();
    (harness.service as unknown as Record<string, unknown>).awaitingHelloAck =
      true;
    deliverHelloAck(harness);
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [RESUMED_EVENT, ESTABLISHED_EVENT, ESTABLISHED_EVENT],
      "the resume belongs to the first ack only; reporting it again would claim a replay the second ack never carried"
    );
    harness.service.stop();
  });

  test("command events are not suppressed by the same gate", async () => {
    // ISS-7710 AC4. `command_initiated` / `command_started` are emitted from
    // `cloud-command-executor` while a command is in flight -- reachable only
    // over a live socket, so the gate is already open. This pins that: once the
    // ack has applied the online status, a command emit DOES reach the wire.
    // Their low volume is therefore usage, not suppression.
    const harness = createHarness();
    deliverHelloAck(harness);
    await flushMicrotasks();

    Observability.commandInitiated("command-1", "test_op");
    Observability.commandStarted("command-1", "test_op");
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [ESTABLISHED_EVENT, COMMAND_INITIATED_EVENT, COMMAND_STARTED_EVENT],
      "with the socket online both command events must reach the analytics lane; if these dropped too the gate would be suppressing far more than the connection family"
    );
    harness.service.stop();
  });

  test("an ack that never went online cannot resume a later connection", async () => {
    // Reachable in production: the cloud-disabled branch of `onCloudSocketStatus`
    // returns before `reportOnline`, so an ack latched just before the user
    // switched the cloud off never gets consumed. The NEXT ack must clear it, or
    // that connection is reported as replaying commands it never replayed.
    const harness = createHarness();
    harness.connectionLifecycle.recordHelloAck(
      helloAckEvent({ "gateway-a": 7 })
    );

    deliverHelloAck(harness);
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [ESTABLISHED_EVENT],
      "the abandoned ack's replay count must not surface on the next connection, which carried no resume at all"
    );
    harness.service.stop();
  });

  test("an empty resume sequence still reports a replay of zero", async () => {
    // Version skew: a relay that sends `resumeFromSequence: {}` names no
    // gateway. `{}` is truthy, so this reports a resume of 0 -- pinned because
    // it is the pre-ISS-7710 behaviour, preserved deliberately, and a silent
    // change either way would move a number on a dashboard.
    const harness = createHarness();

    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      serverCapabilities: { computeTargetSigning: false },
      resumeFromSequence: {},
    });
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [RESUMED_EVENT, ESTABLISHED_EVENT],
      "an empty resume envelope is still a resume and must report as one"
    );
    assert.equal(
      harness.postedProperties(RESUMED_EVENT)[0]?.replay_command_count,
      0,
      "a resume naming no gateways must report zero replayed commands, never a fabricated count"
    );
    harness.service.stop();
  });

  test("reporting twice for one ack claims the replay only once", async () => {
    // `reportOnline` consumes the latch. Without that, a second report for the
    // SAME ack -- one extra online notification -- would claim the replay again.
    const harness = createHarness();
    harness.socket.emit("desktop.hello.ack", {
      computeTargetId: TARGET_ID,
      serverCapabilities: { computeTargetSigning: false },
      resumeFromSequence: { "gateway-a": 7 },
    });
    await flushMicrotasks();

    // A second report of the SAME ack, with the gate now open.
    harness.connectionLifecycle.reportOnline(TARGET_ID);
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [RESUMED_EVENT, ESTABLISHED_EVENT, ESTABLISHED_EVENT],
      "the replay belongs to the ack, not to each report of it"
    );
    harness.service.stop();
  });

  test("the loss and degraded reporters emit their own categories", async () => {
    // The diagnostics twin, which ISS-8687 deliberately did NOT loosen: it
    // still resolves a strict-online target and is still dropped while offline,
    // so this asserts dispatch rather than delivery. Without it, swapping one
    // emitter for the other inside the reporter would leave every other test in
    // this file green.
    const harness = createHarness();

    harness.connectionLifecycle.reportLost("transport close");
    harness.connectionLifecycle.reportDegraded("relay unreachable");
    await flushMicrotasks();

    assert.deepEqual(
      harness.telemetryCategories(),
      ["connection.lost", "connection.degraded"],
      "each reporter must emit its OWN category -- a loss reported as a degrade misdescribes what happened to the connection"
    );
    harness.service.stop();
  });

  test("a malformed ack emits nothing, so the event never over-reports", async () => {
    const harness = createHarness();

    // No computeTargetId: `parseDesktopHelloAck` rejects the frame and the
    // production handler returns before dispatching. The positive sibling above
    // is what proves this negative is not vacuously green.
    harness.socket.emit("desktop.hello.ack", { serverCapabilities: {} });
    await flushMicrotasks();

    assert.equal(
      harness.helloAckDispatches,
      0,
      "an unparseable ack must not reach the app handler"
    );
    assert.deepEqual(
      harness.postedEventNames(),
      [],
      "an unparseable ack is not a connection and must put nothing on the analytics lane"
    );
    harness.service.stop();
  });
});

// ---------------------------------------------------------------------------
// Production wiring: the behavioural drive above binds the reporter the way
// `app.ts` binds it, so it would stay green if `app.ts` stopped calling the
// reporter at all. `DesktopApplication` cannot be constructed outside Electron,
// so this structural invariant is pinned on the resolved AST -- never on raw
// source text, per the desktop AGENTS.md test-practices rule.
// ---------------------------------------------------------------------------

/** The `this.connectionLifecycle.<method>(...)` call node, if `root` has one. */
function findReporterCall(
  root: ts.Node,
  methodName: string
): ts.CallExpression | undefined {
  let call: ts.CallExpression | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === methodName &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind ===
        ts.SyntaxKind.ThisKeyword &&
      node.expression.expression.name.text === "connectionLifecycle"
    ) {
      call = node;
    }
  });
  return call;
}

/** Whether `root` contains a `this.connectionLifecycle.<method>(...)` call. */
function callsReporter(root: ts.Node, methodName: string): boolean {
  let found = false;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === methodName &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.kind ===
        ts.SyntaxKind.ThisKeyword &&
      node.expression.expression.name.text === "connectionLifecycle"
    ) {
      found = true;
    }
  });
  return found;
}

describe("ISS-7710: app.ts reports the connection after the status is applied", () => {
  test("onCloudSocketStatus reports the connection, and onHelloAck does not", () => {
    const sourceFile = parseAppSource();

    const statusBody = findMethodBody(sourceFile, "onCloudSocketStatus");
    assert.ok(
      statusBody,
      "DesktopApplication must still declare onCloudSocketStatus()"
    );
    // Scoped to the online BRANCH, not the whole method: a call hoisted above
    // the `status.state === "online"` guard would satisfy a whole-method search
    // while reporting on every status transition.
    const onlineBranch = findStatusBranch(statusBody, "online");
    assert.ok(
      onlineBranch,
      'onCloudSocketStatus must still branch on status.state === "online"'
    );
    const reportOnlineCall = findReporterCall(onlineBranch, "reportOnline");
    assert.ok(
      reportOnlineCall,
      "the online branch must call this.connectionLifecycle.reportOnline(), or no connection is ever reported no matter how open the send gate is"
    );
    assert.equal(
      callsReporter(onlineBranch, "reportLost"),
      false,
      "the online branch must not report a loss -- one status transition is one event"
    );

    // The ORDER is the whole bug, so presence is not enough. The lane router's
    // gate reads `this.cloudStatus`; reporting before that field is assigned
    // evaluates the gate against the PREVIOUS status and drops the event --
    // byte for byte the ISS-7710 defect, and no behavioural test above can see
    // it, because none of them drives app.ts's own statement order.
    const cloudStatusAssignment = findCloudStatusAssignment(statusBody);
    assert.ok(
      cloudStatusAssignment,
      "onCloudSocketStatus must still assign this.cloudStatus = status"
    );
    assert.ok(
      reportOnlineCall.pos > cloudStatusAssignment.end,
      "reportOnline() must come AFTER this.cloudStatus = status; reporting first re-creates ISS-7710 -- the gate reads the stale status and silently drops the event"
    );

    let helloAckHandler: ts.Node | undefined;
    forEachNode(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "onHelloAck"
      ) {
        helloAckHandler = node.initializer;
      }
    });
    assert.ok(
      helloAckHandler,
      "app.ts must still wire an onHelloAck handler onto the cloud socket"
    );
    assert.ok(
      callsReporter(helloAckHandler, "recordHelloAck"),
      "onHelloAck must record the ack -- it is the only callback holding the ack payload"
    );
    assert.equal(
      callsReporter(helloAckHandler, "reportOnline"),
      false,
      "onHelloAck must NOT report: it runs before CloudSocketService applies the online status, which is the ISS-7710 silent drop"
    );
  });

  test("onDisconnect and the degraded branch route through the reporter", () => {
    const sourceFile = parseAppSource();

    let disconnectHandler: ts.Node | undefined;
    forEachNode(sourceFile, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "onDisconnect"
      ) {
        disconnectHandler = node.initializer;
      }
    });
    assert.ok(
      disconnectHandler,
      "app.ts must still wire an onDisconnect handler"
    );
    assert.ok(
      callsReporter(disconnectHandler, "reportLost"),
      "a disconnect must report through the reporter, which also drops any unreported resume count"
    );

    const statusBody = findMethodBody(sourceFile, "onCloudSocketStatus");
    assert.ok(statusBody, "onCloudSocketStatus() must exist");
    const degradedBranch = findStatusBranch(statusBody, "degraded");
    assert.ok(
      degradedBranch,
      'onCloudSocketStatus must still branch on status.state === "degraded"'
    );
    assert.ok(
      callsReporter(degradedBranch, "reportDegraded"),
      "the degraded branch must report through the reporter, so one module owns every connection-lifecycle emit"
    );
    assert.equal(
      callsReporter(degradedBranch, "reportOnline"),
      false,
      "the degraded branch must not report a connection -- that would invent an establishment out of a failure"
    );
  });
});

describe("ISS-8687: the loss family reaches the wire under the retained identity", () => {
  test("a socket drop puts desktop_connection_lost on the analytics lane", async () => {
    // The whole defect in one drive. `desktop_connection_lost` fires when the
    // socket is down, which is exactly when the strict-online gate resolves no
    // target -- so it had never reached PostHog from any client, ever. An empty
    // list here is that original silent drop.
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.socket.emit("disconnect", "ping timeout");
    await flushMicrotasks();

    assert.ok(
      harness.postedEventNames().includes(LOST_EVENT),
      `a socket drop must put ${LOST_EVENT} on the analytics lane; its absence is the ISS-8687 drop, where the emitter ran and the gate resolved no compute target`
    );
    harness.service.stop();
  });

  test("the lost POST carries the disconnect reason and the retained target", async () => {
    // The `reason` is the entire point: it is the only place a disconnect cause
    // is recorded client-side. A delivered event with no reason would close the
    // ticket while leaving the investigation exactly as blind as before.
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.socket.emit("disconnect", "ping timeout");
    await flushMicrotasks();

    assert.deepEqual(
      harness
        .postedProperties(LOST_EVENT)
        .map((properties) => properties.reason),
      ["ping timeout"],
      "the lost event must carry the disconnect reason -- without it we can count reconnects but still never say why one dropped"
    );
    const lostIndex = harness.postedEventNames().indexOf(LOST_EVENT);
    assert.equal(
      harness.postedTargetIds()[lostIndex],
      TARGET_ID,
      "the send must be attributed to the RETAINED target from the last hello; any other value would file the drop against the wrong machine"
    );
    harness.service.stop();
  });

  test("a degraded status puts desktop_connection_degraded on the wire", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.socket.emit("disconnect", "transport close");
    await flushMicrotasks();

    assert.ok(
      harness.postedEventNames().includes(DEGRADED_EVENT),
      `a degraded status must put ${DEGRADED_EVENT} on the analytics lane -- it shares the loss family's gate and would otherwise stay undeliverable`
    );
    assert.deepEqual(
      harness
        .postedProperties(DEGRADED_EVENT)
        .map((properties) => properties.error),
      [DISCONNECT_DEGRADED_ERROR],
      "the degraded event must carry the exact error `describeDisconnect` produced for this reason -- asserting only that it is a string would stay green if a regression replaced the disconnect detail with a generic message, which is the whole diagnostic"
    );
    harness.service.stop();
  });

  test("a repeated degrade with the same cause posts once", async () => {
    // Delivery is what makes the CADENCE matter. Nothing upstream dedupes, so
    // every failed reconnect re-reports the same degradation -- one per minute
    // once the connect-error back-off trips, ~480 per client per 8-hour relay
    // outage. Without the latch this event counts retry ticks, not degradations.
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.connectionLifecycle.reportDegraded(RELAY_UNREACHABLE_ERROR);
    harness.connectionLifecycle.reportDegraded(RELAY_UNREACHABLE_ERROR);
    await flushMicrotasks();

    assert.deepEqual(
      harness
        .postedProperties(DEGRADED_EVENT)
        .map((properties) => properties.error),
      [RELAY_UNREACHABLE_ERROR],
      "a retry that fails for the cause already reported must not post again -- one degradation is one event, whatever the reconnect loop does afterwards"
    );
    harness.service.stop();
  });

  test("a changed cause is never suppressed", async () => {
    // The half a bare already-degraded flag would lose: a failure mode that
    // moves mid-episode is a different degradation and is the more interesting
    // one, so the latch is keyed on the cause rather than on the state.
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.connectionLifecycle.reportDegraded(RELAY_UNREACHABLE_ERROR);
    harness.connectionLifecycle.reportDegraded(RELAY_REFUSED_ERROR);
    await flushMicrotasks();

    assert.deepEqual(
      harness
        .postedProperties(DEGRADED_EVENT)
        .map((properties) => properties.error),
      [RELAY_UNREACHABLE_ERROR, RELAY_REFUSED_ERROR],
      "a degradation whose cause changed must report -- suppressing it would hide exactly the transition an incident review is looking for"
    );
    harness.service.stop();
  });

  test("a recovery re-arms the same cause", async () => {
    // The latch bounds one episode, it does not retire a cause for the life of
    // the process. A second outage with the identical error is a second
    // degradation, and a latch never cleared would report only the first.
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.connectionLifecycle.reportDegraded(RELAY_UNREACHABLE_ERROR);
    harness.connectionLifecycle.reportOnline(TARGET_ID);
    harness.connectionLifecycle.reportDegraded(RELAY_UNREACHABLE_ERROR);
    await flushMicrotasks();

    assert.deepEqual(
      harness
        .postedProperties(DEGRADED_EVENT)
        .map((properties) => properties.error),
      [RELAY_UNREACHABLE_ERROR, RELAY_UNREACHABLE_ERROR],
      "a degradation after a recovery is a new degradation; a latch that outlived the episode would under-report every outage after the first"
    );
    harness.service.stop();
  });

  test("a non-lifecycle analytics event is still dropped while offline", async () => {
    // THE counterfactual, and the one that fails if the fix were implemented by
    // widening the gate for everything (which ISS-8687 forbids: best-effort
    // events must not attempt sends while offline). Same instant, same lane,
    // two different outcomes -- the loss event is carried, the command event is
    // not. If `command_initiated` ever appears here the exemption table stopped
    // being an exemption.
    nodeTestTimers.enable(["setTimeout"]);
    const harness = createHarness();

    deliverHelloAck(harness);
    await flushMicrotasks();
    harness.socket.emit("disconnect", "ping timeout");
    await flushMicrotasks();

    Observability.commandInitiated("command-8687", "test_op");
    await flushMicrotasks();

    assert.equal(
      harness.postedEventNames().includes(COMMAND_INITIATED_EVENT),
      false,
      "a non-family event emitted while the socket is down must still be dropped; if this posts, the retained identity was applied to the whole lane and not just the loss family"
    );
    assert.ok(
      harness.postedEventNames().includes(LOST_EVENT),
      "...while the loss event from the same offline moment IS carried -- the two halves together are what pin the exemption to the family"
    );
    harness.service.stop();
  });

  test("a client that never connected reports no loss", async () => {
    // No hello has ever landed, so there is no retained identity to attribute
    // the drop to. Reporting it against an invented or absent target is worse
    // than the silence, so the event is still dropped -- the fallback is
    // "retained", never "fabricated".
    const harness = createHarness();

    harness.connectionLifecycle.reportLost("dial failed");
    await flushMicrotasks();

    assert.deepEqual(
      harness.postedEventNames(),
      [],
      "with no hello ever received there is no compute target to attribute the loss to, so nothing may be sent"
    );
    harness.service.stop();
  });
});

describe("ISS-12420: connection readiness drains onboarding analytics", () => {
  test("online status alone drains a pending onboarding event", async () => {
    const harness = createHarness();
    const properties = {
      [OnboardingAnalyticsProperty.FlowId]:
        "90069504-7d38-4678-9e99-88637ed9333a",
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.SyncPolicy,
    };
    harness.router.sendAnalytics({
      event: OnboardingAnalyticsEvent.StepViewed,
      occurredAt: "2026-10-09T16:58:09.615Z",
      properties,
    });
    assert.deepEqual(harness.postedEventNames(), []);
    deliverHelloAck(harness);
    await flushMicrotasks();
    assert.deepEqual(
      harness.postedProperties(OnboardingAnalyticsEvent.StepViewed),
      [properties]
    );
    assert.deepEqual(harness.postedTargetIds(), [TARGET_ID, TARGET_ID]);
    harness.router.dispose();
    harness.service.stop();
  });
});
