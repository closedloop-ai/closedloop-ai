// What counts as a TERMINAL check failure in the merge queue (ISS-5141).
//
// Deliberately its own module, with no `server-only` and no Octokit import, for
// two reasons. It is imported by the stall cron's pure derivation, which should
// not drag a server-only GitHub client in behind it; and it is imported by the
// drift guard that compares these sets against the jq literals in
// `.github/workflows/merge-queue-metrics.yml` and
// `.github/workflows/merge-queue-thrash-guard.yml`'s ETA step, which runs as an ordinary script
// test. Splitting the constants out is what lets both consumers import the SAME
// symbols instead of re-declaring the members and pinning a value the poller no
// longer uses.
//
// ## Where the stall signal and the ejection emitter agree, and where they do not
//
// `merge-queue-metrics.yml` reports a PR as EJECTED from the queue on these
// states; the stall cron counts a merge group as RED on them. On the conclusion
// words they agree: `merge-queue-failure-classification-drift.test.ts` pins the
// workflows' quoted jq `IN()` sets to these constants (ISS-11565 restored it
// after ISS-10525 deleted it).
//
// They disagree on purpose about one case (ISS-10837). A required context killed
// at its `timeout-minutes` cap, or one no runner acquired, concludes
// `cancelled`, and only its check-run annotation says which. The ejection
// emitter reads that annotation and counts the ejection (#7884's
// `api-integration-tests` timed out; #8380's `desktop-version-guard` never got
// a runner — Perrin Upcott, 2026-10-06). The stall side reads the conclusion
// alone, which cannot tell either case from any other cancel, so
// `required-context-streak.ts` leaves it `Ignored` and `FAILING_CONCLUSIONS` in
// `merge-queue-thrash-policy.ts` does not name it. The drift test cannot see
// the emitter's clause, which is not a quoted `IN()`.
//
// `cancelled` itself is absent from both sets. GitHub cancels sibling runs as a
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
