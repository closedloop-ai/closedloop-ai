/** Wall-clock server time for one `/agent-sessions/usage` summary read. */
export const SESSIONS_DASHBOARD_QUERY_LATENCY_METRIC =
  "agent_sessions.dashboard.query_latency" as const;

/**
 * ISS-7705: the LOC/$ coverage verdict for one summary read, with the four
 * populations that decided it (AC2).
 *
 * What a non-`complete` value MEANS: the ratio's cost denominator did not cover
 * the merged work in its numerator for that request, so the card declined to
 * state a number. It is a data-coverage signal, NOT a server fault — a request
 * that fails outright emits nothing here. `excludedSessionCount` and
 * `costBasisExcludedUsd` are what make it actionable: they say HOW MUCH of the
 * numerator's cohort the divisor missed, which is the size of the inflation the
 * gate suppressed.
 *
 * ONE emission per summary read, never one per session.
 *
 * NOT YET ALERTABLE — see this module's header.
 */
export const SESSIONS_LOC_PER_DOLLAR_COVERAGE_METRIC =
  "agent_sessions.dashboard.loc_per_dollar_coverage" as const;

/**
 * ISS-7422: wall-clock server time for the PRIOR-PERIOD half of one summary
 * read, isolated from {@link SESSIONS_DASHBOARD_QUERY_LATENCY_METRIC}.
 *
 * The whole-read metric cannot answer the question this ticket asks. The
 * comparison is one optional field on a payload that also carries eight
 * aggregates, a keyset delivery pager and the facet reads, so a summary that got
 * slower says nothing about whether the comparison is what got slower — and the
 * comparison is the half the reader watches change. Emitted only when the prior
 * read SUCCEEDED: a rejected read already reaches the monitored path as
 * `log.error`, and folding its duration in here would describe a failure as a
 * latency sample.
 *
 * THROTTLED, per `apps/api/AGENTS.md` ("Emission and Abuse Control") — at most
 * one sample per (org, viewer scope) per window, because an authenticated caller
 * polling this read would otherwise drive one emission per request without
 * limit. Suppressed reads are not lost, but they arrive as a COUNT: a row
 * carrying `aggregated: true` and `occurrences` has no `value`, and a latency
 * query must exclude it. Read `value` as a periodic sample of the distribution,
 * never as a request-weighted census — `usageComparisonLatencyThrottle` in
 * `usage-comparison.ts` states what that costs and why it is still enough.
 *
 * NOT YET ALERTABLE — see this module's header.
 */
export const SESSIONS_USAGE_COMPARISON_LATENCY_METRIC =
  "agent_sessions.dashboard.comparison_latency" as const;

/**
 * The budget the emission above is graded against, published ON every sample as
 * `budgetMs` so the threshold lives in this repo beside the code that has to
 * meet it, rather than only in an out-of-repo monitor definition that can drift
 * from it silently.
 *
 * Provenance, so a later reader can retune it rather than guess at it: the prior
 * read is two DB round trips on the common path (`sessionDetail.aggregate` plus
 * the grouped cost snapshot), against the ~84 `postgresql.query` spans ISS-7655
 * measured across the whole route. This is therefore an ALERT ceiling — the
 * point past which the comparison has become the summary's critical path rather
 * than a small concurrent addition to it — and not a target. Tune it down from
 * the distribution this metric now produces.
 */
export const SESSIONS_USAGE_COMPARISON_LATENCY_BUDGET_MS = 1500;
