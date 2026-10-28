/**
 * @file app-otel-runtime-sync-batch.ts
 * @description The `sync.*` attribute projection for one sync batch, moved out
 * of `app-otel-runtime.ts` (ISS-11347) to keep that file from growing past the
 * size contract. The runtime keeps the parse, the emit and the swallow.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { DesktopSyncBatchEventInput } from "./app-otel-runtime.js";

/**
 * Project one batch event onto the `sync.*` attribute bag, omitting every field
 * the producer did not measure.
 *
 * OMISSION IS THE CONTRACT, not a formatting choice: `sync.payload_bytes: 0`
 * reads as a genuinely empty batch and `sync.attempt: 1` reads as a measured
 * first failure, so defaulting either would put a confident wrong number on a
 * monitor. It is also the cross-repo rule for an absent optional field — omit,
 * never serialize `null` (`AGENTS.md`, Cross-Repo Compatibility).
 */
export function buildSyncBatchAttributes(
  input: DesktopSyncBatchEventInput
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    [TelemetryAttribute.SyncEvent]: "batch",
    [TelemetryAttribute.SyncOutcome]: input.outcome,
  };
  const optional: [string, unknown][] = [
    [TelemetryAttribute.SyncPayloadBytes, input.payloadBytes],
    [TelemetryAttribute.SyncLatencyMs, input.latencyMs],
    [TelemetryAttribute.SyncReason, input.reason],
    [TelemetryAttribute.SyncLane, input.lane],
    [TelemetryAttribute.SyncDeadLetteredCount, input.deadLetteredCount],
    [TelemetryAttribute.SyncBatchId, input.batchId],
    [TelemetryAttribute.SyncSessionCount, input.sessionCount],
    [TelemetryAttribute.SyncAttempt, input.attempt],
    [TelemetryAttribute.SyncPayloadShaping, input.payloadShaping],
    [
      TelemetryAttribute.SyncTilingStrippedCount,
      input.tilingStrippedSessionCount,
    ],
    [TelemetryAttribute.SyncFreshestSessionLagMs, input.freshestSessionLagMs],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) {
      attributes[key] = value;
    }
  }
  return attributes;
}
