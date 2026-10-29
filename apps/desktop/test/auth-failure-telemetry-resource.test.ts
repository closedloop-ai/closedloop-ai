/**
 * @file auth-failure-telemetry-resource.test.ts
 * @description ISS-6334: the no-identifiers contract for the auth-failure
 * signal, on the carrier its sibling suite does not read — the OTLP RESOURCE.
 *
 * `auth-failure-telemetry.test.ts` pins what the LOG RECORD may carry, which
 * `AppTelemetrySchema.strict()` enforces. That parse constrains the record and
 * nothing else. The Resource is a second, independent carrier: the SDK builds
 * ONE shared Resource holding `app.installation.id` and `device.id`, and the
 * protobuf serializer stamps it onto every export. So a suite that read only
 * record attributes would report the no-identifiers contract as proven while
 * both fleet identifiers shipped on every auth record, over the one pipe that
 * takes no credential to write to.
 *
 * These tests therefore DECODE the resource off the shipped bytes, and pin both
 * directions: the auth record must lose the identifiers, and an ordinary record
 * in the same process must keep them.
 */
import assert from "node:assert/strict";
import { AuthOutcome, AuthReason } from "@closedloop-ai/telemetry-contract/app";
import {
  TelemetryAttribute,
  TelemetryServiceName,
} from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { afterEach, describe, test } from "vitest";
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
import {
  createStubTransport,
  type StubTransport,
} from "./helpers/import-health-fixtures.js";

/**
 * Fleet identifiers the SDK Resource really carries. Neither may appear on the
 * resource of an auth failure — while an ordinary record emitted by the SAME
 * runtime must still carry them.
 */
const INSTALLATION_ID_MUST_NOT_SHIP = "install_auth_failure_identity";
const DEVICE_ID_MUST_NOT_SHIP = "device_auth_failure_identity";
const SERVICE_VERSION = "9.9.9";
const DEPLOYMENT_ENVIRONMENT = "desktop-prod";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

describe("ISS-6334: the no-identifiers contract covers the resource too", () => {
  test("an auth failure ships with no install or device identity", async () => {
    const transport = createStubTransport();
    const runtime = createDesktopOtelRuntime({
      appVersion: SERVICE_VERSION,
      env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: DEPLOYMENT_ENVIRONMENT },
      getAppInstallationId: () => INSTALLATION_ID_MUST_NOT_SHIP,
      getDeviceId: () => DEVICE_ID_MUST_NOT_SHIP,
      isPackaged: false,
      telemetryTransport: transport,
    });
    activeRuntime = runtime;
    await runtime.start();

    runtime.emitAuthFailureEvent({
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.CredentialInvalid,
    });
    // A second, ORDINARY log record from the same runtime. Without it, a change
    // that stripped both identifiers off the SHARED SDK resource — neutering
    // every signal's fleet attribution — would pass this test. Heartbeat
    // because it is the lifecycle event that emits a LOG record; the others
    // emit spans, which this suite's decoder does not read.
    runtime.emitAppLifecycleEvent({
      event: DesktopAppLifecycleEvent.Heartbeat,
      operatingMode: DesktopAppOperatingMode.SinglePlayer,
    });
    await runtime.flush();

    const { auth, other } = decodeShippedResources(transport);
    assert.ok(auth.length > 0, "the auth failure must have shipped");
    assert.ok(other.length > 0, "the ordinary record must have shipped");

    for (const resource of auth) {
      assert.equal(
        resource[TelemetryAttribute.AppInstallationId],
        undefined,
        "an auth failure must not carry app.installation.id on its resource"
      );
      assert.equal(
        resource[TelemetryAttribute.DeviceId],
        undefined,
        "an auth failure must not carry device.id on its resource"
      );
      // The de-identified resource is still ROUTABLE. Dropping these would
      // leave the signal unattributable to a build or an environment, which is
      // a different bug from the one this test exists to prevent.
      assert.equal(
        resource[TelemetryAttribute.ServiceName],
        TelemetryServiceName.Desktop
      );
      assert.equal(
        resource[TelemetryAttribute.ServiceVersion],
        SERVICE_VERSION
      );
      assert.equal(
        resource[TelemetryAttribute.DeploymentEnvironmentName],
        DEPLOYMENT_ENVIRONMENT
      );
    }
    for (const resource of other) {
      assert.equal(
        resource[TelemetryAttribute.AppInstallationId],
        INSTALLATION_ID_MUST_NOT_SHIP,
        "an ordinary record must keep its fleet identity"
      );
    }
  });

  test("neither identifier appears anywhere in the auth shipment bytes", async () => {
    const transport = createStubTransport();
    const runtime = createDesktopOtelRuntime({
      appVersion: SERVICE_VERSION,
      env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: DEPLOYMENT_ENVIRONMENT },
      getAppInstallationId: () => INSTALLATION_ID_MUST_NOT_SHIP,
      getDeviceId: () => DEVICE_ID_MUST_NOT_SHIP,
      isPackaged: false,
      telemetryTransport: transport,
    });
    activeRuntime = runtime;
    await runtime.start();

    runtime.emitAuthFailureEvent({
      outcome: AuthOutcome.PairingRejected,
      reason: AuthReason.CredentialInvalid,
    });
    await runtime.flush();

    // Byte-level, so it holds whatever field a future encoder might place an
    // identifier in — not only the resource attributes the decoder walks.
    const authBytes = transport.shipments
      .map((shipment) => Buffer.from(shipment.body).toString("latin1"))
      .filter((text) => text.includes(AuthReason.CredentialInvalid));
    assert.ok(authBytes.length > 0, "the auth shipment must be identifiable");
    for (const text of authBytes) {
      assert.ok(
        !text.includes(INSTALLATION_ID_MUST_NOT_SHIP),
        "the installation id must not appear in the auth shipment"
      );
      assert.ok(
        !text.includes(DEVICE_ID_MUST_NOT_SHIP),
        "the device id must not appear in the auth shipment"
      );
    }
  });
});

/**
 * Decode the RESOURCE attached to each shipped log record, partitioned by
 * whether the record is an auth failure (the `auth.outcome` discriminator).
 */
function decodeShippedResources(transport: StubTransport): {
  auth: Record<string, unknown>[];
  other: Record<string, unknown>[];
} {
  const logRequestType = getOtlpRequestType(OtlpExportKind.Logs);
  const auth: Record<string, unknown>[] = [];
  const other: Record<string, unknown>[] = [];
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
          const attributes = decodeOtlpAttributes(
            asOtlpRecordArray(record.attributes)
          );
          const bucket =
            attributes[TelemetryAttribute.AuthOutcome] === undefined
              ? other
              : auth;
          bucket.push(resourceAttributes);
        }
      }
    }
  }
  return { auth, other };
}
