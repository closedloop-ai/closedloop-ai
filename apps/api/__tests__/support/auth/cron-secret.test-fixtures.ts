/**
 * Module-scoped support for the two `validateCronSecret` suites — the rejection
 * half (`lib/auth/__tests__/cron-secret.test.ts`) and the acceptance half
 * (`lib/auth/__tests__/cron-invocation-accepted.test.ts`).
 *
 * The monitored ACCEPTANCE event name is deliberately not here: `cron-secret.ts`
 * owns `CRON_INVOCATION_ACCEPTED_EVENT`, and a second spelling of it would leave
 * two owners for a string a Datadog monitor outside this repo matches on. The
 * rename-safety this file used to buy for it is bought instead by the dedicated
 * monitor-contract check in the acceptance suite, which pins the exported
 * constant's VALUE.
 */

// Still pinned rather than imported, and still for the reason above: the
// rejection event predates ISS-9824 and its literal remains private to
// `cron-secret.ts`, so there is no exported owner to import. Folding it into
// the same single-owner shape belongs to the rejection half's own change.
export const CRON_SECRET_REJECTED_EVENT = "cron_secret_rejected";

export const CRON_TEST_LOG_TAG = "[unit-test]";
export const CRON_TEST_OTHER_LOG_TAG = "[unit-test-other-route]";
export const CRON_TEST_SECRET = "correct-horse-battery-staple";

export function makeCronRequest(authHeader?: string): Request {
  return new Request("http://localhost/cron/whatever", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}
