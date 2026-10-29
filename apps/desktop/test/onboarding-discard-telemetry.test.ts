/**
 * ISS-12421: an onboarding analytics discard reaches the keyless OTLP lane
 * while authenticated analytics readiness is unavailable, through the
 * production path: the lane router, the ISS-12420 readiness queue, the bound
 * discard bridge, the real OTel runtime and the relay exporters. The OTLP bytes
 * are decoded, so each case pins both the searchable attributes and the
 * absence of account, node, device and payload identifiers.
 */
import assert from "node:assert/strict";
import {
  OnboardingAnalyticsAction,
  OnboardingAnalyticsDropReason as Reason,
} from "@closedloop-ai/telemetry-contract/app";
import {
  TelemetryAttribute,
  TelemetryServiceName,
} from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase as Phase } from "@repo/api/src/types/onboarding-phase";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import type { Node } from "typescript6";
import {
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
} from "typescript6";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DesktopAnalyticsLaneEvent } from "../src/main/cloud/desktop-analytics-http-lane.js";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import { ONBOARDING_QUEUE_LIMIT } from "../src/main/cloud/onboarding-analytics-queue.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import { buildOnboardingDiscardRecord } from "../src/main/telemetry/app-otel-runtime-onboarding-discard.js";
import {
  createOnboardingDiscardTelemetry,
  onboardingDiscardTelemetry,
} from "../src/main/telemetry/onboarding-discard-telemetry.js";
import type { SignedInUserIdentity } from "../src/main/util/user-identity.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import { desktopServicesSource } from "./desktop-services-ast-helpers.js";
import {
  createStubTransport,
  type StubTransport,
} from "./helpers/import-health-fixtures.js";

const FLOW = "90069504-7d38-4678-9e99-88637ed9333a";
const APP_VERSION = "0.17.482";
const INSTALLATION_ID = "install_discard_identity";
const DEVICE_ID = "device_discard_identity";
const NODE_UUID = "5d0b1f3e-2c4a-4e8b-9f6d-7a1c3e5b9d20";
const USER_ID = "user_discard_identity";
const ORG_ID = "org_discard_identity";
const TARGET_ID = "target_discard_identity";
const SENSITIVE = "property_discard_identity";
const FLUSH = { timeoutMs: 1000 };
/** Every value that must never reach the keyless lane. */
const FORBIDDEN = [
  INSTALLATION_ID,
  DEVICE_ID,
  NODE_UUID,
  USER_ID,
  ORG_ID,
  TARGET_ID,
  SENSITIVE,
];

const routers: ReturnType<typeof createObservabilityLaneRouter>[] = [];
let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  for (const router of routers.splice(0)) {
    router.dispose();
  }
  onboardingDiscardTelemetry.bindRuntime(null);
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
  gatewayLog.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Scenario = {
  reason: Reason;
  discard: (fixture: Fixture) => void;
};

const SCENARIOS: readonly Scenario[] = [
  {
    reason: Reason.UserSignedOut,
    discard: ({ state, router }) => {
      router.sendAnalytics(onboardingEvent());
      state.status = DesktopAuthStatus.SignedOut;
      state.identity = null;
      router.resetForSession();
    },
  },
  {
    reason: Reason.IdentityChanged,
    discard: ({ state, router }) => {
      router.sendAnalytics(onboardingEvent());
      state.identity = { userId: "user_other", organizationId: ORG_ID };
      router.refreshAnalyticsReadiness();
    },
  },
  {
    reason: Reason.OrganizationMismatch,
    discard: ({ state, router }) => {
      router.sendAnalytics(onboardingEvent());
      state.identity = { userId: USER_ID, organizationId: "org_other" };
      router.refreshAnalyticsReadiness();
    },
  },
  {
    reason: Reason.QueueExpired,
    discard: ({ router }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      router.sendAnalytics(onboardingEvent());
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      router.refreshAnalyticsReadiness();
    },
  },
  {
    reason: Reason.QueueOverflow,
    discard: ({ router }) => {
      for (let index = 0; index <= ONBOARDING_QUEUE_LIMIT; index += 1) {
        router.sendAnalytics(onboardingEvent());
      }
    },
  },
];

describe("ISS-12421: discards ride the keyless lane while analytics readiness is unavailable", () => {
  test("every queue drop reason has a scenario", () => {
    expect(SCENARIOS.map((scenario) => scenario.reason).sort()).toEqual(
      Object.values(Reason).sort()
    );
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.reason} reaches the OTLP wire with searchable, de-identified attributes`, async () => {
      const transport = createStubTransport();
      await startBoundRuntime(transport);
      const fixture = createFixture();
      const log = vi.spyOn(gatewayLog, "info");

      scenario.discard(fixture);
      await fixture.router.flushAnalytics(FLUSH);
      await activeRuntime?.flush();

      assert.equal(
        fixture.fetcher.mock.calls.length,
        0,
        "the authenticated analytics lane must stay unused"
      );
      assert.equal(log.mock.calls.length, 1, "the local record is kept");
      const shipped = decodeDiscards(transport);
      assert.equal(shipped.length, 1);
      const [{ attributes, resource }] = shipped;
      expect(attributes).toEqual({
        [TelemetryAttribute.OnboardingAnalyticsAction]:
          OnboardingAnalyticsAction.EventDropped,
        [TelemetryAttribute.OnboardingAnalyticsReason]: scenario.reason,
        [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]: Event.StepViewed,
        [TelemetryAttribute.OnboardingAnalyticsStep]: Phase.SyncPolicy,
        [TelemetryAttribute.OnboardingAnalyticsFlowId]: FLOW,
        [TelemetryAttribute.DurationMs]: expect.any(Number),
        [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.App,
      });
      expect(resource).toEqual({
        [TelemetryAttribute.ServiceName]: TelemetryServiceName.Desktop,
        [TelemetryAttribute.ServiceVersion]: APP_VERSION,
        [TelemetryAttribute.DeploymentEnvironmentName]: "desktop-prod",
      });
      const texts = discardShipmentText(transport);
      assert.ok(texts.length > 0, "the discard shipment must be identifiable");
      for (const text of texts) {
        for (const forbidden of FORBIDDEN) {
          assert.ok(!text.includes(forbidden), `${forbidden} shipped`);
        }
      }
    });
  }

  test("an ordinary record from the same runtime keeps its fleet identity", async () => {
    const transport = createStubTransport();
    const runtime = await startBoundRuntime(transport);
    const fixture = createFixture();
    SCENARIOS[0].discard(fixture);
    runtime.emitAppLifecycleEvent({
      event: DesktopAppLifecycleEvent.Heartbeat,
      operatingMode: DesktopAppOperatingMode.SinglePlayer,
    });
    await runtime.flush();

    const others = decodeLogRecords(transport).filter(
      (record) =>
        record.attributes[TelemetryAttribute.OnboardingAnalyticsAction] ===
        undefined
    );
    assert.ok(others.length > 0);
    for (const record of others) {
      assert.equal(
        record.resource[TelemetryAttribute.AppInstallationId],
        INSTALLATION_ID
      );
    }
  });

  test("a discard with no bound runtime still writes the local record", () => {
    const fixture = createFixture();
    const log = vi.spyOn(gatewayLog, "info");
    SCENARIOS[0].discard(fixture);
    assert.equal(log.mock.calls.length, 1);
  });

  test("a report before the bind emits nothing", () => {
    const emit = vi.fn();
    const bridge = createOnboardingDiscardTelemetry();
    bridge.report(discardInput());
    bridge.bindRuntime({ emitOnboardingDiscardEvent: emit });
    bridge.report(discardInput());
    assert.equal(emit.mock.calls.length, 1);
  });
});

describe("buildOnboardingDiscardRecord", () => {
  test("omits an event, step or age the contract does not admit, keeping the reason", () => {
    const record = buildOnboardingDiscardRecord({
      ...discardInput(),
      originalEvent: "constructor",
      step: "toString",
      flowId: null,
      queueAgeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(record.attributes).toEqual({
      [TelemetryAttribute.OnboardingAnalyticsAction]:
        OnboardingAnalyticsAction.EventDropped,
      [TelemetryAttribute.OnboardingAnalyticsReason]: Reason.QueueOverflow,
    });
  });

  test("drops a malformed attempt id but keeps the record", () => {
    const record = buildOnboardingDiscardRecord({
      ...discardInput(),
      flowId: "flow-1",
    });
    assert.equal(
      record.attributes[TelemetryAttribute.OnboardingAnalyticsFlowId],
      undefined
    );
    assert.equal(
      record.attributes[TelemetryAttribute.OnboardingAnalyticsReason],
      Reason.QueueOverflow
    );
  });

  test.each(Object.values(Event))(
    "ships event %s under its own name",
    (name) => {
      const record = buildOnboardingDiscardRecord({
        ...discardInput(),
        originalEvent: name,
      });
      assert.equal(
        record.attributes[TelemetryAttribute.OnboardingAnalyticsOriginalEvent],
        name
      );
    }
  );

  test.each(Object.values(Phase))(
    "ships step %s under its own name",
    (step) => {
      const record = buildOnboardingDiscardRecord({ ...discardInput(), step });
      assert.equal(
        record.attributes[TelemetryAttribute.OnboardingAnalyticsStep],
        step
      );
    }
  );

  test("maps the queue age onto duration_ms", () => {
    const record = buildOnboardingDiscardRecord(discardInput());
    assert.equal(record.attributes[TelemetryAttribute.DurationMs], 1234);
  });
});

test("the composition root binds the runtime to the discard bridge", () => {
  // `desktop-services.ts` imports `electron`; without this the production bind
  // could be deleted and every case above would still pass.
  let bound = false;
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "onboardingDiscardTelemetry" &&
      node.expression.name.text === "bindRuntime" &&
      node.arguments.length === 1 &&
      isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "appOtelRuntime"
    ) {
      bound = true;
    }
    forEachChild(node, visit);
  };
  forEachChild(desktopServicesSource(), visit);
  assert.ok(bound);
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const state = {
    status: DesktopAuthStatus.Authenticated as DesktopAuthStatus,
    identity: {
      userId: USER_ID,
      organizationId: ORG_ID,
    } as SignedInUserIdentity | null,
  };
  const fetcher = vi.fn<typeof fetch>();
  const router = createObservabilityLaneRouter({
    fetch: fetcher,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.example.test",
    getPluginVersion: () => "plugin-1",
    getAppVersion: () => APP_VERSION,
    getIdentity: () => state.identity,
    getAuthStatus: () => state.status,
    // Authenticated analytics readiness held unavailable throughout.
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => TARGET_ID,
    getNodeUuid: () => NODE_UUID,
    isSinglePlayerInstall: () => false,
    isPreAuthSendEnabled: () => false,
    onUnauthorized() {},
  });
  routers.push(router);
  return { state, router, fetcher };
}

function onboardingEvent(): DesktopAnalyticsLaneEvent {
  return {
    event: Event.StepViewed,
    occurredAt: new Date(0).toISOString(),
    properties: {
      [Property.FlowId]: FLOW,
      [Property.Step]: Phase.SyncPolicy,
      [Property.StepIndex]: 0,
      [Property.DeviceId]: NODE_UUID,
      sensitive: SENSITIVE,
    },
  };
}

function discardInput() {
  return {
    reason: Reason.QueueOverflow,
    originalEvent: Event.StepViewed,
    step: Phase.SyncPolicy,
    flowId: FLOW,
    queueAgeMs: 1234,
  };
}

async function startBoundRuntime(
  transport: StubTransport
): Promise<DesktopOtelRuntime> {
  const runtime = createDesktopOtelRuntime({
    appVersion: APP_VERSION,
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => INSTALLATION_ID,
    getDeviceId: () => DEVICE_ID,
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  onboardingDiscardTelemetry.bindRuntime(runtime);
  return runtime;
}

type DecodedLogRecord = {
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
};

function decodeLogRecords(transport: StubTransport): DecodedLogRecord[] {
  const logRequestType = getOtlpRequestType(OtlpExportKind.Logs);
  const records: DecodedLogRecord[] = [];
  for (const shipment of transport.shipments) {
    if (shipment.signal !== KeylessTelemetrySignal.Logs) {
      continue;
    }
    const request = logRequestType.toObject(
      logRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as { resourceLogs?: unknown };
    for (const resourceLog of asOtlpRecordArray(request.resourceLogs)) {
      const resource = resourceLog.resource as
        | { attributes?: unknown }
        | undefined;
      const resourceAttributes = decodeOtlpAttributes(
        asOtlpRecordArray(resource?.attributes)
      );
      for (const scopeLog of asOtlpRecordArray(resourceLog.scopeLogs)) {
        for (const record of asOtlpRecordArray(scopeLog.logRecords)) {
          records.push({
            attributes: decodeOtlpAttributes(
              asOtlpRecordArray(record.attributes)
            ),
            resource: resourceAttributes,
          });
        }
      }
    }
  }
  return records;
}

function decodeDiscards(transport: StubTransport): DecodedLogRecord[] {
  return decodeLogRecords(transport).filter(
    (record) =>
      record.attributes[TelemetryAttribute.OnboardingAnalyticsAction] !==
      undefined
  );
}

/** Byte-level, so an identifier in any encoded field is caught. */
function discardShipmentText(transport: StubTransport): string[] {
  const texts = transport.shipments
    .map((shipment) => Buffer.from(shipment.body).toString("latin1"))
    .filter((text) => text.includes(OnboardingAnalyticsAction.EventDropped));
  return texts;
}
