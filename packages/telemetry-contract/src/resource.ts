import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import { boundedText, TelemetryTextMaxLength } from "./schema-primitives";

/** Strict resource attribute schema for service identity metadata. */
export const ResourceTelemetrySchema = z
  .object({
    [TelemetryAttribute.ServiceName]: boundedText(
      TelemetryTextMaxLength.ServiceName
    ),
    [TelemetryAttribute.ServiceVersion]: boundedText(
      TelemetryTextMaxLength.ServiceVersion
    ).optional(),
    [TelemetryAttribute.HarnessName]: z
      .enum(["claude", "codex", "cursor", "copilot", "opencode"])
      .optional(),
  })
  .strict();

/** Parsed resource telemetry attribute shape. */
export type ResourceTelemetry = z.infer<typeof ResourceTelemetrySchema>;
