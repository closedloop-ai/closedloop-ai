import { withAppSpan } from "@repo/observability/tracing/spans";
import { readCohortCostFacts } from "./branch-cohort-cost-facts";
import { readCohortPullRequestFacts } from "./branch-cohort-pull-request-facts";
import {
  BranchListEnrichmentRead,
  reportBranchListEnrichmentFailedOpen,
} from "./branch-list-enrichment";

type MetricFacts = readonly [
  Awaited<ReturnType<typeof readCohortPullRequestFacts>>,
  Awaited<ReturnType<typeof readCohortCostFacts>>,
];

/**
 * What `settle` hands the projection: the facts, or `undefined` for each when
 * the read had no answer.
 *
 * `undefined` leaves exactly the cards that read these facts Unavailable —
 * Median PR size, Merge rate, AI spend and the LOC per $ ratios over it — and
 * leaves Active branches, Last active and LOC pushed on the evidence the
 * snapshot already produced.
 */
type SettledMetricFacts = readonly [
  MetricFacts[0] | undefined,
  MetricFacts[1] | undefined,
];

/**
 * The cohort's PR and cost facts, started the moment the cohort ids are known
 * instead of after the snapshot closes.
 *
 * The snapshot runs on one connection, so its statements queue; these reads use
 * their own, and overlap the rest of the snapshot. `.then` is attached HERE,
 * outside the snapshot, because a promise reaction runs in the async context
 * where `.then` was called: attached inside, `withDb` would join the snapshot's
 * transaction and queue behind it again.
 *
 * A retried snapshot (`readBranchListFailingOpen`) can end on a different cohort
 * or clock than the one these started on, so `settle` reuses them only for the
 * ids and instant the projection will use, and reads again otherwise.
 *
 * `settle` FAILS OPEN (H2, marisolashgrove review on #8791). These reads take their
 * own connections, outside `withBranchProductReadSnapshot` and its FullCorpus
 * budget, so a rejection here used to propagate out of `readBranchAnalytics` and
 * 500 the whole response — taking Active branches, Last active and LOC pushed
 * with it, all three already computed from the snapshot. Same contract as the
 * optional reads inside the snapshot (`apps/api/app/branches/AGENTS.md`,
 * "Enrichment must not be fatal"), recorded on the same monitored event.
 */
export function startMetricFactsOnCohort(
  organizationId: string,
  query: { startDate?: Date; endDate?: Date }
) {
  let first: { ids: readonly string[]; now: Date } | undefined;
  let provideCohort: (cohort: { ids: readonly string[]; now: Date }) => void =
    () => undefined;
  const cohort = new Promise<{ ids: readonly string[]; now: Date }>(
    (resolve) => {
      provideCohort = resolve;
    }
  );
  const read = (ids: readonly string[], now: Date): Promise<MetricFacts> =>
    withAppSpan("branches.analytics.metric_facts", () =>
      Promise.all([
        readCohortPullRequestFacts(organizationId, ids, query, now),
        readCohortCostFacts(organizationId, ids, query, now),
      ])
    );
  const started = cohort.then(({ ids, now }) => read(ids, now));
  // A snapshot that fails after providing the cohort leaves nothing awaiting
  // this; `settle` still sees the rejection.
  started.catch(() => undefined);
  return {
    provide(ids: readonly string[], now: Date) {
      first ??= { ids, now };
      provideCohort({ ids, now });
    },
    async settle(
      ids: readonly string[],
      now: Date
    ): Promise<SettledMetricFacts> {
      try {
        return await (first && sameCohort(first, ids, now)
          ? started
          : read(ids, now));
      } catch (error) {
        reportBranchListEnrichmentFailedOpen(
          BranchListEnrichmentRead.MetricFacts,
          error,
          { organizationId, rowCount: ids.length }
        );
        return [undefined, undefined];
      }
    },
  };
}

function sameCohort(
  started: { ids: readonly string[]; now: Date },
  ids: readonly string[],
  now: Date
): boolean {
  return (
    started.now.getTime() === now.getTime() &&
    started.ids.length === ids.length &&
    started.ids.every((id, index) => id === ids[index])
  );
}
