import type { JsonObject } from "@repo/api/src/types/common";
import type { Prisma } from "@repo/database";
import { z } from "zod";
import { parseJsonObject } from "@/lib/json-schema";
import { toNumber } from "@/lib/prisma-number";

const uuidSchema = z.uuid();

export function decimalToNumber(
  value: Prisma.Decimal | number | null | undefined
): number {
  return toNumber(value);
}

// Token-usage columns are BigInt in Postgres (int8) so a single huge synced
// session can't overflow int4 and fail the upsert. The cloud surfaces expose
// them as JS numbers, which is exact up to Number.MAX_SAFE_INTEGER — the same
// ceiling the desktop side preserves — so narrowing here is lossless in practice
// and keeps these counts JSON-serializable.
export function tokenCountToNumber(
  value: bigint | number | null | undefined
): number {
  return toNumber(value);
}

export function parseJsonArray<T>(value: unknown, schema: z.ZodType<T>): T[] {
  const parsed = z.array(schema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseJsonValue<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function formatCurrency(value: number): string | null {
  return value > 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value)
    : null;
}

export function toMetadata(value: unknown): JsonObject | null {
  return parseJsonObject(value) ?? null;
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
