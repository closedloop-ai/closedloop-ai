import { z } from "zod";
import { TelemetryAttribute } from "./src/attributes";

/** Strict permission attribute schema for harness permission-decision telemetry. */
export const PermissionTelemetrySchema = z
  .object({
    [TelemetryAttribute.GenAiPermissionDecision]: z
      .enum(["allow", "deny"])
      .optional(),
    [TelemetryAttribute.GenAiPermissionSource]: z
      .enum(["config", "hook", "user_permanent", "user_reject"])
      .optional(),
  })
  .strict();

/** Parsed permission telemetry attribute shape. */
export type PermissionTelemetry = z.infer<typeof PermissionTelemetrySchema>;
