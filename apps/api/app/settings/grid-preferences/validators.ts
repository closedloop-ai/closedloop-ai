import {
  GRID_PREFERENCE_VALUE_MAX_BYTES,
  type GridPreferenceUpsertRequest,
} from "@repo/api/src/types/grid-preferences";
import {
  gridPreferenceUpsertRequestEnvelopeSchema,
  gridPreferenceUpsertRequestEnvelopeShape,
} from "@repo/api/src/types/grid-preferences-schema";
import {
  containsLoneSurrogate,
  containsNulCharacter,
} from "@repo/api/src/types/postgres-text";
import { z } from "zod";
import {
  PostgresJsonDepthExceededError,
  PostgresJsonKeyCollisionError,
  sanitizePostgresJson,
} from "@/lib/agent-sessions-text-sanitizer";
import { jsonObjectSchema } from "@/lib/json-schema";

/**
 * Raw JSON can spell one parsed character as a six-byte `\uXXXX` escape, so the
 * transport cap leaves enough room for valid values before the semantic cap runs.
 */
export const GRID_PREFERENCE_REQUEST_MAX_BYTES =
  GRID_PREFERENCE_VALUE_MAX_BYTES * 6 + 4096;

export const gridPreferenceUpsertRequestValidator: z.ZodType<GridPreferenceUpsertRequest> =
  z
    .object({
      ...gridPreferenceUpsertRequestEnvelopeShape,
      value: jsonObjectSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
      const envelope =
        gridPreferenceUpsertRequestEnvelopeSchema.safeParse(value);
      if (!envelope.success) {
        for (const issue of envelope.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: [...issue.path],
          });
        }
      }
      addValueByteSizeIssue(value.value, ctx);
    })
    .transform((request, ctx) => ({
      ...request,
      value: storableValue(request.value, ctx),
    }));

function addValueByteSizeIssue(
  value: GridPreferenceUpsertRequest["value"],
  ctx: z.core.$RefinementCtx
): void {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength <= GRID_PREFERENCE_VALUE_MAX_BYTES) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: `value must be at most ${GRID_PREFERENCE_VALUE_MAX_BYTES} bytes when JSON encoded`,
    path: ["value"],
  });
}

/**
 * ISS-10436: `value` lands in a `jsonb` column through `JSON.stringify`, which
 * spells a NUL as a six-character escape that Postgres refuses (22P05), so the
 * write answered 500 for a caller error. Strings are sanitized the way the
 * agent-session lanes sanitize theirs; two keys that collapse into one are
 * refused rather than silently merged. The sanitizer recurses and refuses a
 * value deeper than its cap, but such a value is valid input today and this
 * change must not start rejecting it: a deep value that is clean passes through
 * as-is, and only a deep value that Postgres would refuse anyway is a 400.
 */
function storableValue(
  value: GridPreferenceUpsertRequest["value"],
  ctx: z.core.$RefinementCtx
): GridPreferenceUpsertRequest["value"] {
  try {
    return sanitizePostgresJson(value, { rejectKeyCollisions: true });
  } catch (error) {
    if (error instanceof PostgresJsonKeyCollisionError) {
      ctx.addIssue({
        code: "custom",
        message: GRID_PREFERENCE_VALUE_KEY_COLLISION_MESSAGE,
        path: ["value"],
      });
      return z.NEVER;
    }
    if (!(error instanceof PostgresJsonDepthExceededError)) {
      throw error;
    }
    if (hasUnstorableText(value)) {
      ctx.addIssue({
        code: "custom",
        message: GRID_PREFERENCE_VALUE_TOO_DEEP_TO_SANITIZE_MESSAGE,
        path: ["value"],
      });
      return z.NEVER;
    }
    return value;
  }
}

/**
 * Iterative, so it has no depth cap of its own. Checks every string and every
 * object key against the same two classes the sanitizer strips.
 */
function hasUnstorableText(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsNulCharacter(current) || containsLoneSurrogate(current)) {
        return true;
      }
      continue;
    }
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (containsNulCharacter(key) || containsLoneSurrogate(key)) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

export const GRID_PREFERENCE_VALUE_KEY_COLLISION_MESSAGE =
  "value has two keys that become the same key once unstorable characters are removed";

export const GRID_PREFERENCE_VALUE_TOO_DEEP_TO_SANITIZE_MESSAGE =
  "value is nested too deeply to sanitize and contains characters Postgres cannot store";
