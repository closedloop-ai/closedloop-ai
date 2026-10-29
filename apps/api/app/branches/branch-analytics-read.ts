import "server-only";

/**
 * ISS-11117: the two Branches-analytics reads, lifted out of
 * `branch-read-service.ts`.
 *
 * They moved for a concrete reason, not tidiness. Both now run their metric
 * PROJECTION after the read snapshot closes, so the cohort's Pensero numerator
 * — whose read must be the outermost `RepeatableRead` transaction — can sit
 * between the two. Expressing that as `await` inside a self-referential service
 * object literal made `branchReadService`'s own type circular (TS7022): the
 * object calls `branchReadService.getBranchDetail` from other members, so every
 * member's type has to resolve before the object's does. As standalone
 * functions with declared signatures they are outside that graph, and
 * `branch-read-service.ts` drops ~200 lines it was over-carrying.
 */

import type { BranchAnalytics } from "@repo/api/src/types/branch";
import {
  type BranchAnalyticsCohortRequest,
  type BranchAnalyticsCohortResponse,
  cloudBranchAnalyticsCohortRequestSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import {
  setAppSpanAttributes,
  withAppSpan,
} from "@repo/observability/tracing/spans";
import type { OrgMergedPullRequestAdmissionMap } from "@/lib/pull-request-population";
import {
  buildBranchAnalytics,
  withCanonicalSpendKpis,
} from "./branch-analytics-kpis";
import { getBranchCandidateSnapshots } from "./branch-candidate-read";
import {
  type CloudCanonicalMetricRow,
  projectCloudCanonicalMetrics,
} from "./branch-canonical-metric-projection";
import { readBranchListFailingOpen } from "./branch-list-enrichment";
import {
  type BranchListQuery,
  branchListQuerySchema,
} from "./branch-list-query";
import { startMetricFactsOnCohort } from "./branch-metric-facts-start";
import type { BranchPenseroNumerator } from "./branch-pensero-numerator";
import { BranchProductReadWorkload } from "./branch-product-read-snapshot";
import { withBranchPushLocEvidence } from "./branch-push-loc-read";
import { toBranchAnalyticsMetrics } from "./branch-read-service/analytics-metrics";
import { loadBranchAnalyticsRowCohorts } from "./branch-read-service/analytics-row-cohorts";
import { loadCanonicalMetricProjectionInputs } from "./branch-read-service/canonical-metric-populations";
import { getBranchAnalyticsRows } from "./branch-read-service/persisted-row-read";

export async function readBranchAnalytics(
  organizationId: string,
  query: BranchListQuery,
  /**
   * ISS-11117: reads the cohort's Pensero points once the snapshot has
   * CLOSED.
   *
   * A function rather than a value because the cohort's branch ids are only
   * known inside the read, and a function rather than an inline read because
   * `readPenseroBranchDeliveryPoints` opens its own outermost
   * `RepeatableRead` transaction — `withDb.tx` throws rather than join the
   * ambient snapshot — and because the display-flag evaluation belongs at the
   * route, beside every other PostHog read this service is kept clear of.
   */
  readCohortPenseroPoints?: CohortPenseroPointsReader
): Promise<BranchAnalytics> {
  const metricFacts = startMetricFactsOnCohort(organizationId, query);
  const {
    analytics,
    projection,
  }: {
    analytics: BranchAnalytics;
    projection: CanonicalMetricProjectionCarrier;
  } = await readBranchListFailingOpen(
    organizationId,
    (db, enrichment) => {
      return withAppSpan(
        "branches.analytics.total",
        async () => {
          const now = new Date();
          const { rows, canonicalRows } = await loadBranchAnalyticsRowCohorts(
            db,
            organizationId,
            query,
            now.toISOString()
          );
          setAppSpanAttributes({
            "branches.analytics.initial.row_count": rows.length,
          });
          setAppSpanAttributes({
            "branches.analytics.canonical.row_count": canonicalRows.length,
          });
          metricFacts.provide(
            canonicalRows.map((row) => row.id),
            now
          );
          const { orgMergedPullRequestAdmissionByBranchId, pushLocEvidence } =
            await loadCanonicalMetricProjectionInputs(
              db,
              organizationId,
              canonicalRows,
              canonicalRows.map((row) => row.id),
              enrichment
            );
          const metrics = rows.map(toBranchAnalyticsMetrics);
          const analytics = withAppSpan("branches.analytics.kpi_fold", () =>
            buildBranchAnalytics({ metrics })
          );
          // ISS-11117: the projection is HOISTED out of the snapshot —
          // everything it reads is already in memory and it is synchronous,
          // so running it after the transaction closes changes nothing about
          // its inputs, and it is the only way the Pensero read (which must
          // be the outermost transaction) can reach it.
          return {
            analytics,
            projection: {
              rows: withBranchPushLocEvidence(canonicalRows, pushLocEvidence),
              branchArtifactIds: canonicalRows.map((row) => row.id),
              now,
              orgMergedPullRequestAdmissionByBranchId,
            },
          };
        },
        branchAnalyticsTotalSpanAttributes(query)
      );
    },
    BranchProductReadWorkload.FullCorpus
  );
  const penseroPoints = await resolveCohortPenseroPoints(
    readCohortPenseroPoints,
    projection.branchArtifactIds ?? []
  );
  const [pullRequestFacts, costFacts] = await metricFacts.settle(
    projection.branchArtifactIds ?? [],
    projection.now
  );
  const canonicalMetrics = withAppSpan(
    "branches.analytics.canonical_metrics_projection",
    () =>
      projectCloudCanonicalMetrics(
        projection.rows,
        query,
        projection.now,
        projection.orgMergedPullRequestAdmissionByBranchId,
        penseroPoints,
        pullRequestFacts,
        costFacts
      )
  );
  return {
    ...withCanonicalSpendKpis(analytics, canonicalMetrics),
    canonicalMetrics,
  };
}

/** Project canonical metrics for an exact authenticated-org Branch cohort. */
export async function readBranchCohortAnalytics(
  organizationId: string,
  rawRequest: BranchAnalyticsCohortRequest,
  /** ISS-11117. See {@link branchReadService.getBranchAnalytics}. */
  readCohortPenseroPoints?: CohortPenseroPointsReader
): Promise<BranchAnalyticsCohortResponse> {
  const request = cloudBranchAnalyticsCohortRequestSchema.parse(rawRequest);
  const query = branchListQuerySchema.parse({
    startDate: request.startDate,
    endDate: request.endDate,
  });
  const metricFacts = startMetricFactsOnCohort(organizationId, query);
  // ISS-10300 (#7314 review, whitlockk): the cohort read is NOT page-bounded. Its
  // only cardinality bound is the 64 KiB serialized-request cap, and a UUID
  // costs ~39 bytes in the `branchIds` array, so ~1,670 ids fit — well above
  // the 781-branch org in the ISS-10295 incident. A whole-org cohort therefore
  // runs candidate, hydration, and metric reads over every matched id on one
  // snapshot, which is a full-corpus read by any measure.
  const {
    matchedBranchIds,
    projection,
  }: {
    matchedBranchIds: string[];
    projection: CanonicalMetricProjectionCarrier;
  } = await readBranchListFailingOpen(
    organizationId,
    async (db, enrichment) => {
      const authorizedCandidates = await getBranchCandidateSnapshots(
        db,
        organizationId,
        { ...query, startDate: undefined, endDate: undefined },
        request.branchIds
      );
      const authorizedIdSet = new Set(
        authorizedCandidates.map((candidate) => candidate.id)
      );
      const candidateBranchIds = request.branchIds.filter((branchId) =>
        authorizedIdSet.has(branchId)
      );
      const rows = await getBranchAnalyticsRows(
        db,
        organizationId,
        candidateBranchIds,
        authorizedCandidates
      );
      const projectedIdSet = new Set(rows.map((row) => row.id));
      const matchedBranchIds = candidateBranchIds.filter((branchId) =>
        projectedIdSet.has(branchId)
      );
      const now = new Date();
      metricFacts.provide(matchedBranchIds, now);
      const { orgMergedPullRequestAdmissionByBranchId, pushLocEvidence } =
        await loadCanonicalMetricProjectionInputs(
          db,
          organizationId,
          rows,
          matchedBranchIds,
          enrichment
        );
      // ISS-11117: hoisted out of the snapshot — see the sibling call site.
      return {
        matchedBranchIds,
        projection: {
          rows: withBranchPushLocEvidence(rows, pushLocEvidence),
          now,
          orgMergedPullRequestAdmissionByBranchId,
        },
      };
    },
    BranchProductReadWorkload.FullCorpus
  );
  const penseroPoints = await resolveCohortPenseroPoints(
    readCohortPenseroPoints,
    matchedBranchIds
  );
  const [pullRequestFacts, costFacts] = await metricFacts.settle(
    matchedBranchIds,
    projection.now
  );
  return {
    matchedBranchIds,
    canonicalMetrics: projectCloudCanonicalMetrics(
      projection.rows,
      query,
      projection.now,
      projection.orgMergedPullRequestAdmissionByBranchId,
      penseroPoints,
      pullRequestFacts,
      costFacts
    ),
  };
}

/**
 * ISS-11117: what the branch read snapshot hands the projection it no longer
 * runs itself.
 *
 * Everything here is already in memory when the snapshot closes, and
 * `projectCloudCanonicalMetrics` is synchronous, so running it afterwards
 * changes none of its inputs — it is what lets the Pensero read, which must be
 * the OUTERMOST transaction, sit between the two.
 *
 * Declared rather than inferred because this object is what a self-referential
 * service object's type inference has to resolve; leaving it implicit made
 * `branchReadService` circular (TS7022).
 */
type CanonicalMetricProjectionCarrier = {
  rows: readonly CloudCanonicalMetricRow[];
  /** The branch artifact ids the read MATCHED — the Pensero read's population. */
  branchArtifactIds?: readonly string[];
  /**
   * The read's own evaluation instant, carried rather than re-taken: the row
   * cohort was selected against THIS instant, so projecting against a later one
   * would judge windows the rows were never filtered by.
   */
  now: Date;
  orgMergedPullRequestAdmissionByBranchId: OrgMergedPullRequestAdmissionMap;
};

/**
 * ISS-11117: how a route hands this service the cohort's Pensero numerator.
 *
 * Takes the branch artifact ids the read actually matched — never the ids the
 * client asked for — so the points numerator and the cost denominator span the
 * same population. Returns `null` for "no Pensero numerator for this cohort",
 * which is the state that keeps the LOC/$ card rendering exactly as today.
 */
export type CohortPenseroPointsReader = (
  branchArtifactIds: readonly string[]
) => Promise<BranchPenseroNumerator | null>;

/**
 * Invoke the reader, or answer "no numerator" when the caller supplied none.
 *
 * An absent reader is the desktop/local and test path: no Pensero, and so the
 * bundle omits the field and every consumer renders LOC/$.
 */
function resolveCohortPenseroPoints(
  read: CohortPenseroPointsReader | undefined,
  branchArtifactIds: readonly string[]
): Promise<BranchPenseroNumerator | null> {
  return read ? read(branchArtifactIds) : Promise.resolve(null);
}

/** The analytics span's request-shape attributes. */
function branchAnalyticsTotalSpanAttributes(query: BranchListQuery) {
  return {
    "branches.analytics.page_mode_server":
      query.pageMode === BranchListPageMode.Server,
    "branches.analytics.date_bounded": Boolean(
      query.startDate || query.endDate
    ),
    "branches.analytics.has_status_filter": Boolean(query.status),
    "branches.analytics.has_search_filter": Boolean(query.search),
    "branches.analytics.has_repository_filter": Boolean(query.repository),
    "branches.analytics.limit": query.limit,
    "branches.analytics.offset": query.offset,
  };
}
