/**
 * @file decision-table-verification.ts
 * @description The decision-table verification phase's wire sub-schema —
 * discriminated on whether the phase reported at all, so a missing report is a
 * described state rather than an absent one.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";

export const decisionTableVerificationDiagnosticsSchema = z.discriminatedUnion(
  "telemetryStatus",
  [
    z.object({
      telemetryStatus: z.literal("reported"),
      telemetryFilePath: z.string(),
      lineNumber: z.number().int().nonnegative(),
      timestamp: z.string(),
      workdir: z.string(),
      decisionTablePath: z.string(),
      finalStatus: z.enum([
        "aligned",
        "aligned_with_clarifications",
        "verification_failed",
      ]),
      iterations: z.number().int().nonnegative(),
      driftKindCounts: z.object({
        codeDrift: z.number().int().nonnegative(),
        testDrift: z.number().int().nonnegative(),
        planAmbiguity: z.number().int().nonnegative(),
      }),
      fixesAttempted: z.number().int().nonnegative(),
      parseFailures: z.number().int().nonnegative(),
      verifierInvocations: z.number().int().nonnegative(),
      phaseDurationMs: z.number().int().nonnegative(),
    }),
    z.object({
      telemetryStatus: z.literal("missing"),
      telemetryFilePath: z.string(),
      filePresent: z.boolean(),
      linesRead: z.number().int().nonnegative(),
      invalidLines: z.number().int().nonnegative(),
      missingReason: z.enum([
        "file_not_found",
        "empty",
        "no_current_run_records",
        "read_error",
      ]),
      sinceIso: z.string().optional(),
      readError: z.string().optional(),
    }),
  ]
);
