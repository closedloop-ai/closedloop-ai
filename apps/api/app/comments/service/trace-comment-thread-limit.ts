/**
 * The most trace-comment threads any single target's read will return, and
 * therefore the most the session DETAIL rail can ever render for one session.
 *
 * Extracted from `service.ts` (PR #5900) so the Sessions LIST count
 * (`apps/api/app/agent-sessions/service/list-comment-counts.ts`) and the rail's
 * own `readTraceCommentPage` bound derive from ONE constant instead of two copies
 * of the same number. The list tag claims to be the rail's count, so a bound
 * only one of them honored would let a session say "201" on the list and "200"
 * in the rail — the same record telling two stories.
 *
 * Its own module rather than an import of `service.ts`: that service reaches
 * into branches, compute targets, and the collaboration package, none of which
 * the sessions-list read has any business loading to learn a number.
 */
export const TRACE_COMMENT_TARGET_THREAD_LIMIT = 200;
