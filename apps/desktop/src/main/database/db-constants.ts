/**
 * @file db-constants.ts
 * @description Shared runtime constants for the desktop SQLite store — the
 * status vocabularies, SQL status-set fragments, paging limits, and classifier
 * regexes used across the store's read/write/analytics paths. Extracted verbatim
 * from `sqlite.ts` so the domain modules carved out of that monolith share one
 * canonical definition rather than re-declaring them.
 */

import { BRANCH_PUSH_METHOD_VALUES as SHARED_BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";

/**
 * ISS-5592 step 2 RETIRED `DESKTOP_SESSION_STATUS`. The desktop-local object had
 * converged on exactly the three canonical lifecycle values, so it was the same
 * value set declared twice — every migration on this axis had to land in both.
 * The canonical `SESSION_STATUS` (`@repo/api/src/types/session-status`) is now
 * the only declaration, and this store writes those values directly.
 *
 * What did NOT change: this app may still only WRITE the three lifecycle values.
 * The cloud vocabulary is wider on the READ side — `DISPLAYED_SESSION_STATUS`
 * adds `waiting`, `unknown`, and `stale`, which are display-time derivations
 * with no desktop column. Never persist one of those into SQLite; importing the
 * lifecycle set rather than the displayed set is what keeps that impossible.
 *
 * A local row CAN still store a literal `waiting`: migration
 * `0042_iss4586_session_status_ends_with_error` collapsed only
 * `completed`/`abandoned` and says so in its own text. ISS-10629 deleted the two
 * reads this paragraph used to name — the `DISPLAYED_SESSION_STATUS.WAITING` arm
 * in `../session/session-status-filter-match.ts` and the raw `'waiting'` union in
 * `session-aggregate-filters.ts` — so such a row is now reached only by the
 * stored-status equality at the bottom of each, and not even that if it is also
 * awaiting input. ISS-10364 (operator ruling, 2026-09-23/24) retired the Waiting
 * display word outright, so such a row no longer renders distinctly either — it
 * folds to Active like any other spelling this build does not treat as a
 * display word. Either way, not through this module.
 *
 * `DESKTOP_AGENT_STATUS` below is a DIFFERENT axis (per-agent, not per-session)
 * and keeps its own `waiting`. See the "Session State" section of the root
 * `AGENTS.md`.
 */
export const DESKTOP_AGENT_STATUS = {
  WORKING: "working",
  WAITING: "waiting",
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

// ISS-4586 / ISS-4654: the terminal set is `inactive` + `error`. The legacy
// `completed`/`abandoned` entries are gone: migration
// `0042_iss4586_session_status_ends_with_error` collapsed every local row to
// `inactive`, and it runs at boot — so any store this code executes against has
// already been collapsed and no row can carry the retired spellings.
export const TERMINAL_STATUSES = `('${SESSION_STATUS.INACTIVE}', '${SESSION_STATUS.ERROR}')`;
export const TERMINAL_STATUS_SET = new Set<string>([
  SESSION_STATUS.INACTIVE,
  SESSION_STATUS.ERROR,
]);
export const CLAUDE_NATIVE_SUBAGENT_STEM_PATTERN = /^agent-[A-Za-z0-9_-]+$/;
export const MAX_SESSION_PAGE_LIMIT = 100;
export const DEFAULT_SESSION_PAGE_LIMIT = 25;
// ISS-5631: the dashboard plan read's page size — BOTH the default and the hard
// ceiling, so no caller can widen it back to the whole corpus. A plan row carries
// its FULL markdown `content`, so an uncapped `getPlans` shipped every plan's text
// across the IPC boundary in one array. 100 matches the default of its paginated
// sibling `listPlans` (`desktop:db:get-plans-list`). This caps the RESPONSE, not
// the db-host's transient materialization — see the note on `getPlans`.
export const MAX_DASHBOARD_PLAN_PAGE_LIMIT = 100;
// ISS-6451: the dashboard pull-request read's page size — BOTH the default and
// the hard ceiling, mirroring `MAX_DASHBOARD_PLAN_PAGE_LIMIT` above. It was the
// last unwindowed full-corpus row read in `dashboard-queries.ts`: every
// `kind='pull_request'` artifact, wide rows and all (title, url,
// session_name), sorted in JS and shipped across the IPC boundary in one array,
// through EITHER of two entry points that both reach it — the `getCoreFeatures`
// bundle and the standalone `desktop:db:get-pull-requests` channel. (How many
// times one screen actually fires them is not answerable from this repo: the
// only consumer is the commit-pinned `agent-dashboard` sidecar, which is not
// checked in.) Like the plan cap this bounds the RESPONSE and the JS fold, NOT
// the db-host's transient materialization — see the note on `getPullRequests`
// for what the query still has to rank and sort.
export const MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT = 100;
export const COMPACTION_RE =
  /compact|compress|context.*(reduc|truncat|summar)/i;
export const WAITING_INPUT_RE =
  /needs your permission|waiting for your input|is waiting|requires approval|permission to use/i;
export const RECENT_ACTIVITY_MS = 10 * 60 * 1000;
export const MAX_EVENT_DATA_BYTES = 64 * 1024;

export const HIGH_CONFIDENCE_BRANCH_METHOD_VALUES = [
  "git_worktree_add",
  "git_checkout",
  "git_push",
  "git_commit",
  "gh_pr_create",
] as const;

// FEA-2531: write evidence — a session produced commits/pushes on the branch.
// Attribution (token even-split) follows these links only.
export const BRANCH_WRITE_METHOD_VALUES = [
  "git_push",
  "gh_pr_create",
  "git_commit",
] as const;

// FEA-2531: push evidence — the branch reached the remote. Display gate for the
// Branches surface and the trigger for artifacts.first_pushed_at. Canonical SSOT
// lives in `@repo/api` (shared with the cloud session producer, PLN-1099 Phase
// 2); surfaced here so the desktop store's SQL fragments keep one import site.
export const BRANCH_PUSH_METHOD_VALUES = SHARED_BRANCH_PUSH_METHOD_VALUES;

/**
 * Render a string list as a SQL string-literal fragment (`'a', 'b'`). Quotes
 * are escaped so the fragment stays inert even if a future caller passes a
 * non-constant list. Shared by the FEA-2531 method-value fragments.
 */
export function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

/**
 * perf: conservative cap on bound parameters per chunked multi-row INSERT in the
 * import path. SQLite/libSQL default `SQLITE_MAX_VARIABLE_NUMBER` is 999 (older)
 * / 32766 (newer); staying near ~900 keeps each statement safe on every build
 * while still collapsing thousands of per-row round-trips into a handful.
 *
 * Moved here from `write-core.ts` by FEA-4010 so `segment-work-item-stamp.ts` —
 * carved out of that file, and chunking its id lists against the same cap — can
 * share the one definition without importing back into the module that imports
 * it.
 */
export const EVENT_INSERT_PARAM_CAP = 900;

// Fixed-width UTC bounds key: unlike stored TEXT, lexicographic MIN/MAX now
// preserve instant order across offsets and fractional-second spellings.
// Unparseable values remain NULL rather than pinning a bound to 1970.
export const SESSION_STARTED_AT_BOUNDS_EXPR =
  "(CASE WHEN s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.started_at) ELSE NULL END)";

/**
 * FEA-1839: prefix for the synthetic `session_id` of a
 * `mutual_exclusivity_violation` event. A real harness session id is a bare
 * id/uuid, so this namespaced value can never collide with one — keeping the
 * diagnostic row off any real session's event stream and clear of
 * `rebuildSessionFromParse`'s per-session DELETE.
 *
 * ISS-5400: moved here from `sqlite.ts` so its writer (the maintenance facade)
 * and its readers share a neutral module — `sqlite.ts` no longer re-exports it.
 */
export const COLLECTION_VIOLATION_SESSION_PREFIX = "mutual-exclusivity:";

/**
 * ISS-10365: `<column> IN (…)` over a caller-supplied id list, bound as ONE host
 * parameter instead of one per id. A `?`-per-id list makes a statement's bind
 * count scale with the corpus and throws past `SQLITE_MAX_VARIABLE_NUMBER` — the
 * 999 floor `EVENT_INSERT_PARAM_CAP` above is set against — which on the branch
 * DETAIL reads meant a branch written by enough sessions could not be opened at
 * all. `json_each` unpacks the whole list out of a single JSON-array parameter,
 * so the statement binds a constant 1 at any width: nothing is chunked, and no
 * id is dropped.
 *
 * Pass the matching value as `JSON.stringify([...ids])`. Ids are values, never
 * SQL text, so this stays inert for any caller-supplied list.
 */
export function jsonIdListInSql(column: string): string {
  return `${column} IN (SELECT value FROM json_each(?))`;
}

/**
 * Stable key for a row's stored/worktree repository identity pair. NULL and
 * blank values collapse exactly as the stored-first resolver does; CHAR(31)
 * separates the two values so grouped resolution and SQL matching agree.
 */
export const REPOSITORY_PAIR_KEY_EXPR =
  "COALESCE(s.cwd, '') || CHAR(31) || TRIM(COALESCE(s.repo_full_name, ''))";
