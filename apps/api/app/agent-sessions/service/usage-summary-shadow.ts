/**
 * ISS-8554 / PLN-1853 D6 — the shadow comparison.
 *
 * When the gate is open this runs the TypedSQL candidate ALONGSIDE the live
 * summary, diffs the two, and logs the verdict. The live response is returned
 * untouched either way.
 *
 * WHY SHADOW RATHER THAN SUBSTITUTION. §11 lists decisions that move published
 * numbers on purpose, and O1 (ISS-8557) is still open with the merged-PR
 * population currently a superset. There is no honest way to serve the candidate
 * before a differ has run against real data, and no way to run it against real
 * data without serving something — shadowing is the way out of that circle. The
 * cutover is a separate, later change, gated on the reports this produces.
 *
 * THREE PROPERTIES THIS MUST HAVE, and each is a way shadowing usually goes
 * wrong:
 *
 *   1. It cannot change the response. The caller gets the live summary it
 *      already had; this function resolves to nothing, and the promise it
 *      returns exists for `waitUntil`, never to hand a value back.
 *   2. It cannot fail the request. The candidate runs behind a catch, and a
 *      throw is logged and swallowed. A read path that nothing consumes must
 *      never be able to 500 a page.
 *   3. It cannot slow the response. The route hands the returned promise to
 *      `waitUntil` rather than awaiting it, so the reader never waits while the
 *      instance still stays alive for the comparison — see
 *      {@link shadowUsageSummary} on why that is safe here and
 *      what it costs.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import type { SessionUsageInput } from "./records";
import {
  diffUsageSummary,
  type FieldDiff,
  summarizeDiff,
} from "./usage-summary-differ";
import {
  buildUsageSummaryFromSql,
  SQL_COMPOSED_SUMMARY_FIELDS,
} from "./usage-summary-sql";

/** Structured-log event for a completed comparison. */
export const USAGE_SQL_SHADOW_EVENT = "sessions_usage_typed_sql_shadow";
/** Structured-log event for a candidate that threw. */
export const USAGE_SQL_SHADOW_FAILED_EVENT =
  "sessions_usage_typed_sql_shadow_failed";

/**
 * How many differing fields are named in one log line.
 *
 * A capped list is a REPORTING limit, not a measured one: the counts in the same
 * line are whole, and this only bounds the names. Without it a broadly divergent
 * response would emit a log entry proportional to the contract's width, which is
 * the sort of thing that turns a diagnostic into an incident.
 */
export const SHADOW_REPORTED_FIELD_CAP = 12;

function nameFields(diffs: readonly FieldDiff[]): string[] {
  return diffs.slice(0, SHADOW_REPORTED_FIELD_CAP).map((diff) => diff.field);
}

/**
 * Run the candidate, diff it against the live summary, and log the verdict.
 *
 * RETURNS ITS PROMISE so the route can hand it to `waitUntil`. The reader still
 * does not wait -- `waitUntil` settles after the response is flushed -- but the
 * instance is kept alive until the comparison finishes.
 *
 * Fire-and-forget was worse than a lost log line, and the reason is the SAMPLE
 * rather than the volume. A frozen instance drops the comparisons still running,
 * i.e. the SLOWEST ones, and slow is exactly what a candidate doing something
 * wrong looks like -- a predicate that fell off an index, a cohort array that
 * got huge. The surviving diffs would then be the fast runs, and that biased
 * set is what the flag decision would have been read from
 * (marisolashgrove on #6281; apps/api/AGENTS.md forbids fire-and-forget for
 * response-path side effects).
 *
 * The `.catch()` stays INSIDE, so the returned promise never rejects and
 * `waitUntil` cannot fail the request.
 *
 * `live` is passed in rather than re-read, so the comparison describes the exact
 * response the caller received rather than a second read of a moving population.
 */
export function shadowUsageSummary(
  input: SessionUsageInput,
  live: AgentSessionUsageSummary
): Promise<void> {
  const startedAtMs = Date.now();
  // ISS-10867: the live summary already finished resolving its prior window
  // by the time this runs — `resolvePriorUsageWindow` reads `now()`, and this
  // build starts strictly after the live one returned, so re-resolving here
  // would compare two independently-timed reads of a rolling window instead of
  // the same window twice. Handing over the window live already published
  // makes the comparison describe the candidate's AGGREGATION, which is the
  // one thing this diagnostic exists to test — not the gap between two clocks.
  //
  // `null` rather than `undefined` when live carried no comparison: live's
  // answer is authoritative either way, and `undefined` would send the
  // candidate back to `now()` for the one case that is still clock-dependent
  // (whitlockk on #7751) — see {@link buildUsageSummaryFromSql}.
  //
  // WHAT THIS COSTS THE REPORT, stated because the differ promises not to score
  // a field it did not compare: `comparison.priorStartDate`/`priorEndDate` now
  // match BY CONSTRUCTION and still count toward `matchedCount`. Read them as
  // "not compared", never as evidence the candidate resolves a window
  // correctly (tamsinb on #7751).
  const priorWindowOverride = live.comparison
    ? {
        startDate: live.comparison.priorStartDate,
        endDate: live.comparison.priorEndDate,
      }
    : null;
  // Returned, not floated: the caller passes this to `waitUntil`. The chain
  // still terminates in `.catch()` below, so it never rejects and can neither
  // delay nor fail the live response.
  return buildUsageSummaryFromSql(input, priorWindowOverride)
    .then((candidate) => {
      const report = diffUsageSummary(
        live,
        candidate,
        SQL_COMPOSED_SUMMARY_FIELDS
      );
      const { clean, line } = summarizeDiff(report);
      log.info(USAGE_SQL_SHADOW_EVENT, {
        clean,
        summary: line,
        durationMs: Date.now() - startedAtMs,
        matchedCount: report.matchedCount,
        defectCount: report.defects.length,
        expectedCount: report.expected.length,
        notComparedCount: report.notCompared.length,
        // Names only. Values can carry a session's repository, model, or owner
        // email through the facet arrays, and a diagnostic log is the wrong
        // place for any of it.
        defectFields: nameFields(report.defects),
        expectedFields: nameFields(report.expected),
        notComparedFields: nameFields(report.notCompared),
      });
    })
    .catch((error: unknown) => {
      // ISS-10753 removed the capped-cohort refusal this used to also handle —
      // every facet is an ordinary SQL predicate now, so anything reaching
      // here is a genuine failure: a statement error, a connection that
      // cannot be acquired, a projection meeting a shape it does not know.
      log.warn(USAGE_SQL_SHADOW_FAILED_EVENT, {
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : String(error),
      });
    });
}
