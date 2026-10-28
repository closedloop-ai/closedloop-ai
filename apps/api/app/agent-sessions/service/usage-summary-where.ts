import type { Prisma } from "@repo/database";
import { buildWhere } from "./query-builder";
import type { SessionUsageInput } from "./records";

/**
 * The `where` the Sessions usage SUMMARY aggregates over, so the cards paint
 * exactly the population the TABLE does — including under a cost-bucket filter.
 *
 * ISS-7176 COLLAPSED THIS FILE. It used to be two functions and a candidate
 * scan, because the table applied a cost bucket to a RECONCILED per-event cost
 * while `buildCostBucketWhere` predicates on the stored
 * `session_detail.estimated_cost`. The summary could not restate the DB
 * predicate without disagreeing with the table, so it re-resolved the table's
 * matched id set and ANDed `artifactId IN (...)` onto the base `where` — which
 * dragged along the 10,000-session candidate cap, and with it the ISS-5283
 * problem that the per-facet counts ran a SECOND capped scan truncating a
 * DIFFERENT tail, so a facet could advertise fewer sessions than the cards
 * already showed for the same selection.
 *
 * All of that existed to reconcile two cost numbers. There is one now: the
 * whole-session cost IS `session_detail.estimated_cost` (ISS-7176 v3), which is
 * what `buildCostBucketWhere` has always predicated on. So the summary restates
 * nothing, resolves no ids, and scans no candidates — the cost bucket is an
 * ordinary conjunct in the same `where` every other facet lands in, and table
 * and cards agree by construction rather than by matching two cohorts.
 *
 * The date window defaults to `lastActivityAt` — the SAME field `findSessions`
 * and the summary/export use (ISS-4429). The analytics read passes
 * `sessionStartedAt` instead (a session belongs to the period it started in),
 * which is its own date semantics over the identical predicate set.
 */
export function buildUsageSummaryWhere(
  input: SessionUsageInput,
  dateField: "sessionStartedAt" | "lastActivityAt" = "lastActivityAt"
): Promise<Prisma.SessionDetailWhereInput> {
  return buildWhere(input, input.filters, dateField);
}
