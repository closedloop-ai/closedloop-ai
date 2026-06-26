import { z } from "zod";
import { TelemetryAttribute } from "./src/attributes";

/** Strict sync attribute schema for transport-health telemetry only. */
export const SyncTelemetrySchema = z
  .object({
    [TelemetryAttribute.SyncEvent]: z.enum(["batch"]).optional(),
    [TelemetryAttribute.SyncOutcome]: z
      .enum(["success", "failure", "dead_letter"])
      .optional(),
    [TelemetryAttribute.SyncPayloadBytes]: z.number().int().min(0).optional(),
    [TelemetryAttribute.SyncLatencyMs]: z.number().finite().min(0).optional(),
  })
  .strict();

/** Parsed sync telemetry attribute shape. */
export type SyncTelemetry = z.infer<typeof SyncTelemetrySchema>;
