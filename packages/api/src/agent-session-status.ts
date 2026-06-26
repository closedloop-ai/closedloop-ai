// Canonical agent status-classification vocabulary, shared so the web analytics
// (apps/api) and the desktop session pipeline + workflow dashboard
// (apps/desktop/src/main/shared-agent-sessions-api.ts and
// apps/desktop/src/main/database/sqlite.ts) classify agent success/failure
// identically. These substring terms are the single source of truth: the
// in-memory regexes below — and any SQL `LIKE` / Prisma `contains` predicates
// that surfaces build from them — are all derived from these terms, so the
// classification cannot drift across surfaces. Consume these rather than
// redefining the patterns locally.
//
// Substring matching is intentional: "complete" matches "completed" and "fail"
// matches "failed", so the minimal term set below is equivalent to the longer
// success|complete|completed|done / error|fail|failed forms.
export const AGENT_SUCCESS_STATUS_TERMS = ["success", "complete", "done"];
export const AGENT_FAILED_STATUS_TERMS = ["error", "fail"];

export const AGENT_SUCCESS_STATUS_PATTERN = new RegExp(
  AGENT_SUCCESS_STATUS_TERMS.join("|"),
  "i"
);
export const AGENT_FAILED_STATUS_PATTERN = new RegExp(
  AGENT_FAILED_STATUS_TERMS.join("|"),
  "i"
);
