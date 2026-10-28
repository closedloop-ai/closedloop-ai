import { z } from "zod";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
  sanitizePostgresText,
} from "@/lib/agent-sessions-text-sanitizer";
import { isRecord } from "@/lib/type-guards";

/**
 * SANITIZE BEFORE VALIDATE — the same order the desktop ingest boundary uses,
 * where `parseDesktopAgentSessionsPayload` runs `sanitizePostgresJson` over the
 * whole payload BEFORE `safeParse`. A NUL is legal in JSON and in `z.string()`
 * and illegal in a Postgres `text` column, so validating first turns an input
 * error into a 500 at the write.
 *
 * Preprocessed rather than re-declared so each length contract stays on the
 * wrapped schema and is re-applied to the SANITIZED value, which is the half
 * that matters: a name of nothing but NULs is non-empty to Zod and empty once
 * sanitized, so only this order rejects it instead of storing "". A missing or
 * non-string field is left for the wrapped schema to report, and a value with
 * no NUL or lone surrogate sanitizes to itself.
 *
 * Top-level fields only. A string nested in a record (custom-field values) is
 * wrapped with {@link sanitizeTextValue} at its own schema instead.
 */
export function sanitizeTextFields<Schema extends z.ZodTypeAny>(
  schema: Schema,
  fields: readonly string[]
) {
  return z.preprocess((raw) => {
    if (!isRecord(raw)) {
      return raw;
    }
    const sanitized: Record<string, unknown> = { ...raw };
    for (const field of fields) {
      const value = raw[field];
      if (typeof value === "string") {
        sanitized[field] = sanitizePostgresText(value);
      }
    }
    return sanitized;
  }, schema);
}

// An exhaustive policy rather than a list: a text field added to a request
// shape fails `tsc` at the caller's `satisfies Record<…, boolean>` instead of
// reaching Postgres unsanitized.
export function sanitizedTextFields(
  policy: Record<string, boolean>
): readonly string[] {
  return Object.entries(policy)
    .filter(([, sanitize]) => sanitize)
    .map(([field]) => field);
}

/** {@link sanitizeTextFields} for one value: a string is sanitized, anything else passes through. */
export function sanitizeTextValue<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess(
    (raw) => (typeof raw === "string" ? sanitizePostgresText(raw) : raw),
    schema
  );
}

/**
 * {@link sanitizeTextValue} for a JSON tree bound for a `jsonb` column: every
 * string and key, recursively. Two keys that collapse to one once sanitized are
 * a 400, since keeping either would drop the other. A tree deeper than the
 * sanitizer's bound passes through unsanitized, as it did before, so valid deep
 * input is not refused.
 */
export function sanitizeJsonTree<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess((raw, ctx) => {
    try {
      return sanitizePostgresJson(raw, { rejectKeyCollisions: true });
    } catch (error) {
      if (error instanceof PostgresJsonKeyCollisionError) {
        ctx.addIssue({ code: "custom", message: error.message });
        return raw;
      }
      if (error instanceof PostgresJsonDepthExceededError) {
        return raw;
      }
      throw error;
    }
  }, schema);
}
