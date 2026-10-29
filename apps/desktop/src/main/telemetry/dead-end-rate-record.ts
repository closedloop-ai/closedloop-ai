/**
 * @file dead-end-rate-record.ts
 * @description ISS-12039 — both operands of the dead-end rate, as one unsampled
 * log record family written by the same builds.
 *
 * A log record rather than a counter: desktop counters export CUMULATIVE with
 * the install id stripped, so every install's running total shares one Datadog
 * series. Measured 2026-10-05, `sync.batch.count` read back each install's
 * running total as a per-interval count.
 */

import { DeadEndPhase } from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  DeadEndRateRecordName,
  DeadEndRateRecordSchema,
} from "@closedloop-ai/telemetry-contract/ipc";
import type { DesktopIpcOperation } from "./app-otel-runtime-ipc.js";
import { createDesktopOtelLogEmitChannel } from "./desktop-otel-log-emit-channel.js";

const DEAD_END_RATE_LOGGER_NAME = "closedloop-desktop-dead-end-rate";

/** Record one settled user-initiated IPC read, sampled into a span or not. */
export function recordIpcCall(operation: DesktopIpcOperation): void {
  emitRateRecord({ [TelemetryAttribute.IpcOperation]: operation });
}

/** Record one rendered dead end, whatever happens to its own log record. */
export function recordRenderedDeadEnd(): void {
  emitRateRecord({ [TelemetryAttribute.DeadEndPhase]: DeadEndPhase.Rendered });
}

function emitRateRecord(attributes: Record<string, unknown>): void {
  try {
    createDesktopOtelLogEmitChannel(DEAD_END_RATE_LOGGER_NAME).info(
      DeadEndRateRecordName,
      DeadEndRateRecordSchema.parse(attributes)
    );
  } catch {
    // Best-effort: recording must never throw into the surface it counts.
  }
}
