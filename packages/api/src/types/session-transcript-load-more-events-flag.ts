/**
 * ISS-9857 — the shared web+desktop UI flag key for the session transcript
 * panel's "Load more events" control, the affordance that walks past the
 * detail read's 10,000-event prefix through the paged events read.
 *
 * Its own leaf module, dependency-free, for the reason the sibling flag leaves
 * are: the `packages/app` alias and any surface that gates on it import this
 * constant, and none may pull another's transitive graph in to get it. One
 * constant, one PostHog key, both shells — the desktop resolves the signed-in
 * account's PostHog assignment from the same key space `apps/app` reads.
 */
export const SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY =
  "session-transcript-load-more-events" as const;
