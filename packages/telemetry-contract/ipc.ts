import { z } from "zod";
import { TelemetryAttribute } from "./src/attributes";
import { boundedText, TelemetryTextMaxLength } from "./src/schema-primitives";

/**
 * Strict IPC perf wide-event schema (FEA-1997). One event per Agent Dashboard
 * `list`/`detail`/`usage` IPC call carries the dimensions that expose the
 * many-sessions performance cliff: handler duration, serialized payload size,
 * returned row count, and the total local-store session count. `error.type` is
 * present only when the call failed (the span is also marked ERROR so the
 * collector tail policy retains it at 100%).
 *
 * The five core dimensions are required — the acceptance is that each emitted
 * event carries all of them — while `error.type` stays optional.
 */
export const IpcTelemetrySchema = z
  .object({
    [TelemetryAttribute.IpcOperation]: z.enum(["list", "detail", "usage"]),
    // Reuses the span schema's duration bound (0..24h in ms). Carried as an
    // explicit wide-event dimension in addition to the native span duration the
    // collector tail-sampling latency policy reads.
    [TelemetryAttribute.DurationMs]: z.number().int().min(0).max(86_400_000),
    [TelemetryAttribute.IpcPayloadBytes]: z.number().int().min(0),
    [TelemetryAttribute.IpcResultCount]: z.number().int().min(0),
    [TelemetryAttribute.IpcSessionCount]: z.number().int().min(0),
    [TelemetryAttribute.ErrorType]: boundedText(
      TelemetryTextMaxLength.ErrorType
    ).optional(),
  })
  .strict();

/** Parsed IPC perf telemetry attribute shape. */
export type IpcTelemetry = z.infer<typeof IpcTelemetrySchema>;
