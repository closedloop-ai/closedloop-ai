/**
 * @file db-constants.ts
 * @description Shared runtime constants for the desktop SQLite store — the
 * status vocabularies, SQL status-set fragments, paging limits, and classifier
 * regexes used across the store's read/write/analytics paths. Extracted verbatim
 * from `sqlite.ts` so the domain modules carved out of that monolith share one
 * canonical definition rather than re-declaring them.
 */

import { BRANCH_PUSH_METHOD_VALUES as SHARED_BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";

/**
 * Desktop-local session/agent status model for the embedded sqlite store. This
 * is intentionally DISTINCT from the cloud `SESSION_STATUS` in
 * `@closedloop-ai/loops-api/session-status`: the desktop store tracks a richer,
 * live agent lifecycle (e.g. `working`/`running`) that the cloud contract does
 * not model, and it lives entirely inside this process. Keeping the consts
 * local avoids coupling the embedded schema to the cross-runtime contract.
 */
export const DESKTOP_SESSION_STATUS = {
  ACTIVE: "active",
  WAITING: "waiting",
  COMPLETED: "completed",
  ABANDONED: "abandoned",
  ERROR: "error",
} as const;
export const DESKTOP_AGENT_STATUS = {
  WORKING: "working",
  WAITING: "waiting",
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

export const TERMINAL_STATUSES = `('${DESKTOP_SESSION_STATUS.COMPLETED}', '${DESKTOP_SESSION_STATUS.ABANDONED}', '${DESKTOP_SESSION_STATUS.ERROR}')`;
export const TERMINAL_STATUS_SET = new Set<string>([
  DESKTOP_SESSION_STATUS.COMPLETED,
  DESKTOP_SESSION_STATUS.ABANDONED,
  DESKTOP_SESSION_STATUS.ERROR,
]);
export const CLAUDE_NATIVE_SUBAGENT_STEM_PATTERN = /^agent-[A-Za-z0-9_-]+$/;
export const MAX_SESSION_PAGE_LIMIT = 100;
export const DEFAULT_SESSION_PAGE_LIMIT = 25;
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
 * non-constant list. Shared by the FEA-2531 method-value fragments and
 * `defaultBranchSqlList` (PR #2320 review: one quoting helper, not two).
 */
export function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}
