/**
 * @file session-date-field.ts
 * @description WHICH `session_detail` timestamp a Sessions date range is
 * measured against for the Sessions list and its metrics.
 *
 * Kept separate from `query-builder.ts` so consumers can name the window
 * without importing its Prisma facet-predicate graph.
 */

// FEA-4298: the single date field the whole Sessions SURFACE windows on — the
// table/list AND the summary cards above it. For a given date range these are
// ONE cohort (the cards summarize exactly the population the table lists), so
// both must window on the same timestamp column with the same null-handling, or
// the cards reconcile against a different set than the table shows. The list is
// ordered by `lastActivityAt` and windows on it (FEA-2180: "active in this
// window", with the null-safe fallback to `sessionStartedAt` in
// `applyDateFilter`), so the summary read is pinned to the SAME field here
// rather than a session-start basis. Both `findSessions` (table) and
// `getUsageSummary` (cards) pass this constant to
// `buildWhere`, so the two cohorts cannot silently drift onto different columns.
export const SESSIONS_SURFACE_DATE_FIELD = "lastActivityAt" as const;
