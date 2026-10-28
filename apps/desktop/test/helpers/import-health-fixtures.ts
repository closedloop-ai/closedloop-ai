/**
 * @file import-health-fixtures.ts
 * @description Shared fixtures for the desktop import-health telemetry suites
 * (ISS-5103's counters and ISS-6335's import outcome). Both suites drive the
 * same tracker through the same OTLP relay, so the stub transport, the OTLP
 * decode, and the importer doubles live here rather than in either file — a
 * drifted second copy of the decoder is how one suite silently stops describing
 * what the runtime actually ships.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import type {
  Harness,
  NormalizedSession,
} from "../../src/main/collectors/types.js";
import type {
  Importer,
  ImportResult,
} from "../../src/main/dashboard/agent-dashboard-db-types.js";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
} from "../../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../../src/main/otlp/proto-descriptor.js";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../../src/main/telemetry/app-otel-runtime.js";
import type { DesktopTelemetryTransport } from "../../src/main/telemetry/relay-telemetry-transport.js";

/** A stand-in session — the tracker never reads its fields, only the result. */
export const SESSION = {
  sessionId: "session-1",
} as unknown as NormalizedSession;

/**
 * The harness every fixture session claims. Arbitrary: import-health records
 * carry no harness attribute, so this only satisfies `importSession`'s signature
 * and must not be read as coverage of any harness-specific path.
 */
export const HARNESS = "claude" as Harness;

/** A tick cadence long enough that only explicit `flushNow()` calls fire. */
export const NO_AUTOMATIC_TICK_MS = 600_000;

/**
 * A relay transport that captures what the runtime shipped instead of sending
 * it. `shipments` is every `export()` call in order, so a suite can assert on
 * the bytes that actually crossed the transport seam rather than on the
 * in-process emit.
 *
 * SCOPE: it models a transport that always accepts. `export()` resolves `true`
 * unconditionally and `flush()` always succeeds, so it models NO delivery
 * failure — no rejection, no retry, no backpressure, no dropped batch. A suite
 * covering the exporter's failure handling needs its own double.
 */
export type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: KeylessTelemetrySignal; body: Uint8Array }>;
};

/** A fresh always-accepting `StubTransport` with an empty capture buffer. */
export function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: KeylessTelemetrySignal;
    body: Uint8Array;
  }> = [];
  return {
    shipments,
    start() {
      return;
    },
    stop() {
      return;
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
 * Decode the attributes of every log record the runtime actually shipped over
 * the relay, keeping only the import-health ones (identified by the
 * `import.event` discriminator). The record's event name is deliberately not
 * read here: the desktop's own OTLP descriptor does not carry the LogRecord
 * `event_name` field, so the names are pinned on the local-buffer path instead.
 */
export function decodeRelayImportRecords(
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
          if (attributes[TelemetryAttribute.ImportEvent] === undefined) {
            continue;
          }
          decoded.push(attributes);
        }
      }
    }
  }
  return decoded;
}

/** An importer that hands back `results` in order, then skips. */
export function importerReturning(...results: ImportResult[]): Importer {
  const queue = [...results];
  return {
    importSession: () =>
      Promise.resolve(queue.shift() ?? { skipped: true, reactivated: false }),
  };
}

/**
 * A sentinel snapshot source returning the same ids every call, so a second tick
 * sees every id as a survivor.
 */
export function stablePendingIds(
  ...ids: string[]
): (limit: number) => Promise<string[]> {
  return (limit: number) => Promise.resolve(ids.slice(0, Math.max(1, limit)));
}

/** A desktop OTel runtime already started against a capturing relay transport. */
export async function startRelayRuntime(
  installationId: string
): Promise<{ runtime: DesktopOtelRuntime; transport: StubTransport }> {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => installationId,
    isPackaged: false,
    telemetryTransport: transport,
  });
  await runtime.start();
  return { runtime, transport };
}
