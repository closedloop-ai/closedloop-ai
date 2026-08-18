/**
 * The AI-spend KPI's null-on-zero rule, shared by every producer of the ONE
 * Branches "AI spend" summary card so they cannot re-diverge:
 *
 * - web server — apps/api/app/branches/branch-read-service.ts (`getBranchAnalytics`)
 * - desktop    — apps/desktop/src/main/branch/branch-analytics-projection.ts
 *   (`projectBranchAnalytics`)
 * - client     — packages/app/branches/lib/filtered-branch-analytics.ts, which
 *   re-derives the card over the table's visible/filtered rows and therefore
 *   OVERRIDES whatever either server producer computed
 *
 * ISS-4737: these three hand-maintained copies had drifted. The web server
 * mapped a zero total to null ("no usable figure"), while the desktop producer
 * and the client re-projection keyed availability on whether ANY priced session
 * contributed — so a subset whose priced sessions summed to exactly zero
 * rendered `$0` on the card, asserting "you spent nothing" when the truth was
 * "we have no spend figure for this set". This is the single implementation all
 * three now call.
 *
 * Lives in `@repo/lib` — React-free and Node-free, the same home as the sibling
 * `loc-per-dollar` denominator kernel every branch-analytics producer already
 * imports.
 */

/**
 * The spend figure the AI-spend KPI may report, or `null` when there is none.
 *
 * A total is reportable only when it is a finite, strictly positive amount.
 * Everything else — an absent total (nothing priced), an exact zero (priced, but
 * summing to nothing), and a non-finite total (a corrupt upstream figure) —
 * collapses to `null`, which the card renders as its "No data" state rather than
 * a `$0` that would claim the work was free.
 *
 * NOT the rule everywhere in the product. The Sessions summary's Cost tile
 * (`packages/app/agents/components/sessions/cost-metric-card.tsx`) deliberately
 * renders an exact `$0` as a real value, and that is correct there: it reports
 * NON-SUBSCRIPTION spend over a set of sessions the user selected, so a zero is
 * the informative answer "these cost you nothing extra" rather than a missing
 * figure. This rule is scoped to the Branches AI-spend card, where a zero total
 * over a filtered branch set means nothing priced into it — the difference is
 * intentional, not drift.
 *
 * Zero and absent deliberately share one KPI state: the wire `BranchKpi` carries
 * only `available | gated | unavailable`, so there is no third state to tell
 * "nothing priced" from "priced to zero" apart, and both are equally unusable as
 * a spend figure. Callers that need the distinction keep it upstream (the
 * client re-projection still holds its per-session cost map) — it is only the
 * rendered KPI that collapses them.
 */
export function reportableSpendUsd(
  totalSpendUsd: number | null | undefined
): number | null {
  if (totalSpendUsd == null || !Number.isFinite(totalSpendUsd)) {
    return null;
  }
  return totalSpendUsd > 0 ? totalSpendUsd : null;
}

/**
 * Whether a spend total is CORRUPT rather than merely unreportable — a value no
 * correct producer can emit: negative, `NaN`, or infinite.
 *
 * {@link reportableSpendUsd} collapses these to the same `null` a legitimate
 * no-data corpus produces, which is the right RENDER (never a fabricated figure,
 * never a `NaN`/`-$5` on the card) but would otherwise erase the anomaly:
 * corrupt persisted cost or a broken pricing table would be indistinguishable
 * from an unpriced corpus, with no signal to diagnose it (chatgpt-codex, #4244).
 * So the two questions are answered by two functions — this one says "was the
 * input impossible", `reportableSpendUsd` says "what may we render" — and each
 * NODE-side producer routes a `true` here to its runtime's existing diagnostic
 * sink before rendering the graceful `null`:
 *
 * - web server — `apps/api/app/branches/branch-analytics-kpis.ts` emits
 *   `log.warn` via `@repo/observability/log`, the Datadog-exported logger.
 * - desktop main — `apps/desktop/src/main/branch/shared-branches-api.ts` emits
 *   `writePersistentLog("warn", …)`, the main-process diagnostic log.
 *
 * The CLIENT re-projection (`packages/app/branches/lib/filtered-branch-analytics.ts`)
 * deliberately does NOT report: it is browser code, where the repo's
 * `no-client-debug-logging` gate bans logging outright, and its input is the
 * per-session cost map the server already validated on the way out.
 *
 * `null`/`undefined` (nothing priced) and an exact `0` (priced, sums to nothing)
 * are NOT anomalies — they are ordinary states this KPI has no room to
 * distinguish, so they return `false` and stay silent.
 */
export function isAnomalousSpendTotal(
  totalSpendUsd: number | null | undefined
): boolean {
  if (totalSpendUsd == null) {
    return false;
  }
  return !Number.isFinite(totalSpendUsd) || totalSpendUsd < 0;
}
