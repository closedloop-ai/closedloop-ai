/**
 * @file auth-failure-telemetry.test.ts
 * @description ISS-6334 (PRD-650 issue 1) coverage for the desktop auth/pairing
 * failure signal. The properties pinned here are the ones the ticket exists for:
 *
 *   1. THE PARADOX. A pairing rejection produces a cloud-visible record over the
 *      UNAUTHENTICATED relay pipe — asserted by decoding the real OTLP protobuf
 *      the runtime shipped to the transport, not by spying on a function. The
 *      other half is pinned too: the authenticated lane, given the same failure,
 *      ships nothing, because its `isHttpReady()` gate needs the auth that just
 *      failed.
 *   2. THE POSITIVE CONTROL. The pairing attempt genuinely happened (`desktop.hello`
 *      went out on the socket) and genuinely failed (the user was shown the
 *      ISS-6126 rejection) — otherwise a green test proves only that nothing
 *      was attempted.
 *   3. THE REASON SET IS BOUNDED. An unrecognized wire reason maps to the generic
 *      fallback instead of passing through, and no credential, path, or user
 *      identifier can reach the wire — asserted against the shipped bytes.
 *   4. THE VOLUME BOUND. A client retrying in a tight loop does not emit
 *      unboundedly, and a CHANGED reason is never suppressed by that bound.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  AppTelemetrySchema,
  AuthOutcome,
  AuthReason,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import ts from "typescript6";
import { afterEach, describe, test } from "vitest";
import {
  AUTH_FAILURE_DEDUPE_WINDOW_MS,
  authReasonForHelloNack,
  authReasonForSessionRequestError,
  buildAuthFailureRecord,
  createAuthFailureTelemetry,
  type DesktopAuthFailureEventInput,
} from "../src/main/cloud/auth-failure-telemetry.js";
import {
  HELLO_NACK_MESSAGES,
  SERVER_INITIATED_DISCONNECT_REASON,
} from "../src/main/cloud/cloud-hello-nack.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import type { DesktopTelemetryLaneEvent } from "../src/main/cloud/desktop-telemetry-http-client.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import { DesktopSessionRequestError } from "../src/main/session/desktop-session-client.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  type DesktopTelemetryTransport,
  type RelayTelemetryTransportDiagnostics,
  totalDroppedExports,
} from "../src/main/telemetry/relay-telemetry-transport.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import {
  connectPairingSocket,
  createStubOptions,
  PAIRING_SOCKET_API_KEY,
} from "./helpers/cloud-socket-fixtures.js";
import {
  createLoopbackStub,
  createManager,
  createStubClient,
  installTempRoot,
  storedRecord,
} from "./helpers/desktop-session-manager-fixtures.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

installTempRoot();

/**
 * A credential the socket really holds. Nothing derived from it may appear in
 * the shipped telemetry body — the pipe it goes out on takes no credential to
 * write to, so a payload that described the secret would be handing it away.
 */
/** A wire reason from a cloud newer than this build. Must never be echoed. */
const UNRECOGNIZED_WIRE_REASON = "brand_new_reason_from_a_newer_cloud";
/**
 * The option name every consumer takes the reporter under, and the one that
 * gives the dedupe its transport-delivery evidence. Read while the wiring suite
 * is being BUILT, so they are declared before it rather than at the file's end.
 */
const REPORT_AUTH_FAILURE_OPTION = "reportAuthFailure";
const DELIVERY_COUNTERS_OPTION = "getDeliveryCounters";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  nodeTestTimers.reset();
  trace.disable();
  metrics.disable();
  logs.disable();
});

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: KeylessTelemetrySignal;
    body: Uint8Array;
  }> = [];
  return {
    shipments,
    start() {},
    stop() {},
    flush() {
      return Promise.resolve();
    },
    export(signal, body) {
      shipments.push({ signal, body: Uint8Array.from(body) });
      return Promise.resolve(true);
    },
  };
}

/**
 * The runtime as production builds it for the keyless leg: an OTel SDK whose
 * only egress is the relay transport. No token is configured anywhere on this
 * path, which is the whole point.
 */
async function startRelayRuntime(): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_auth_failure",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}

/**
 * Decode the attributes of every auth-failure log record the runtime actually
 * shipped over the relay, identified by the `auth.outcome` discriminator. The
 * event name is deliberately not read: the desktop OTLP descriptor does not
 * carry the LogRecord `event_name` field.
 */
function decodeRelayAuthRecords(
  transport: StubTransport
): Record<string, unknown>[] {
  const logRequestType = getOtlpRequestType(OtlpExportKind.Logs);
  const decoded: Record<string, unknown>[] = [];
  for (const shipment of transport.shipments) {
    if (shipment.signal !== KeylessTelemetrySignal.Logs) {
      continue;
    }
    const request = logRequestType.toObject(
      logRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as { resourceLogs?: unknown };
    for (const resourceLog of asOtlpRecordArray(request.resourceLogs)) {
      for (const scopeLog of asOtlpRecordArray(resourceLog.scopeLogs)) {
        for (const record of asOtlpRecordArray(scopeLog.logRecords)) {
          const attributes = decodeOtlpAttributes(
            asOtlpRecordArray(record.attributes)
          );
          if (attributes[TelemetryAttribute.AuthOutcome] === undefined) {
            continue;
          }
          decoded.push(attributes);
        }
      }
    }
  }
  return decoded;
}

/** Every byte the transport was handed, as text, for leak assertions. */
function shippedBytesAsText(transport: StubTransport): string {
  return transport.shipments
    .map((shipment) => Buffer.from(shipment.body).toString("latin1"))
    .join("\u0000");
}

/**
 * The Pipe 2 event this whole ticket is about: the `connection.degraded` record
 * that today rides the AUTHENTICATED lane and therefore never leaves an install
 * whose auth is what broke.
 */
function degradedLaneEvent(): DesktopTelemetryLaneEvent {
  return {
    severity: "warn",
    category: "connection.degraded",
    message: "pairing rejected",
    schemaVersion: "1",
  };
}

describe("ISS-6334: a pairing failure is visible without auth", () => {
  test("the rejection ships over the unauthenticated relay pipe", async () => {
    const { runtime, transport } = await startRelayRuntime();
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => runtime.emitAuthFailureEvent(input),
    });

    const { socket, statuses } = connectPairingSocket((input) =>
      telemetry.report(input)
    );

    // POSITIVE CONTROL, part one: the pairing attempt genuinely happened.
    assert.ok(
      socket.emittedEvents.some((event) => event.name === "desktop.hello"),
      "no desktop.hello was sent, so nothing was actually attempted"
    );

    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
    });

    // POSITIVE CONTROL, part two: it genuinely failed, the ISS-6126 way.
    assert.deepEqual(statuses.at(-1), {
      state: "degraded",
      error:
        HELLO_NACK_MESSAGES[DesktopHelloNackReason.ComputeTargetRegisterFailed],
    });

    // shutdown() drives the batch processor through the OTLP exporter and out
    // over the transport — the path the Datadog monitor actually reads.
    await runtime.shutdown();
    activeRuntime = null;

    assert.deepEqual(decodeRelayAuthRecords(transport), [
      {
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
        [TelemetryAttribute.AuthReason]: AuthReason.ComputeTargetRegisterFailed,
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
      },
    ]);
  });

  test("the authenticated telemetry lane carries nothing in that same state", () => {
    // The other half of the paradox, as a live property rather than history:
    // pairing failed, so `isHttpReady()` is false and there is no compute
    // target — and the authenticated twin never issues a request at all.
    const requests: string[] = [];
    const router = createObservabilityLaneRouter({
      getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
      getAppVersion: () => "0.17.482",
      fetch: ((input: unknown) => {
        requests.push(String(input));
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as unknown as typeof fetch,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
      getPluginVersion: () => "1.0.0-test",
      onUnauthorized: () => undefined,
      isHttpReady: () => false,
      getComputeTargetId: () => null,
      getRetainedComputeTargetId: () => null,
      getAuthStatus: () => DesktopAuthStatus.SignedOut,
      getNodeUuid: () => "1f2e3d4c-5b6a-4788-99aa-bbccddeeff00",
      isSinglePlayerInstall: () => false,
      isPreAuthSendEnabled: () => true,
    });

    router.sendTelemetry(degradedLaneEvent());

    assert.deepEqual(requests, []);
  });
});

describe("ISS-6334: a rejected access token and a failed refresh report too", () => {
  test("a 401 on the authenticated write lane reports before the token is dropped", async () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const sequence: string[] = [];
    let invalidated = 0;
    const router = createObservabilityLaneRouter({
      getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
      getAppVersion: () => "0.17.482",
      fetch: (() =>
        Promise.resolve(
          new Response(null, { status: 401 })
        )) as unknown as typeof fetch,
      getAccessToken: () => Promise.resolve("stale-access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
      getPluginVersion: () => "1.0.0-test",
      onUnauthorized: () => {
        invalidated += 1;
        sequence.push("invalidate");
      },
      reportAuthFailure: (input) => {
        reported.push(input);
        sequence.push("report");
      },
      isHttpReady: () => true,
      getComputeTargetId: () => "compute-target-1",
      getRetainedComputeTargetId: () => "compute-target-1",
      getAuthStatus: () => DesktopAuthStatus.Authenticated,
      getNodeUuid: () => "1f2e3d4c-5b6a-4788-99aa-bbccddeeff00",
      isSinglePlayerInstall: () => false,
      isPreAuthSendEnabled: () => true,
    });

    router.sendTelemetry(degradedLaneEvent());
    await router.flushTelemetry({ timeoutMs: 1000 });

    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.TokenRejected,
        reason: AuthReason.AccessTokenRejected,
      },
    ]);
    // The existing behavior is preserved, not replaced...
    assert.equal(invalidated, 1);
    // ...and the report happens FIRST, which is what the lane's comment claims.
    assert.deepEqual(sequence, ["report", "invalidate"]);
  });

  test("a retryable refresh failure reports even though it never clears the session", async () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const stub = createStubClient();
    stub.setRefresh({ ok: false, error: "network", retryable: true });
    const { manager, store } = createManager({
      stub,
      reportAuthFailure: (input) => reported.push(input),
    });
    store.setSession(storedRecord());

    await manager.restore();

    assert.equal(stub.calls.refresh, 1, "no refresh was actually attempted");
    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.TokenRefreshFailed,
        reason: AuthReason.NetworkUnreachable,
      },
    ]);
  });

  // The two tests above stop at the reporter, so an outcome that the record
  // builder or the OTLP encoder mishandles for THAT outcome specifically would
  // leave them green while the packaged client shipped nothing. This drives all
  // three production call sites into one real runtime and reads the answer off
  // the relay transport's bytes.
  test("all three outcomes reach the relay pipe as distinct decoded records", async () => {
    const { runtime, transport } = await startRelayRuntime();
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => runtime.emitAuthFailureEvent(input),
    });
    const report = (input: DesktopAuthFailureEventInput) =>
      telemetry.report(input);

    // 1. Pairing: the real CloudSocketService, refused by the real nack handler.
    const { socket } = connectPairingSocket(report);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
    });

    // 2. A 401 on the authenticated write lane, through the real router.
    const router = createObservabilityLaneRouter({
      getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
      getAppVersion: () => "0.17.482",
      fetch: (() =>
        Promise.resolve(
          new Response(null, { status: 401 })
        )) as unknown as typeof fetch,
      getAccessToken: () => Promise.resolve("stale-access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
      getPluginVersion: () => "1.0.0-test",
      onUnauthorized: () => undefined,
      reportAuthFailure: report,
      isHttpReady: () => true,
      getComputeTargetId: () => "compute-target-1",
      getRetainedComputeTargetId: () => "compute-target-1",
      getAuthStatus: () => DesktopAuthStatus.Authenticated,
      getNodeUuid: () => "1f2e3d4c-5b6a-4788-99aa-bbccddeeff00",
      isSinglePlayerInstall: () => false,
      isPreAuthSendEnabled: () => true,
    });
    router.sendTelemetry(degradedLaneEvent());
    await router.flushTelemetry({ timeoutMs: 1000 });

    // 3. A failed refresh, through the real DesktopSessionManager.
    const stub = createStubClient();
    stub.setRefresh({ ok: false, error: "network", retryable: true });
    const { manager, store } = createManager({
      stub,
      storeName: "dsm-all-outcomes",
      reportAuthFailure: report,
    });
    store.setSession(storedRecord());
    await manager.restore();

    await runtime.flush();

    const decoded = decodeRelayAuthRecords(transport);
    assert.deepEqual(
      decoded,
      [
        {
          [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
          [TelemetryAttribute.AuthReason]:
            AuthReason.ComputeTargetRegisterFailed,
          [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
        },
        {
          [TelemetryAttribute.AuthOutcome]: AuthOutcome.TokenRejected,
          [TelemetryAttribute.AuthReason]: AuthReason.AccessTokenRejected,
          [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
        },
        {
          [TelemetryAttribute.AuthOutcome]: AuthOutcome.TokenRefreshFailed,
          [TelemetryAttribute.AuthReason]: AuthReason.NetworkUnreachable,
          [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
        },
      ],
      "each outcome must serialize and ship on its own, not just reach a spy"
    );
    // The credential the pairing socket really held is not in any of it.
    assert.ok(!shippedBytesAsText(transport).includes(PAIRING_SOCKET_API_KEY));
  });
});

describe("ISS-6334: the emitted reason set is closed", () => {
  test("an unrecognized cloud reason becomes the generic fallback, never the raw string", async () => {
    const { runtime, transport } = await startRelayRuntime();
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => runtime.emitAuthFailureEvent(input),
    });
    const { socket } = connectPairingSocket((input) => telemetry.report(input));

    socket.emit("desktop.hello.nack", { reason: UNRECOGNIZED_WIRE_REASON });

    await runtime.shutdown();
    activeRuntime = null;

    assert.deepEqual(decodeRelayAuthRecords(transport), [
      {
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
        [TelemetryAttribute.AuthReason]: AuthReason.Unknown,
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
      },
    ]);

    // Nothing the cloud said, and nothing the desktop holds, reached the wire.
    const shipped = shippedBytesAsText(transport);
    for (const forbidden of [
      UNRECOGNIZED_WIRE_REASON,
      PAIRING_SOCKET_API_KEY,
      "sk_live",
    ]) {
      assert.ok(
        !shipped.includes(forbidden),
        `the shipped telemetry body leaked ${forbidden}`
      );
    }
  });

  test("an absent hello-nack reason maps to the fallback rather than throwing", () => {
    assert.equal(authReasonForHelloNack(null), AuthReason.Unknown);
  });

  test("every cloud nack reason maps into the closed reason set", () => {
    const closed = new Set<string>(Object.values(AuthReason));
    for (const reason of Object.values(DesktopHelloNackReason)) {
      assert.ok(
        closed.has(authReasonForHelloNack(reason)),
        `${reason} escaped the closed auth.reason set`
      );
    }
    assert.equal(
      authReasonForSessionRequestError("pop_unavailable"),
      AuthReason.PopUnavailable
    );
    assert.equal(
      authReasonForSessionRequestError("invalid"),
      AuthReason.CredentialInvalid
    );
  });

  test("a prototype-borne key returns Unknown, not a Function", () => {
    assert.equal(
      authReasonForHelloNack("constructor" as DesktopHelloNackReason),
      AuthReason.Unknown
    );
  });

  test("the record carries the two enum attributes and nothing else", () => {
    const record = buildAuthFailureRecord({
      outcome: AuthOutcome.TokenRefreshFailed,
      reason: AuthReason.PopRejected,
    });
    assert.deepEqual(Object.keys(record.attributes).sort(), [
      TelemetryAttribute.AuthOutcome,
      TelemetryAttribute.AuthReason,
    ]);
  });

  test("the strict boundary round-trips every pair and rejects free text", () => {
    for (const outcome of Object.values(AuthOutcome)) {
      for (const reason of Object.values(AuthReason)) {
        const { attributes } = buildAuthFailureRecord({ outcome, reason });
        // Re-parsing the emitted payload is the `.strict()` regression guard: a
        // field this schema has not been taught rejects the WHOLE payload.
        assert.deepEqual(AppTelemetrySchema.parse(attributes), attributes);
      }
    }
    assert.equal(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.AuthReason]: "Error: connect ECONNREFUSED 10.0.0.1",
      }).success,
      false
    );
    assert.equal(
      AppTelemetrySchema.safeParse({
        [TelemetryAttribute.AuthOutcome]: AuthOutcome.PairingRejected,
        "auth.access_token": "sk_live_leak",
      }).success,
      false
    );
  });
});

describe("ISS-6334: the emit volume is bounded", () => {
  test("a tight retry loop emits once, a changed reason still gets through", () => {
    let clock = 1000;
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      now: () => clock,
    });
    const pairingRejected: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.CloudInternalError,
    };

    for (let attempt = 0; attempt < 200; attempt += 1) {
      clock += 50;
      telemetry.report(pairingRejected);
    }
    assert.deepEqual(emitted, [pairingRejected]);

    // A CHANGED reason is a different key, so the bound cannot hide it.
    const changed: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.OnlineStateUpdateFailed,
    };
    telemetry.report(changed);
    assert.deepEqual(emitted, [pairingRejected, changed]);

    // A persistent failure keeps reporting once the window elapses.
    clock += AUTH_FAILURE_DEDUPE_WINDOW_MS;
    telemetry.report(pairingRejected);
    assert.deepEqual(emitted, [pairingRejected, changed, pairingRejected]);
  });

  test("the dedupe key space is the closed enum product, so it cannot grow", () => {
    let clock = 1000;
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      now: () => clock,
    });

    const outcomes = Object.values(AuthOutcome);
    const reasons = Object.values(AuthReason);
    for (let round = 0; round < 3; round += 1) {
      for (const outcome of outcomes) {
        for (const reason of reasons) {
          clock += 1;
          telemetry.report({ outcome, reason });
        }
      }
    }

    // Three passes over the whole key space, one emit per distinct key.
    assert.equal(emitted.length, outcomes.length * reasons.length);
  });
});

describe("ISS-6334: every never-paired shape reports, not just the nack", () => {
  test("a credential the relay refuses on connect reports", async () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const { socket } = connectPairingSocket((input) => reported.push(input));

    socket.emit("connect_error", new Error("Unauthorized"));
    await flushMicrotasks();

    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.PairingRejected,
        reason: AuthReason.RelayRejectedCredential,
      },
    ]);
  });

  test("a non-auth connect_error degrades the socket without reporting a pairing rejection", async () => {
    // The auth-shaped case just above is this test's positive control: it
    // proves connect_error CAN drive a reportAuthFailure call through this
    // exact harness. `looksLikeAuthError` is the guard between that case and
    // this one — without it, a routine transport blip like a poll timeout
    // would count as a pairing rejection.
    const reported: DesktopAuthFailureEventInput[] = [];
    const { socket, statuses } = connectPairingSocket((input) =>
      reported.push(input)
    );

    socket.emit("connect_error", new Error("xhr poll error"));
    await flushMicrotasks();

    assert.deepEqual(statuses.at(-1), {
      state: "degraded",
      error: "Cloud socket connection failed: xhr poll error",
    });
    assert.deepEqual(
      reported,
      [],
      "a routine network blip must not count as a pairing rejection"
    );
  });

  test("a credential revoked AFTER a successful pairing still reports", async () => {
    // `hadSuccessfulConnection` latches true for the process lifetime, so this
    // install used to take the generic reconnect branch and report nothing —
    // while Pipe 2 was offline in that same state, making a working install
    // going dark exactly as invisible as one that never paired.
    const reported: DesktopAuthFailureEventInput[] = [];
    const { socket, statuses } = connectPairingSocket((input) =>
      reported.push(input)
    );

    socket.emit("desktop.hello.ack", { computeTargetId: "ct_paired_once" });
    socket.emit("connect_error", new Error("Unauthorized"));
    await flushMicrotasks();

    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.PairingRejected,
        reason: AuthReason.RelayRejectedCredential,
      },
    ]);
    // The USER-FACING distinction is deliberately unchanged: an install whose
    // credential worked a moment ago is not told to go check its API key.
    const lastStatus = statuses.at(-1);
    assert.equal(lastStatus?.state, "degraded");
    assert.ok(!lastStatus?.error?.includes("verify your API key"));
  });

  test("a handshake the cloud closes without any nack reports", async () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const { socket } = connectPairingSocket((input) => reported.push(input));

    socket.emit("disconnect", SERVER_INITIATED_DISCONNECT_REASON);
    await flushMicrotasks();

    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.PairingRejected,
        reason: AuthReason.NoRejectionReason,
      },
    ]);
  });

  test("an ordinary network drop reports nothing", async () => {
    // The bound that keeps the previous case from firing on every wifi blip.
    const reported: DesktopAuthFailureEventInput[] = [];
    const { socket } = connectPairingSocket((input) => reported.push(input));

    socket.emit("disconnect", "transport close");
    await flushMicrotasks();

    assert.deepEqual(reported, []);
  });

  test("an undecryptable stored key reports, a merely absent one does not", async () => {
    for (const testCase of [
      { diagnostic: "undecryptable" as const, expected: 1 },
      { diagnostic: "missing" as const, expected: 0 },
    ]) {
      const reported: DesktopAuthFailureEventInput[] = [];
      const service = new CloudSocketService(
        createStubOptions({
          getApiKey: () => null,
          getApiKeyDiagnostic: () => testCase.diagnostic,
          reportAuthFailure: (input) => reported.push(input),
        })
      );

      await service.start();
      service.stop();

      assert.equal(
        reported.length,
        testCase.expected,
        `${testCase.diagnostic} produced ${reported.length} report(s)`
      );
      if (testCase.expected === 1) {
        assert.deepEqual(reported[0], {
          outcome: AuthOutcome.PairingRejected,
          reason: AuthReason.CredentialUnreadable,
        });
      }
    }
  });

  test("a failed first sign-in exchange reports its typed reason", async () => {
    const reported: DesktopAuthFailureEventInput[] = [];
    const loopback = createLoopbackStub();
    loopback.state.redeemResult = {
      ok: false,
      error: DesktopSessionRequestError.OrgRequired,
      retryable: false,
    };
    const { manager, store } = createManager({
      browserSignIn: loopback.deps,
      storeName: "dsm-auth-failure-signin",
      reportAuthFailure: (input) => reported.push(input),
    });

    const result = await manager.beginBrowserSignIn();

    // The sign-in genuinely ran and genuinely failed to establish a credential.
    assert.deepEqual(result, { ok: false, reason: "exchange_failed" });
    assert.equal(store.hasSession(), false);
    assert.deepEqual(reported, [
      {
        outcome: AuthOutcome.SignInExchangeFailed,
        reason: AuthReason.OrgRequired,
      },
    ]);
  });
});

describe("ISS-6334: a dropped emit does not spend the dedupe window", () => {
  test("a report the runtime discarded is retried on the next attempt", () => {
    let clock = 1000;
    let runtimeStarted = false;
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        if (!runtimeStarted) {
          return false;
        }
        emitted.push(input);
        return true;
      },
      now: () => clock,
    });
    const pairingRejected: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.RelayRejectedCredential,
    };

    // The OTel runtime has not finished starting: the record is discarded.
    telemetry.report(pairingRejected);
    assert.deepEqual(emitted, []);

    // Well inside the dedupe window. The failure must still get through, or a
    // slow telemetry start would blind the very install it describes.
    runtimeStarted = true;
    clock += 1000;
    telemetry.report(pairingRejected);
    assert.deepEqual(emitted, [pairingRejected]);
  });

  test("a backwards clock correction does not suppress the next report", () => {
    let clock = 10 * AUTH_FAILURE_DEDUPE_WINDOW_MS;
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      now: () => clock,
    });
    const refreshFailed: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.TokenRefreshFailed,
      reason: AuthReason.NetworkUnreachable,
    };

    telemetry.report(refreshFailed);
    // NTP drags the clock backwards an hour on a freshly provisioned machine.
    clock -= 60 * 60_000;
    telemetry.report(refreshFailed);

    assert.deepEqual(emitted, [refreshFailed, refreshFailed]);
  });

  test("a relay that refused the export lets the next report through, in-window", () => {
    let clock = 1000;
    const delivery = { sent: 4, dropped: 2 };
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      getDeliveryCounters: () => ({ ...delivery }),
      now: () => clock,
    });
    const pairingRejected: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.RelayRejectedCredential,
    };

    telemetry.report(pairingRejected);
    assert.deepEqual(emitted, [pairingRejected]);

    // The batch carrying it is declined — cooldown, rate limit, no session, an
    // unavailable collector. Nothing was sent, so nothing arrived.
    delivery.dropped += 1;
    clock += 6000;
    telemetry.report(pairingRejected);
    assert.deepEqual(
      emitted,
      [pairingRejected, pairingRejected],
      "a refused export must not spend the window on a record nobody received"
    );

    // The relay recovers and takes this one. Now the window holds again: the
    // record IS delivered, so re-reporting it would be pure duplication.
    delivery.sent += 1;
    clock += 6000;
    telemetry.report(pairingRejected);
    assert.deepEqual(emitted, [pairingRejected, pairingRejected]);
  });

  test("the ordinary batch delay is not mistaken for a refusal", () => {
    let clock = 1000;
    // Neither counter moves while a batch sits in the exporter's delay. That
    // is absence of evidence, not evidence of a drop — the volume bound must
    // still hold, or a reconnect loop re-emits against it.
    const delivery = { sent: 0, dropped: 0 };
    const emitted: DesktopAuthFailureEventInput[] = [];
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      getDeliveryCounters: () => ({ ...delivery }),
      now: () => clock,
    });
    const pairingRejected: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.CloudInternalError,
    };

    for (let attempt = 0; attempt < 200; attempt += 1) {
      clock += 50;
      telemetry.report(pairingRejected);
    }

    assert.deepEqual(emitted, [pairingRejected]);
  });

  test("a build with no relay transport keeps the window alone", () => {
    let clock = 1000;
    const emitted: DesktopAuthFailureEventInput[] = [];
    // Off-prod: `telemetryEgressEnabled` is false, so composition passes no
    // counters at all. There is nothing to disprove delivery with.
    const telemetry = createAuthFailureTelemetry({
      emit: (input) => {
        emitted.push(input);
        return true;
      },
      now: () => clock,
    });
    const refreshFailed: DesktopAuthFailureEventInput = {
      outcome: AuthOutcome.TokenRefreshFailed,
      reason: AuthReason.ServerUnavailable,
    };

    telemetry.report(refreshFailed);
    clock += 6000;
    telemetry.report(refreshFailed);
    assert.deepEqual(emitted, [refreshFailed]);

    clock += AUTH_FAILURE_DEDUPE_WINDOW_MS;
    telemetry.report(refreshFailed);
    assert.deepEqual(emitted, [refreshFailed, refreshFailed]);
  });
});

describe("ISS-6334: the relay transport reports every drop cause as one total", () => {
  // The dedupe reads a single `dropped` number, so a cause missing from the
  // sum silently degrades the re-arm above to a no-op for that cause.
  test("every drop counter the transport keeps is included", () => {
    const base: RelayTelemetryTransportDiagnostics = {
      connected: true,
      hasSession: true,
      inCooldown: false,
      warmUpQueueDepth: 0,
      sent: 7,
      droppedOversize: 0,
      droppedNoSession: 0,
      droppedRateLimited: 0,
      droppedCollectorUnavailable: 0,
      droppedInvalid: 0,
    };
    const dropCauses = [
      "droppedOversize",
      "droppedNoSession",
      "droppedRateLimited",
      "droppedCollectorUnavailable",
      "droppedInvalid",
    ] as const satisfies ReadonlyArray<
      keyof RelayTelemetryTransportDiagnostics
    >;

    assert.equal(totalDroppedExports(base), 0);
    for (const cause of dropCauses) {
      assert.equal(
        totalDroppedExports({ ...base, [cause]: 1 }),
        1,
        `${cause} must count toward the dedupe's non-delivery evidence`
      );
    }
    assert.equal(
      totalDroppedExports({
        ...base,
        droppedOversize: 1,
        droppedNoSession: 2,
        droppedRateLimited: 3,
        droppedCollectorUnavailable: 4,
        droppedInvalid: 5,
      }),
      15
    );
  });
});

describe("ISS-6334: the production wiring exists", () => {
  // The unit tests above build their own reporter and hand it in, so they would
  // all stay green if every production wire-up were deleted and the signal went
  // dark. These assert the composition root and the application actually pass
  // `reportAuthFailure` — on the resolved AST, never on raw source text.
  const WIRED_CALLS: ReadonlyArray<{
    file: string;
    callee: string;
    option: string;
  }> = [
    {
      file: "../src/main/composition/desktop-services.ts",
      callee: "DesktopSessionManager",
      option: REPORT_AUTH_FAILURE_OPTION,
    },
    {
      file: "../src/main/app.ts",
      callee: "createObservabilityLaneRouter",
      option: REPORT_AUTH_FAILURE_OPTION,
    },
    {
      file: "../src/main/app.ts",
      callee: "CloudSocketService",
      option: REPORT_AUTH_FAILURE_OPTION,
    },
    // Without this the dedupe cannot tell a delivered record from one the relay
    // refused, and silently falls back to spending the window on both.
    {
      file: "../src/main/composition/desktop-services.ts",
      callee: "createAuthFailureTelemetry",
      option: DELIVERY_COUNTERS_OPTION,
    },
  ];

  for (const wired of WIRED_CALLS) {
    test(`${wired.callee} is constructed with ${wired.option}`, () => {
      const sourceFile = parseTypeScriptFile(
        fileURLToPath(new URL(wired.file, import.meta.url))
      );
      let wiredHere = false;
      forEachNode(sourceFile, (node) => {
        if (!isCallToNamed(node, wired.callee)) {
          return;
        }
        const argument = node.arguments?.[0];
        if (argument && ts.isObjectLiteralExpression(argument)) {
          wiredHere ||= argument.properties.some(
            (property) =>
              property.name !== undefined &&
              ts.isIdentifier(property.name) &&
              property.name.text === wired.option
          );
        }
      });
      assert.ok(
        wiredHere,
        `${wired.callee} in ${wired.file} must be given ${wired.option}, or the auth signal is dark in production`
      );
    });
  }
});

/** A `new X({...})` or `x({...})` whose callee is exactly `name`. */
function isCallToNamed(
  node: ts.Node,
  name: string
): node is ts.CallExpression | ts.NewExpression {
  if (!(ts.isCallExpression(node) || ts.isNewExpression(node))) {
    return false;
  }
  return ts.isIdentifier(node.expression) && node.expression.text === name;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
