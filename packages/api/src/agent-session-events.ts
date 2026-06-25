// Canonical agent-session EVENT-type classification, shared so the web analytics
// (apps/api) and the desktop session pipeline
// (apps/desktop/src/main/shared-agent-sessions-api.ts) count error events
// identically. Both surfaces must treat "error", "fail", and "failure" event
// types as errors; counting only "error" makes the same session data report
// different error counts across web and desktop.
//
// ERROR_EVENT_TERMS is the single source of truth: the in-memory regex below is
// derived from it, and any SQL `LIKE` / Prisma `contains` predicate that needs
// the same classification should be built from these substring terms so the
// behavior cannot drift. Substring matching is intentional — "fail" matches
// "failure"/"failed" and "error" matches "errored".
//
// Kept separate from the agent STATUS patterns in `agent-session-status.ts`
// (those classify an agent's terminal status; these classify an individual
// event) so the two concepts can evolve independently even though they share
// terms today.
export const ERROR_EVENT_TERMS = ["error", "fail"];

export const ERROR_EVENT_PATTERN = new RegExp(ERROR_EVENT_TERMS.join("|"), "i");
