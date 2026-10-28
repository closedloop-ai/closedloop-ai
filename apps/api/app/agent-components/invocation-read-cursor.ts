import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { z } from "zod";
import { isUuid } from "@/lib/is-uuid";

/**
 * ISS-9880 — where a component-detail invocation page ended, so the next page
 * can start strictly after it.
 *
 * The position is compared BY VALUE, never carried as a Prisma `cursor` row
 * reference. `session-candidate-stream.test.ts` ("resumes past a deleted
 * cursor row without stalling or skipping its successor") is the regression
 * that settled that: a row reference loses its place when the anchor leaves
 * the filtered set, and this read's own `where` drops rows on reattribution,
 * not only on delete.
 *
 * It carries the whole ordering tuple rather than reusing `lib/time-id-cursor`,
 * which is `(ms, id)` and cannot express this read's three intermediate
 * tiebreakers or a null lead key.
 */
export type InvocationReadCursor = {
  /** `invokedAt` in epoch ms, or `null` — the column is nullable and sorts last. */
  invokedAtMs: number | null;
  generationId: string;
  sequence: number;
  externalInvocationId: string;
};

/** The ECMAScript `Date` range, in milliseconds either side of the epoch. */
const MAX_DATE_MS = 8_640_000_000_000_000;

const CURSOR_SCHEMA = z.object({
  t: z.number().int().min(-MAX_DATE_MS).max(MAX_DATE_MS).nullable(),
  g: z.string().refine(isUuid),
  // Bounded at the COLUMN's range, both ends. `agent_component_invocations.
  // sequence` is `INTEGER` (int4) — migration 20260723200300 — so a value
  // outside it is a `22003 integer out of range` at the driver, not a miss.
  // Same reason `t` is bounded and `g` is uuid-checked above; the floor matters
  // as much as the ceiling because `Number.isInteger(-1e21)` is `true`
  // (marisolashgrove review).
  s: z.number().int().min(POSTGRES_INT4_MIN).max(POSTGRES_INT4_MAX),
  e: z.string(),
});

export function encodeInvocationReadCursor(
  cursor: InvocationReadCursor
): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.invokedAtMs,
      g: cursor.generationId,
      s: cursor.sequence,
      e: cursor.externalInvocationId,
    }),
    "utf8"
  ).toString("base64url");
}

/**
 * `null` for anything this read did not mint. The uuid shapes are checked here
 * because a non-uuid string in a Prisma comparison is a query error, not a
 * miss — the same reason `token-trend-cursor.ts` checks its id.
 */
export function decodeInvocationReadCursor(
  raw: string
): InvocationReadCursor | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = CURSOR_SCHEMA.safeParse(decoded);
  if (!parsed.success) {
    return null;
  }
  return {
    invokedAtMs: parsed.data.t,
    generationId: parsed.data.g,
    sequence: parsed.data.s,
    externalInvocationId: parsed.data.e,
  };
}

/**
 * Every invocation that sorts strictly after `cursor` under the read's order,
 * `invokedAt desc nulls last, generationId asc, sequence asc,
 * externalInvocationId asc, id asc`.
 *
 * A null `invokedAt` sorts after every timestamp, so from a timestamped cursor
 * the null tail is always included, and from a null cursor nothing timestamped
 * can follow.
 */
export function invocationReadCursorWhere(cursor: InvocationReadCursor) {
  const afterTies = { OR: tiebreakAfter(cursor) };
  if (cursor.invokedAtMs === null) {
    return { AND: [{ invokedAt: null }, afterTies] };
  }
  const invokedAt = new Date(cursor.invokedAtMs);
  return {
    OR: [
      { invokedAt: { lt: invokedAt } },
      { invokedAt: null },
      { AND: [{ invokedAt }, afterTies] },
    ],
  };
}

/**
 * The ascending tail of the tuple, for rows sharing the cursor's `invokedAt`.
 *
 * It stops at `externalInvocationId` even though the read also orders by `id`:
 * `@@unique([generationId, externalInvocationId])` makes this prefix already
 * total, so an `id` arm could never decide a row. Dropping that constraint is
 * what would make one necessary.
 */
function tiebreakAfter(cursor: InvocationReadCursor) {
  const { generationId, sequence, externalInvocationId } = cursor;
  return [
    { generationId: { gt: generationId } },
    { generationId, sequence: { gt: sequence } },
    {
      generationId,
      sequence,
      externalInvocationId: { gt: externalInvocationId },
    },
  ];
}
