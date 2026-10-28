import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import { boundedText, TelemetryTextMaxLength } from "./schema-primitives";

/**
 * ISS-6116: the closed, low-cardinality set of `harness.name` values — the five
 * agent CLIs the desktop collects from. Extracted from the inline `z.enum` this
 * file carried so the resource schema and the harness-scoped app records
 * validate against ONE list; a sixth harness added to only one of them is the
 * SSOT-drift-by-copy this const exists to make impossible. It lives here, next
 * to the only schema that requires it, rather than in `./attributes` — that
 * file is the attribute NAME registry and is at the repo's 1,000-line ceiling.
 *
 * Deliberately re-declared here rather than imported from `@repo/lib/harness`:
 * this package is published standalone and must not depend on a workspace
 * package. A desktop-side guard test asserts exact set equality against the
 * collector `Harness` enum, so the two cannot drift silently.
 *
 * Declared above `ResourceTelemetrySchema` because `z.enum` reads it at module
 * evaluation time; moving it below would be a temporal-dead-zone crash.
 */
export const TelemetryHarnessName = {
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor",
  Copilot: "copilot",
  OpenCode: "opencode",
} as const;

/** Literal union of `harness.name` values. */
export type TelemetryHarnessName =
  (typeof TelemetryHarnessName)[keyof typeof TelemetryHarnessName];

/** Strict resource attribute schema for service identity metadata. */
export const ResourceTelemetrySchema = z
  .object({
    [TelemetryAttribute.ServiceName]: boundedText(
      TelemetryTextMaxLength.ServiceName
    ),
    [TelemetryAttribute.ServiceVersion]: boundedText(
      TelemetryTextMaxLength.ServiceVersion
    ).optional(),
    [TelemetryAttribute.DeviceId]: boundedText(
      TelemetryTextMaxLength.DeviceId
    ).optional(),
    [TelemetryAttribute.HarnessName]: z.enum(TelemetryHarnessName).optional(),
  })
  .strict();

/** Parsed resource telemetry attribute shape. */
export type ResourceTelemetry = z.infer<typeof ResourceTelemetrySchema>;
