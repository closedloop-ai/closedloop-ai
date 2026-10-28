/**
 * @file transcript-sync-error-reason.ts
 * @description The transcript sync lane's backend-only failure vocabulary, and
 * nothing else.
 *
 * Extracted from `service.ts` (ISS-7097) because it is a CONTRACT the routes and
 * `transcript-route-helpers.ts` consume, not an implementation detail of the
 * service: the helper mapping reasons to HTTP responses had to import from the
 * service it is downstream of, and every route test that mocks `../service` had
 * to hand-copy these literals to keep that import satisfied — the SSOT-drift-by-
 * copy shape this repo bans. A leaf module both sides can import removes the
 * cycle-ish dependency and the copies at once.
 */

/** Backend-only outcomes the routes map to HTTP responses. */
export const TranscriptSyncErrorReason = {
  Forbidden: "forbidden",
  RateLimited: "rate_limited",
  InvalidRequest: "invalid_request",
  /** ETag moved / checksum mismatch / unknown upload — client re-plans. */
  StaleUpload: "stale_upload",
  /**
   * ISS-7097: THIS SERVER could not answer, and nothing about the caller's
   * request is wrong — a transaction timeout, the object store being
   * unreachable, an unexpected throw. Distinct from {@link StaleUpload}, which
   * these used to be folded into: a 409 tells the desktop its own state is
   * stale, and the desktop answers that by burning one of five per-row retry
   * attempts toward a `retries_exhausted` skip the cloud then believes. A cloud
   * outage would march every healthy transcript to that terminal state.
   *
   * Mapped to a 503 so the discriminator is the STATUS CODE: the desktop client
   * throws before reading the response body, so a reason string in the payload
   * would never be seen at the call site that has to make the decision.
   */
  UpstreamUnavailable: "upstream_unavailable",
  /**
   * ISS-8689 / PRD-699 Appendix A: same 503 family as {@link
   * UpstreamUnavailable} — the caller's request is not at fault — but here the
   * cause is `TRANSCRIPTS_BUCKET` being unset rather than a transient outage.
   * Only an admin fixing the configuration resolves it, so the client is told
   * to wait far longer than a transient-outage retry before trying again.
   */
  UpstreamNotConfigured: "upstream_not_configured",
} as const;
export type TranscriptSyncErrorReason =
  (typeof TranscriptSyncErrorReason)[keyof typeof TranscriptSyncErrorReason];
