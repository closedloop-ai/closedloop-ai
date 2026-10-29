import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { protoSafeRecord } from "@repo/lib/security/proto-safe-record";
import { z } from "zod";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  jsonValueSchema
);

export const stringRecordSchema = z.record(z.string(), z.string());

/** Parses an unknown value into a JSON object, returning null when invalid. */
export function parseJsonObject(value: unknown): JsonObject | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * ISS-10177 — the `__proto__`-preserving twin of {@link jsonValueSchema}, for the
 * session/agent `metadata` boundaries ONLY.
 *
 * `z.record` assigns onto a plain `{}`, so an own `__proto__` key delivered by
 * `JSON.parse` is swallowed by the inherited setter and vanishes with
 * `success: true` and no issue raised (`@repo/lib/security/proto-safe-record`
 * states the mechanism; the harm is DATA LOSS, not prototype pollution). The
 * desktop deliberately PRESERVES that key (ISS-8565 at the compactor, ISS-8883
 * at the byte-bounder) and `metadata-preview.ts` claims both lanes emit
 * byte-identical `metadata`, so dropping it here made that written contract
 * false.
 *
 * RECURSIVE on purpose: the drop is not only top-level. Measured before the fix,
 * `{"outer":{"__proto__":{"deep":1},"keep":2}}` parsed to `{"outer":{"keep":2}}`,
 * because {@link jsonValueSchema} recurses through `z.record` for every nested
 * object. A one-level guard would have left every nested blob still lossy.
 *
 * DELIBERATELY NOT a replacement for {@link jsonObjectSchema}, which keeps its
 * existing behavior for its ~31 other consumers (comments, compute targets,
 * grid preferences, the gateway wire, artifact links). Fixing those
 * would assert a cross-lane contract nobody wrote down; fixing the metadata
 * boundaries restores one this repo did. That scope call is recorded on
 * ISS-10177 — do not "unify" these two by widening the shared schema without
 * reopening it.
 */
export const protoSafeJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(protoSafeJsonValueSchema),
    protoSafeRecord(z.string(), protoSafeJsonValueSchema),
  ])
);

/** ISS-10177: {@link jsonObjectSchema} for a `metadata` blob, preserving `__proto__`. */
export const protoSafeJsonObjectSchema: z.ZodType<JsonObject> = protoSafeRecord(
  z.string(),
  protoSafeJsonValueSchema
);

/**
 * ISS-10177: {@link parseJsonObject} for a `metadata` blob. Returns null when
 * invalid, and preserves an own `__proto__` key instead of silently dropping it.
 */
export function parseProtoSafeJsonObject(value: unknown): JsonObject | null {
  const parsed = protoSafeJsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
