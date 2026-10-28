/**
 * @file update-telemetry-relay.test.ts
 * @description ISS-7247: proof that the update lifecycle records actually reach
 * a sink, rather than merely being emitted.
 *
 * The assertions decode the real OTLP protobuf the REAL `createDesktopOtelRuntime`
 * shipped to the relay transport — the same pipe `app.lifecycle.event` rides and
 * the same pipe the Datadog evidence in the issue was read from. An in-process
 * spy would prove the reporter was called; only this proves the record leaves
 * the process on the lane that can be joined against the post-restart
 * `app.lifecycle.event:start`.
 *
 * The second half is the redaction contract: the collector strips any attribute
 * key that is not in the generated allow-list, so a key that ships but is not
 * allow-listed is silently dropped server-side and the instrumentation is
 * useless. That is asserted against the committed artifact.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UpdateEvent,
  UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
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
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";

/**
 * The exact attribute keys this instrumentation puts on the wire, spelled out
 * as literals rather than derived from `TelemetryAttribute`, so a rename in the
 * contract fails here instead of both sides moving together unreviewed.
 */
const EXPECTED_UPDATE_ATTRIBUTE_KEYS = [
  "update.boot_attempts",
  "update.current_version_age_days",
  "update.event",
  "update.failure_reason",
  "update.from_version",
  "update.to_version",
];

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
    start() {
      // no-op stub
    },
    stop() {
      // no-op stub
    },
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
 * One shipped update record: its own attributes, plus the RESOURCE attributes
 * of the batch it rode in.
 *
 * The resource half is not incidental. `app.installation.id` and
 * `service.version` are resource-level, which is exactly why a terminal update
 * record can be joined against the `app.lifecycle.event:start` beside it — they
 * share a resource. A test that only read record attributes would miss the join
 * key entirely.
 */
type ShippedUpdateRecord = {
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
};

/** Decode every update lifecycle record the runtime actually shipped. */
function decodeRelayUpdateRecords(
  transport: StubTransport
): ShippedUpdateRecord[] {
  const logRequestType = getOtlpRequestType(OtlpExportKind.Logs);
  const decoded: ShippedUpdateRecord[] = [];
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
          if (attributes[TelemetryAttribute.UpdateEvent] === undefined) {
            continue;
          }
          decoded.push({ attributes, resourceAttributes });
        }
      }
    }
  }
  return decoded;
}

async function startRelayRuntime(): Promise<{
  runtime: DesktopOtelRuntime;
  transport: StubTransport;
}> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "0.16.1451",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_update_lane",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();
  return { runtime, transport };
}

test("the post-restart terminal record reaches the relay carrying its from-to pair and installation id", async () => {
  const { runtime, transport } = await startRelayRuntime();

  assert.equal(
    runtime.emitUpdateEvent({
      event: UpdateEvent.RestartFailed,
      fromVersion: "0.16.696",
      toVersion: "0.16.1451",
      failureReason: UpdateFailureReason.VersionUnchanged,
      bootAttempts: 1,
    }),
    true,
    "a started runtime must report that the record reached it"
  );
  await runtime.flush();

  const records = decodeRelayUpdateRecords(transport);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateEvent],
    "restart_failed"
  );
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateFromVersion],
    "0.16.696"
  );
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateToVersion],
    "0.16.1451"
  );
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateFailureReason],
    "version_unchanged"
  );
  // The join keys the issue needs: without the installation id a fleet-wide
  // failure rate cannot be attributed, and `service.version` is what ties this
  // record to the `app.lifecycle.event:start` that reported the SAME running
  // build — which is the post-restart verification, expressed on the wire.
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.AppInstallationId],
    "install_update_lane"
  );
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceVersion],
    "0.16.1451",
    "the running build must travel with the record that judges it"
  );
});

test("the check record reaches the relay carrying the upgrade-lag pair", async () => {
  const { runtime, transport } = await startRelayRuntime();

  runtime.emitUpdateEvent({
    event: UpdateEvent.Check,
    fromVersion: "0.16.696",
    toVersion: "0.16.1451",
    currentVersionAgeDays: 42,
  });
  await runtime.flush();

  const record = decodeRelayUpdateRecords(transport)[0];
  assert.equal(record?.attributes[TelemetryAttribute.UpdateEvent], "check");
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateFromVersion],
    "0.16.696"
  );
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateToVersion],
    "0.16.1451"
  );
  assert.equal(
    record?.attributes[TelemetryAttribute.UpdateCurrentVersionAgeDays],
    42,
    "ISS-7225 needs how long this installation has been on its current build"
  );
});

test("a runtime that never started reports the record did NOT reach it", () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "0.16.1451",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_update_lane",
    isPackaged: false,
    telemetryTransport: transport,
  });

  // No `await runtime.start()`. The FALSE is what keeps the reconciler from
  // consuming an upgrade attempt on the strength of a record that never shipped.
  assert.equal(
    runtime.emitUpdateEvent({
      event: UpdateEvent.RestartedOnNewVersion,
      fromVersion: "0.16.696",
      toVersion: "0.16.1451",
      bootAttempts: 1,
    }),
    false
  );
  assert.deepEqual(transport.shipments, []);
});

test("every update attribute the desktop ships survives the collector redaction allow-list", () => {
  // The generated artifact the keyless collector's `redaction` processor is
  // configured from. A key that ships but is missing here is stripped
  // server-side, so the record would arrive at Datadog gutted and the
  // instrumentation would look present while answering nothing.
  const allowListPath = join(
    import.meta.dirname,
    "../../../packages/telemetry-contract/collector/allowed-attributes.json"
  );
  const allowList = JSON.parse(readFileSync(allowListPath, "utf8")) as {
    allowedKeys: string[];
  };

  for (const key of EXPECTED_UPDATE_ATTRIBUTE_KEYS) {
    assert.equal(
      allowList.allowedKeys.includes(key),
      true,
      `${key} is not in the collector allow-list and would be redacted away`
    );
  }
});
