import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../../src/main/agent-sync/session-date-window.js";
import type { SanitizedQuery } from "../../src/main/session/shared-agent-sessions-query.js";

/**
 * ISS-6270: the neutral `SanitizedQuery` the Sessions sort suites drive
 * `sortSyncedSessions` with — every filter cleared so the sort column under
 * test is the only thing ordering the result.
 *
 * Extracted here because the literal was being hand-copied per suite: two
 * pre-existing sort suites carry their own copy, and this change would have
 * made a third. A fixture that is re-typed per file drifts field-by-field, and
 * a stale copy silently changes what a sort test is actually sorting — the
 * repo rule is to extract a nontrivial fixture once it appears in more than
 * one file (root `AGENTS.md`, "TypeScript, Contracts, and Shared Code").
 *
 * The two older copies are deliberately left in place; converting suites this
 * change does not otherwise touch is out of its scope.
 *
 * NOT cast (wongk, #5111). The declared `SanitizedQuery` return type is the
 * whole contract this fixture exists to hold: an `as unknown as` would let a
 * field added to the sanitized shape go missing here, and every suite driven by
 * this helper would then sort a query the production sanitizer could never
 * produce — silently, since the cast keeps `tsc` quiet.
 */
export function sessionSortQuery(
  sortBy: string,
  sortDir: "asc" | "desc"
): SanitizedQuery {
  return {
    startDate: null,
    endDate: null,
    dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
    completedAfter: null,
    harness: null,
    status: null,
    statuses: [],
    userId: null,
    userIds: [],
    repositories: [],
    harnesses: [],
    models: [],
    autonomyTiers: [],
    costBuckets: [],
    changePresence: [],
    prAssociation: [],
    quality: "all",
    search: null,
    countOnly: false,
    limit: 50,
    offset: 0,
    sortBy,
    sortDir,
    hasUnsupportedCloudFilter: false,
    scopeUnsatisfiable: false,
  };
}
