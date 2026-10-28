// ---------------------------------------------------------------------------
// Which Datadog HTTP responses mean "try again".
//
// This package talks to Datadog over two independent senders — the agentless
// log intake (`log.ts` → `http-intake.logs.{site}/api/v2/logs`) and the metrics
// series submitter (`telemetry/series.ts` → `api.{site}/api/v2/series`). Both
// have to answer the same question about the same vendor's status codes, and
// each used to answer it with its own copy of the rule.
//
// One owner, because the failure mode of two is silent: a future change to
// Datadog's retry contract applied to only one copy leaves the two transports
// retrying differently, with nothing to catch the drift.
//
// Kept deliberately free of imports: `log.ts` reaches this module and is itself
// imported by client components, so anything heavy here would land in every
// client bundle.
// ---------------------------------------------------------------------------

/** Non-5xx statuses on which Datadog asks to be retried rather than refusing. */
const RETRYABLE_STATUSES = new Set([408, 429]);

/**
 * True when the status is Datadog asking for a retry rather than refusing the
 * payload. Everything else is a refusal replaying cannot fix.
 */
export function isRetryableDatadogStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}
