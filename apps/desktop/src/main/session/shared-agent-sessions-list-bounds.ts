/**
 * Paging bounds for the shared agent-sessions list query.
 *
 * A limit or offset arriving from the renderer is untrusted: it can be a
 * non-number, `NaN`, `Infinity`, a fraction, or negative. Both clamps floor the
 * value first and then bound it, so a limit can never be 0 or negative (which
 * would silently return an empty page) and an offset can never be negative
 * (which SQLite would reject). A non-finite or non-numeric input falls back to
 * the default rather than propagating a bad value into the query.
 *
 * Extracted verbatim from `shared-agent-sessions-api.ts` (ISS-4771 shrink-only
 * discipline: an over-ceiling grandfathered file must end up smaller than it
 * started).
 */

import { TABLE_PAGE_SIZE_MAX } from "@repo/api/src/types/table-page-size-limits";

export const DEFAULT_LIST_LIMIT = 25;
/**
 * ISS-9692 (codex review) — the largest page the LOCAL producer will serve,
 * derived from the largest rung the rows-per-page ladder offers.
 *
 * It was a bare `100` while the desktop renderer had just been taught to send
 * the reader's chosen size. Because this is a CLAMP and not a rejection, a
 * request for 250 came back holding 100 rows while the renderer computed the
 * next page's offset from 250 — so paging forward silently skipped rows 100
 * through 249, and the total and page count were derived from a size the
 * producer never honoured. A clamp that disagrees with the requester is worse
 * than a 400: nothing surfaces, the reader just never sees those sessions.
 *
 * Raised UNCONDITIONALLY, like every other cap in this change: a flag-off
 * renderer never asks for more than 100, and a producer that refused the larger
 * sizes would break the very reads the flag exists to allow.
 */
export const MAX_LIST_LIMIT = TABLE_PAGE_SIZE_MAX;

/**
 * ISS-9692 — how many EXPLICIT session ids one list request may name.
 *
 * Its own constant, pinned at the value it has always had, because it answers a
 * different question from the one above. `MAX_LIST_LIMIT` bounds a PAGE — how
 * many rows the reader asked to see — and now moves with the rows-per-page
 * ladder. This bounds an id list a caller supplies directly, which no ladder
 * rung has any bearing on.
 *
 * They were one constant, so raising the page ceiling to 500 silently widened
 * this too. That is the same conflation this ticket exists to remove, pointed
 * the other way: a cap and an offer that share a number drift the moment either
 * one moves for its own reasons. Nothing about a 500-row page implies a caller
 * may name 500 ids, and pinning it here means the next rung added to the ladder
 * cannot widen this bound without someone deciding to.
 *
 * 500 would in fact have been safe on the read itself — `loadSyncedSessions`
 * chunks unconditionally at `SYNCED_SESSION_HYDRATE_MAX_CHUNK_IDS` (200), and
 * the list/analytics fallback already hands it a 5,000-id hydration window — so
 * this is not a safety bound. It is a scope bound, and it stays where it was.
 */
export const MAX_LIST_IDS = 100;

export function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIST_LIMIT);
}

export function clampOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(Math.floor(value), 0);
}
