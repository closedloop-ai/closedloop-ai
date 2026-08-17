/**
 * @file desktop-agent-sessions-schema-primitives.ts
 * @description The reusable FIELD-level coercions the desktop sync schemas are
 * built from: ISO dates, the three trimmed-string variants (nullable, omission-
 * preserving, bounded), and the defensive JSON-object pipe.
 *
 * Extracted from `desktop-agent-sessions-schema.ts` (ISS-5029) — that module had
 * grown past the 1,000-line ceiling, and "how one wire field is coerced" is a
 * cohesive concern distinct from "what shape a session or component payload
 * has". Every one of these was already private to that module, so nothing
 * outside it changes.
 *
 * The rule they all share: an OMITTED optional field and an explicit `null` are
 * different claims where the writer distinguishes them, so the helper that must
 * preserve omission is separate from the one that folds it to `null`. Picking
 * the wrong one is how a stale desktop silently clears a stored value.
 */
import { SYNCED_COMPONENT_IDENTITY_MAX_CHARS } from "@repo/api/src/types/agent-session";
import { TRACE_DURATION_MAX_CHARS } from "@repo/api/src/utils/trace-duration";
import { z } from "zod";
import { jsonObjectSchema } from "./json-schema";

export const isoDateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );

export const nullableTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

export const optionalPreservedTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

/**
 * ISS-4675: an `optionalPreservedTrimmedStringSchema` for the pre-formatted
 * duration fields (`wallClock`, `activeAgent`, `waitingUser`), bounded at
 * {@link TRACE_DURATION_MAX_CHARS}.
 *
 * Omission (`undefined`) is preserved distinctly from an explicit `null`, exactly
 * like the unbounded helper, because the producer sends THREE distinct claims
 * here and the cloud patch has to honor all three:
 *
 * - OMITTED — no claim; the patch preserves whatever is stored.
 * - `"0s"` — a MEASURED zero, and an overwrite like any other duration string.
 * - `null` — UNMEASURED (nothing parseable to measure over); clears a stale value.
 *
 * ISS-4569 inverted that middle case: a recomputed zero used to be sent as an
 * explicit `null`, so `null` meant both "measured zero" and "unknown". This is a
 * version-skewed wire contract, so a pre-ISS-4569 desktop still sends `null` for
 * a measured zero and the cloud cannot tell it apart from a genuine unmeasured
 * value. Accepted deliberately, not overlooked: that `null` lands exactly where
 * it always did, so no already-correct value is degraded — old clients simply do
 * not get the measured-zero distinction until they upgrade. Nothing to shim.
 */
export const boundedDurationStringSchema = z
  .union([z.string().max(TRACE_DURATION_MAX_CHARS), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

export const optionalJsonObjectSchema = z
  .unknown()
  .pipe(jsonObjectSchema)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * A `nullableTrimmedStringSchema` that also rejects an over-long value up front
 * (FEA-4011). Used for a component's identity fields (`componentKey`, `name`)
 * that ride into the `search_document` route metadata — the length cap is
 * checked BEFORE the trim transform so an abusive payload is 400'd, not stored.
 */
export const boundedNullableTrimmedStringSchema = z
  .union([z.string().max(SYNCED_COMPONENT_IDENTITY_MAX_CHARS), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  });
