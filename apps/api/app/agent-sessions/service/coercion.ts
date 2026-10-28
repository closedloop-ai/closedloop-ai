import type { JsonObject } from "@repo/api/src/types/common";
import type { Prisma } from "@repo/database";
import { z } from "zod";
import { parseProtoSafeJsonObject } from "@/lib/json-schema";

const uuidSchema = z.uuid();

/**
 * Read a persisted JSON array MEMBER BY MEMBER: every member that satisfies
 * `schema` survives, and one unreadable member no longer discards the rest.
 *
 * ISS-6978. The previous whole-array `z.array(schema).safeParse` collapsed a
 * partially-readable column to `[]`, i.e. served a plausible-looking population
 * that can contradict a separately-stored count — the root `AGENTS.md`
 * bad-data rule's "never emit a plausible-but-wrong value". The same collapse
 * on the sibling `events` fold served a confident empty table to every
 * organization for three months (see `analytics-aggregation.ts`).
 *
 * Callers that need to know the read was partial use {@link readJsonArray},
 * which returns the incompleteness alongside the members.
 */
export function parseJsonArray<T>(value: unknown, schema: z.ZodType<T>): T[] {
  return readJsonArray(value, schema).members;
}

export function parseJsonValue<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * ISS-10177: proto-safe, because this rebuilds the STORED blob on every detail
 * read. Fixing the ingest boundary alone still lost an own `__proto__` key here
 * — the two sites drop it independently.
 */
export function toMetadata(value: unknown): JsonObject | null {
  return parseProtoSafeJsonObject(value) ?? null;
}

/**
 * Merge two arrays by a unique key, with incoming entries taking precedence
 * over existing entries. The first argument is a Prisma JSON value (the
 * persisted array), the second is the typed incoming array. Returns a plain
 * array suitable for JSON storage.
 */
export function mergeJsonArrayByKey<T extends Record<string, unknown>>(
  existing: Prisma.JsonValue | null | undefined,
  incoming: readonly T[],
  key: string
): T[] {
  const map = new Map<unknown, T>();
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (item && typeof item === "object" && key in item) {
        map.set((item as Record<string, unknown>)[key], item as T);
      }
    }
  }
  for (const item of incoming) {
    map.set(item[key], item);
  }
  return [...map.values()];
}

export function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

/**
 * Largest of the provided dates, ignoring null/undefined and unparseable
 * values. Used to advance a genuine-activity timestamp monotonically (PLN-1034).
 * Returns null only when no usable date is supplied.
 */
export function maxDate(...values: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = value.getTime();
    if (Number.isNaN(time)) {
      continue;
    }
    if (best === null || time > best.getTime()) {
      best = value;
    }
  }
  return best;
}

export function normalizeNullableString(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isUuid(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }
  return uuidSchema.safeParse(value).success;
}

/**
 * All-or-nothing read: the persisted array is returned only when EVERY member
 * satisfies `schema`, otherwise `[]`.
 *
 * This is the pre-ISS-6978 behaviour, kept ONLY where a consumer reads empty as
 * "the server has no data for this lane, run my own derived fallback" — today
 * `activityBuckets`, `markers`, `throttles`, and `phases` in `projections.ts`.
 * For those four, a member-by-member read would replace a COMPLETE derived
 * population with an incomplete authoritative one (fewer markers, fewer limit
 * dots, a silently understated measured cost strip) or, for `phases`, let a
 * dropped tail member name the previous phase as the current one. That trade is
 * user-visible and is escalated on ISS-6978 rather than decided here.
 *
 * Do not reach for this for a new call site. {@link parseJsonArray} is the
 * default; this exists to make the four exceptions legible, not to be adopted.
 */
export function parseCompleteJsonArrayOrEmpty<T>(
  value: unknown,
  schema: z.ZodType<T>
): T[] {
  const parsed = z.array(schema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * {@link parseJsonArray} plus an explicit incompleteness report.
 *
 * `incomplete` is OMITTED when the stored value was read whole, so one truthy
 * predicate (`if (read.incomplete)`) catches every partial read. It is a
 * discriminated object rather than a bare nullable count on purpose: a
 * `number | null` would make the WORST case — the value is not an array at all,
 * so the lost count is unknowable — the one that reads as "fine" under `!= null`,
 * `??`, and truthiness. Here an unknowable count carries no number at all.
 *
 * Absent, empty, and corrupt stay distinguishable: `null`/`undefined` and `[]`
 * are both "empty and whole" (no `incomplete`); a non-array value reports
 * `unreadable_value`; an array with bad members reports how many were lost.
 */
export function readJsonArray<T>(
  value: unknown,
  schema: z.ZodType<T>
): JsonArrayRead<T> {
  if (value === null || value === undefined) {
    return { members: [] };
  }
  if (!Array.isArray(value)) {
    return {
      members: [],
      incomplete: { reason: JsonArrayIncompleteReason.UnreadableValue },
    };
  }
  const members: T[] = [];
  let unreadableMembers = 0;
  for (const member of value) {
    const parsed = schema.safeParse(member);
    if (parsed.success) {
      members.push(parsed.data);
    } else {
      unreadableMembers += 1;
    }
  }
  if (unreadableMembers === 0) {
    return { members };
  }
  return {
    members,
    incomplete: {
      reason: JsonArrayIncompleteReason.UnreadableMembers,
      unreadableMembers,
    },
  };
}

/** Why a persisted JSON array could not be read whole. */
export const JsonArrayIncompleteReason = {
  /** The value was an array; `unreadableMembers` of its members failed the schema. */
  UnreadableMembers: "unreadable_members",
  /** The value was present but not an array, so the lost member count is unknowable. */
  UnreadableValue: "unreadable_value",
} as const;
export type JsonArrayIncompleteReason =
  (typeof JsonArrayIncompleteReason)[keyof typeof JsonArrayIncompleteReason];

export type JsonArrayIncompleteness =
  | {
      readonly reason: typeof JsonArrayIncompleteReason.UnreadableMembers;
      readonly unreadableMembers: number;
    }
  | { readonly reason: typeof JsonArrayIncompleteReason.UnreadableValue };

export type JsonArrayRead<T> = {
  readonly members: T[];
  /** Omitted when the stored value was read whole. */
  readonly incomplete?: JsonArrayIncompleteness;
};

/**
 * Fold one record's incompleteness into a running total over many records.
 *
 * `unreadable_value` ABSORBS: once a single blob was not an array, the
 * population-wide lost count is unknowable, and it stays unknowable however many
 * merely-partial records follow. Summing past it — or letting a later readable
 * record reset it — would publish a total that understates the loss.
 */
export function mergeJsonArrayIncompleteness(
  left: JsonArrayIncompleteness | undefined,
  right: JsonArrayIncompleteness
): JsonArrayIncompleteness {
  if (left === undefined) {
    return right;
  }
  if (
    left.reason === JsonArrayIncompleteReason.UnreadableValue ||
    right.reason === JsonArrayIncompleteReason.UnreadableValue
  ) {
    return { reason: JsonArrayIncompleteReason.UnreadableValue };
  }
  return {
    reason: JsonArrayIncompleteReason.UnreadableMembers,
    unreadableMembers: left.unreadableMembers + right.unreadableMembers,
  };
}
