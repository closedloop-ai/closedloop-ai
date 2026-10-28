/**
 * Timing for the trace-comments live read.
 *
 * Updates are pushed through the comment event stream (`comments:{org}:{artifact}`,
 * see `use-trace-comments-live-updates.ts`); the poll here is only the fallback.
 * Operator ruling (Marisol Ashgrove, 2026-10-08, PRD-792 open question 1): comment
 * updates are pushed through the existing comment event stream, with a 30s
 * fallback poll (ISS-12275).
 */

/** The fallback poll's flat interval (PRD-792 open question 1 ruling above). */
export const TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS = 30_000;

/**
 * Deadline for ONE live read (ISS-5110), passed to the transport as the shared
 * API client's per-call `timeoutMs` override.
 *
 * It must stay SHORTER than `TRACE_COMMENT_DELETE_TOMBSTONE_TTL_MS` /
 * `TRACE_COMMENT_CREATE_MARKER_TTL_MS`, which are derived from it in
 * `trace-comments-merge.ts`: a read that outlives those windows can land after
 * its own tombstone expired and resurrect a deleted comment, and bounding the
 * read below the TTL removes that race instead of relying on it losing.
 *
 * A read slower than this FAILS rather than arriving late. It is not retried
 * (`shouldRetryQuery` never retries a client timeout); the next signal or
 * fallback poll is the recovery path.
 */
export const TRACE_COMMENTS_READ_TIMEOUT_MS = 4000;
