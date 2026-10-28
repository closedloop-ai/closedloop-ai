/**
 * The clamp-style page-bound policy — parse leniently, then bound both ends
 * and serve the nearest legal page — in a home BOTH producers of a paged read
 * can import. ISS-9857 hoisted it out of `apps/api/lib/validators/pagination.ts`
 * because the desktop's IPC twin of the session-events page cannot import
 * `apps/api`; `pageBoundValidator` stays there, being Zod and API-only.
 *
 * It is not the only page-bound policy on the API, and adopting it is a choice:
 * `projects/[id]/tree` deliberately does NOT use it, because it REJECTS a
 * malformed bound rather than clamping it, and parses integers only.
 */

/** The page-size bounds a surface enforces, in that surface's own constants. */
export type PageLimitBounds = {
  /** Rows per page when the caller does not ask. */
  defaultLimit: number;
  /** Hard ceiling on rows per page. */
  maxLimit: number;
};

/**
 * Bring a caller-supplied page size inside a surface's bounds.
 *
 * Load-bearing rather than defensive. Clerk answers an out-of-range limit with
 * HTTP 200 and its own default page instead of an error, so an unclamped value
 * does not fail loudly — it returns a short page that reads as the complete set.
 *
 * Rejects the whole impossible set, not just the two that are easy to picture:
 * a fractional page size floors, a non-finite one falls back to the default,
 * and both ends are bounded. `Math.min` alone would let a negative through.
 */
export function clampPageLimit(
  raw: number | undefined,
  bounds: PageLimitBounds
): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return bounds.defaultLimit;
  }
  return Math.min(Math.max(1, Math.floor(raw)), bounds.maxLimit);
}
