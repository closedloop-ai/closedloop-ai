/**
 * @file desktop-agent-sessions-schema-primitives.ts
 * @description The reusable FIELD-level coercions the desktop sync schemas are
 * built from: ISO dates, the trimmed-string variants (nullable, omission-
 * preserving, duration), and the defensive JSON-object pipe.
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
import { TRACE_DURATION_MAX_CHARS } from "@repo/api/src/utils/trace-duration";
import { SESSION_TRACE_SOURCE_LIMITS } from "@repo/lib/session-trace/derivation";
import { z } from "zod";
import { protoSafeJsonObjectSchema } from "./json-schema";

export const isoDateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    "invalid_date"
  );

/**
 * ISS-12251: the session's creation time, as text. Not `isoDateSchema`: a value
 * that does not parse would fail the whole batch, while the ingest drops and
 * counts it (`resolveIncomingSessionCreatedAt`), leaving the rest to land.
 */
export const syncedSessionCreatedAtSchema = z.string().trim().optional();

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
 *
 * ISS-8051 removed every payload-size cap around this one and KEPT it, because
 * it bounds a VALUE DOMAIN rather than a payload: `parseTraceDurationMs`
 * independently rejects anything longer than {@link TRACE_DURATION_MAX_CHARS},
 * so admitting a longer value would store a duration the reader can only ever
 * read as `null`. These three are also bulk-read into the 10,000-row
 * `?sortBy=duration` candidate scan (`session-display-sort.ts`), where an
 * unbounded value is a read-path memory amplifier — ten thousand
 * near-request-limit strings landing in one sort read. The cap is checked
 * BEFORE the trim transform, so an over-long payload is 400'd rather than
 * silently stored truncated.
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

/**
 * ISS-10177: piped through {@link protoSafeJsonObjectSchema}, NOT the shared
 * `jsonObjectSchema`, because every field using this schema is a `metadata`
 * blob whose own `__proto__` key the desktop deliberately preserves. `z.record`
 * dropped it here at PARSE time, before `sanitizeMetadataForPersist` ever saw
 * the blob.
 */
export const optionalJsonObjectSchema = z
  .unknown()
  .pipe(protoSafeJsonObjectSchema)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * ISS-8051 review (whitlockk): the ceiling on `billingMode`, which is a GROUP-BY KEY
 * in the usage-cost summary rather than free text — every distinct value becomes
 * a distinct group each summary read has to materialize.
 *
 * ISS-8051's claim is that a `.max()` REJECT drops a 200-session batch; it was
 * never that the STORED value should be unbounded. {@link truncatedBillingModeSchema}
 * therefore truncates: an over-long mode still syncs, and the column's
 * cardinality stays bounded.
 */
export const BILLING_MODE_MAX_CHARS = 64;

export const truncatedBillingModeSchema = z
  .string()
  .trim()
  .min(1)
  .nullish()
  .transform((value) =>
    value == null ? value : value.slice(0, BILLING_MODE_MAX_CHARS)
  );

/**
 * Whether `value` names a timezone `Intl` can actually resolve.
 *
 * Checked by CONSTRUCTION rather than against `Intl.supportedValuesOf`, which
 * lists CANONICAL names only: a legacy alias (`US/Pacific`, `Asia/Calcutta`) is
 * a real zone an older desktop may still report, and folding one to `null`
 * would discard a timezone the reader can in fact honor.
 *
 * The probe formatter is deliberately NOT cached — caching a formatter under an
 * attacker-chosen key is the thing {@link ianaTimeZoneSchema} exists to prevent.
 */
function isResolvableTimeZone(value: string): boolean {
  try {
    return (
      Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions()
        .timeZone.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * ISS-8051 review (codex): FEA-1459's `deviceTimeZone` is an IANA zone NAME — a
 * VALUE DOMAIN, like `boundedDurationStringSchema` above, not free text.
 *
 * `getDateOnlyFormatter` (`./date-only`) keys a process-global map by whatever
 * lands here and caches MISSES too, so its stated invariant ("Bounded: there are
 * only ~430 IANA zone names") is only true while this field is a value domain. A
 * skewed or hostile producer sending distinct request-sized junk would otherwise
 * pin one map entry per value for the life of the serverless instance — and CSV
 * export would silently render every one of them as UTC regardless.
 *
 * Invalid input folds to `null` rather than 400ing, so ISS-8051's no-reject
 * property holds and nothing readable is lost: `toLocalDateOnly` already treats
 * `null` as "no device zone" and falls back to UTC, which is the same output the
 * invalid string produced — minus the retained cache key.
 *
 * `.min(1)` is checked BEFORE the trim, matching the shape this field had prior
 * to ISS-8051: a whitespace-only value must keep folding to `null` here rather
 * than becoming a newly-rejecting batch.
 */
/**
 * ISS-8051 review (davetho): the bound on a trace MARKER's label — truncated,
 * neither rejected nor left unbounded.
 *
 * `markers` is COUNT-capped only, and the `aggregatePayloadBytes` budget covers
 * the three trace-SOURCE arrays and never this one, so the desktop's
 * `clampMarkerLabel` would otherwise be the only bound on a label anywhere — and
 * a producer clamp is not a boundary. Truncating to the same shared limit keeps
 * ISS-8051's property (an over-long value must not 400 its 200-session batch)
 * without letting one near-request-sized label amplify DB, read and render work.
 */
export const truncatedMarkerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) =>
    value.slice(0, SESSION_TRACE_SOURCE_LIMITS.markerLabel)
  );

export const ianaTimeZoneSchema = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => {
    if (value == null) {
      return value;
    }
    const trimmed = value.trim();
    return isResolvableTimeZone(trimmed) ? trimmed : null;
  });
