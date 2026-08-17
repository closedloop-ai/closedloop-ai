// What counts as a TERMINAL check failure in the merge queue (ISS-5141).
//
// Deliberately its own module, with no `server-only` and no Octokit import, for
// two reasons. It is imported by the stall cron's pure derivation, which should
// not drag a server-only GitHub client in behind it; and it is imported by the
// drift guard that compares these sets against the jq literals in
// `.github/workflows/merge-queue-metrics.yml`, which runs as an ordinary script
// test. Splitting the constants out is what lets both consumers import the SAME
// symbols instead of re-declaring the members and pinning a value the poller no
// longer uses.
//
// ## Why the stall signal and the ejection emitter must agree
//
// `merge-queue-metrics.yml` reports a PR as EJECTED from the queue on these
// states; the stall cron counts a merge group as RED on them. They describe the
// same event from two ends. If they ever disagreed, one of them would be lying:
// a group counted as red that never ejects, or an ejection the stall signal
// never saw coming. `merge-queue-failure-classification-drift.test.ts` enforces
// the agreement.
//
// `cancelled` is deliberately absent from both. GitHub cancels sibling runs as a
// CONSEQUENCE of a group being dropped, so counting it would report the
// aftermath of an ejection that has already happened.
//
// `action_required` is also absent from both, and that is a known gap rather
// than a decision: it is a completed, blocking conclusion. It is excluded here
// only to preserve parity with the ejection emitter, which does not count it
// either — closing the gap means changing both sides together.

/** Terminal `CheckRun.conclusion` values, in the GraphQL enum's casing. */
export const TERMINAL_CHECK_CONCLUSIONS = [
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "STALE",
] as const;
export type TerminalCheckConclusion =
  (typeof TERMINAL_CHECK_CONCLUSIONS)[number];

/** Terminal `StatusContext.state` values, in the GraphQL enum's casing. */
export const TERMINAL_STATUS_STATES = ["FAILURE", "ERROR"] as const;
export type TerminalStatusState = (typeof TERMINAL_STATUS_STATES)[number];
