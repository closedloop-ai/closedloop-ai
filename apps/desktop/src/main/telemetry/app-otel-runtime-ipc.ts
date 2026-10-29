import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  IpcQueryExecutionSchema,
  type IpcQueryRefusal,
  IpcQueryRefusalSchema,
  IpcQuerySourceSchema,
  IpcTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/ipc";
import type { Attributes } from "@opentelemetry/api";
import type {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";

/** Instrumented Agent Dashboard IPC handlers carrying perf wide events (FEA-1997). */
export const DesktopIpcOperation = {
  List: "list",
  Detail: "detail",
  Usage: "usage",
  PageData: "page_data",
} as const;

export type DesktopIpcOperation =
  (typeof DesktopIpcOperation)[keyof typeof DesktopIpcOperation];

export type DesktopIpcPerfEventInput = {
  operation: DesktopIpcOperation;
  /** Wall-clock span start (epoch ms); span duration is exactly `durationMs`. */
  startTimeUnixMs: number;
  /** Measured handler duration in whole milliseconds (already rounded). */
  durationMs: number;
  payloadBytes: number;
  resultCount: number;
  /** Rows matching the query before pagination; omitted when not measured. */
  matchedCount?: number;
  /** Rows inspected in memory; SQL-only paths omit unknown database scans. */
  scannedCount?: number;
  /**
   * ISS-8773: OMITTED when the COUNT could not run. An errored call still emits
   * — its `errorType` is the dimension that failure is worth recording under —
   * and a dimension nobody measured is absent rather than fabricated or null.
   */
  sessionCount?: number;
  /** Set only when the handler threw; marks the span ERROR for tail retention. */
  errorType?: string;
  /** Bounded query vocabulary; omitted when absent or unknown. */
  source?: ListQuerySource;
  /** Bounded execution path; omitted when absent or unknown. */
  execution?: ListQueryExecution;
  /** Bounded refusal code; present only when a canonical query is refused. */
  refusal?: IpcQueryRefusal;
};

/** Validate and project one IPC performance input onto the telemetry contract. */
export function buildDesktopIpcPerfAttributes(
  input: DesktopIpcPerfEventInput
): Attributes {
  const querySource = IpcQuerySourceSchema.safeParse(input.source);
  const queryExecution = IpcQueryExecutionSchema.safeParse(input.execution);
  const queryRefusal = IpcQueryRefusalSchema.safeParse(input.refusal);

  return IpcTelemetrySchema.parse({
    [TelemetryAttribute.IpcOperation]: input.operation,
    [TelemetryAttribute.DurationMs]: input.durationMs,
    ...(input.matchedCount === undefined
      ? {}
      : { [TelemetryAttribute.IpcMatchedCount]: input.matchedCount }),
    [TelemetryAttribute.IpcPayloadBytes]: input.payloadBytes,
    ...(queryExecution.success
      ? { [TelemetryAttribute.IpcQueryExecution]: queryExecution.data }
      : {}),
    ...(queryRefusal.success
      ? { [TelemetryAttribute.IpcQueryRefusal]: queryRefusal.data }
      : {}),
    ...(querySource.success
      ? { [TelemetryAttribute.IpcQuerySource]: querySource.data }
      : {}),
    [TelemetryAttribute.IpcResultCount]: input.resultCount,
    ...(input.scannedCount === undefined
      ? {}
      : { [TelemetryAttribute.IpcScannedCount]: input.scannedCount }),
    ...(input.sessionCount === undefined
      ? {}
      : { [TelemetryAttribute.IpcSessionCount]: input.sessionCount }),
    ...(input.errorType
      ? { [TelemetryAttribute.ErrorType]: input.errorType }
      : {}),
  });
}
