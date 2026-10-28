/**
 * @file app-otel-runtime-onboarding.test.ts
 * @description ISS-6340 (PRD-650 issue 7) coverage for the desktop onboarding
 * lifecycle RECORD the OTel runtime ships over the keyless relay. The
 * assertions decode the real OTLP protobuf the runtime shipped to the
 * transport, not an in-process spy, and the runtime is the real
 * `createDesktopOtelRuntime` with no authentication established.
 *
 * Moved out of `onboarding-telemetry.test.ts` when ISS-10855 deleted the
 * renderer's onboarding-flow telemetry lane: the record builder these cases pin
 * still ships, because the onboarding local-state sweep reports a malformed
 * reply through it.
 */
import assert from "node:assert/strict";
import {
  OnboardingConsentLevel,
  OnboardingEvent,
  OnboardingStep,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { afterEach, test } from "vitest";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  type CreateDesktopOtelRuntimeOptions,
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopAppOperatingMode } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  // The OTel global registries are process-wide; a runtime left registered
  // would have the next test's records land in the previous test's exporters.
  trace.disable();
  metrics.disable();
  logs.disable();
});

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
 * Decode the attributes of every onboarding log record the runtime actually
 * shipped over the relay, identified by the `onboarding.event` discriminator.
 *
 * The record's event NAME is deliberately not read here: the desktop's own OTLP
 * descriptor does not carry the LogRecord `event_name` field, exactly as the
 * import-health suite documents.
 */
function decodeRelayOnboardingRecords(
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
          if (attributes[TelemetryAttribute.OnboardingEvent] === undefined) {
            continue;
          }
          decoded.push(attributes);
        }
      }
    }
  }
  return decoded;
}

async function startRelayRuntime(
  organization: Pick<
    CreateDesktopOtelRuntimeOptions,
    "getOperatingMode" | "getOrganizationId"
  > = {}
): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_onboarding",
    isPackaged: false,
    telemetryTransport: transport,
    ...organization,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}

test("no organization id rides an onboarding record", async () => {
  // Onboarding is the pre-auth window and the org is the customer's identity, so
  // these records carry anonymous install attribution and nothing else — even
  // though `AppTelemetrySchema` permits the attribute and the lifecycle SPANS do
  // attach it via `getActivityOrganizationAttribute`.
  //
  // The runtime has an org to attach — a multiplayer install with one resolved,
  // the condition under which dead-end records DO carry it — so this pins the
  // omission, not the absence of an org.
  const { runtime, transport } = await startRelayRuntime({
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => "org_0123456789abcdef",
  });

  runtime.emitOnboardingEvent({
    step: OnboardingStep.Setup,
    event: OnboardingEvent.ConsentRecorded,
    consentLevel: OnboardingConsentLevel.Full,
  });
  await runtime.flush();

  const [record] = decodeRelayOnboardingRecords(transport);
  assert.ok(record, "expected one onboarding record on the relay");
  assert.equal(record[TelemetryAttribute.AppOrganizationId], undefined);
  // Anchored on surviving non-PII content so an empty record cannot pass.
  assert.equal(record[TelemetryAttribute.OnboardingStep], OnboardingStep.Setup);
});

test("consent level is attached only to a consent decision", async () => {
  // Presence of the attribute is itself the signal that a choice was recorded,
  // so a non-consent event must OMIT it rather than serialize a null or an
  // "unknown" that would be counted as a real decision downstream.
  const { runtime, transport } = await startRelayRuntime();

  runtime.emitOnboardingEvent({
    step: OnboardingStep.Setup,
    event: OnboardingEvent.Abandoned,
    consentLevel: OnboardingConsentLevel.Full,
  });
  await runtime.flush();

  const [record] = decodeRelayOnboardingRecords(transport);
  assert.equal(record?.[TelemetryAttribute.OnboardingConsentLevel], undefined);
  assert.equal(
    record?.[TelemetryAttribute.OnboardingEvent],
    OnboardingEvent.Abandoned
  );
});

test("the consent-level set covers every canonical DataSyncLevel", () => {
  // `@repo/api/src/types/data-sync-level` is the SSOT, and its own docstring
  // records that ISS-6147 deleted three copies of this list. The contract cannot
  // import it (this package is published standalone), so it carries a fourth —
  // and this is the guard that stops the copy from silently rotting. Without it,
  // a fifth tier would map to `unknown` for every consent record forever and the
  // tier breakdown would quietly stop distinguishing it, with nothing red in CI.
  assert.deepEqual(
    Object.values(OnboardingConsentLevel).filter(
      (level) => level !== OnboardingConsentLevel.Unknown
    ),
    Object.values(DataSyncLevel)
  );
});
