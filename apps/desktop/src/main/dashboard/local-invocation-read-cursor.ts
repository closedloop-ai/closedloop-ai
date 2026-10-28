/**
 * @file local-invocation-read-cursor.ts
 * @description ISS-10640 — where a desktop-local invocation page ended, so the
 * next read can start strictly after it. The SQLite twin of the cloud's
 * `apps/api/app/agent-components/invocation-read-cursor.ts` (ISS-9880).
 *
 * The position is compared BY VALUE, never carried as a row reference. A row
 * reference loses its place when the anchor leaves the FILTERED set, and this
 * read's own identity predicate drops rows on reattribution — a row whose
 * `local_component_id` is rewritten to another component leaves the page's
 * population without being deleted — not only on delete.
 *
 * Two things differ from the cloud module rather than being restatements of it:
 *
 * `invoked_at` is a SQLite TEXT column holding an ISO-8601 string, not a
 * timestamp, and the read orders by that raw column. So the cursor carries the
 * STRING and compares it as text; folding it to epoch ms would order the cursor
 * on a different collation from the query it is paging and could place the
 * boundary between two rows the `ORDER BY` considers equal.
 *
 * The tuple's ids are not shape-checked. The cloud checks its uuids because a
 * non-uuid in a Prisma comparison is a query error rather than a miss; a bound
 * parameter in SQLite is only ever a miss, so a check here would refuse tokens
 * the store can answer without preventing anything.
 */

import { z } from "zod";

/**
 * A page boundary under the read's order,
 * `invoked_at DESC NULLS LAST, session_id ASC, sequence ASC,
 * external_invocation_id ASC`.
 */
export type LocalInvocationReadCursor = {
  /** `invoked_at` verbatim, or `null` — the column is nullable and sorts last. */
  invokedAt: string | null;
  sessionId: string;
  sequence: number;
  externalInvocationId: string;
};

type LocalInvocationReadCursorSql = {
  clause: string;
  params: (string | number)[];
};

const CURSOR_SCHEMA = z.object({
  t: z.string().nullable(),
  s: z.string(),
  // Bounded at both ends: `Number.isInteger(-1e21)` is `true`, and a magnitude
  // past the safe range has already lost the precision the comparison needs.
  // Unlike the cloud's int4 bound this is not a driver-range guard — SQLite
  // INTEGER is 64-bit, so an out-of-range value would simply match nothing.
  q: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  e: z.string(),
});

export function encodeLocalInvocationReadCursor(
  cursor: LocalInvocationReadCursor
): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.invokedAt,
      s: cursor.sessionId,
      q: cursor.sequence,
      e: cursor.externalInvocationId,
    }),
    "utf8"
  ).toString("base64url");
}

/** `null` for anything this read did not mint. */
export function decodeLocalInvocationReadCursor(
  raw: string
): LocalInvocationReadCursor | null {
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
    invokedAt: parsed.data.t,
    sessionId: parsed.data.s,
    sequence: parsed.data.q,
    externalInvocationId: parsed.data.e,
  };
}

/**
 * Every invocation that sorts strictly after `cursor`, as a clause plus its
 * positional parameters.
 *
 * The null tail needs its own arm in both directions. SQLite three-valued
 * logic makes `invoked_at < ?` UNKNOWN for a null cell, so from a timestamped
 * cursor the untimestamped rows the `ORDER BY` puts last would silently vanish
 * without the explicit `IS NULL` term; and from a null cursor nothing
 * timestamped can follow, so that arm is the whole predicate.
 */
export function localInvocationReadCursorSql(
  cursor: LocalInvocationReadCursor
): LocalInvocationReadCursorSql {
  const ties = localInvocationCursorTiebreakSql(cursor);
  if (cursor.invokedAt === null) {
    return {
      clause: `(invoked_at IS NULL AND ${ties.clause})`,
      params: ties.params,
    };
  }
  return {
    clause: `(invoked_at < ? OR invoked_at IS NULL OR (invoked_at = ? AND ${ties.clause}))`,
    params: [cursor.invokedAt, cursor.invokedAt, ...ties.params],
  };
}

/**
 * The ascending tail of the tuple, for rows sharing the cursor's `invoked_at`.
 *
 * It stops at `external_invocation_id` even though the read also orders by
 * `id`: `@@unique([sessionId, externalInvocationId])` makes this prefix already
 * total, so an `id` arm could never decide a row. Dropping that constraint is
 * what would make one necessary.
 */
function localInvocationCursorTiebreakSql(
  cursor: LocalInvocationReadCursor
): LocalInvocationReadCursorSql {
  return {
    clause:
      "(session_id > ? OR (session_id = ? AND sequence > ?) OR (session_id = ? AND sequence = ? AND external_invocation_id > ?))",
    params: [
      cursor.sessionId,
      cursor.sessionId,
      cursor.sequence,
      cursor.sessionId,
      cursor.sequence,
      cursor.externalInvocationId,
    ],
  };
}
