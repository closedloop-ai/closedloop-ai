import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import {
  setAppSpanAttributes,
  withAppSpan,
} from "@repo/observability/tracing/spans";
import { canUseCandidateOrderForServerAnalytics } from "../branch-analytics-query-scope";
import type { BranchAnalyticsArtifactRow } from "../branch-analytics-select";
import {
  type BranchCandidateSnapshot,
  getBranchCandidateSnapshots,
} from "../branch-candidate-read";
import type { BranchListOperationQuery } from "../branch-list-query";
import {
  branchAnalyticsQuerySpanAttributes,
  getBranchServerAnalyticsRows,
} from "../branch-server-analytics-cohort";
import type { BranchListIdentityData } from "./identity-attribution";
import {
  getBranchAnalyticsRows,
  getBranchRowsById,
} from "./persisted-row-read";

type BranchAnalyticsRowCohortClient = Parameters<
  typeof getBranchCandidateSnapshots
>[0] &
  Parameters<typeof getBranchAnalyticsRows>[0] &
  Parameters<typeof getBranchRowsById>[0] &
  Parameters<typeof getBranchServerAnalyticsRows>[0];

type BranchAnalyticsRowCohorts = {
  rows: BranchAnalyticsArtifactRow[];
  canonicalRows: BranchAnalyticsArtifactRow[];
};

/** Load metric rows and canonical rows without duplicate heavy row hydration. */
export function loadBranchAnalyticsRowCohorts(
  db: BranchAnalyticsRowCohortClient,
  organizationId: string,
  query: BranchListOperationQuery,
  nowIso: string
): Promise<BranchAnalyticsRowCohorts> {
  const operationQuery = query.evaluationNow
    ? query
    : { ...query, evaluationNow: new Date(nowIso) };
  if (operationQuery.pageMode === BranchListPageMode.Server) {
    return loadServerBranchAnalyticsRowCohorts(
      db,
      organizationId,
      operationQuery,
      nowIso
    );
  }
  return loadPersistedBranchAnalyticsRowCohorts(
    db,
    organizationId,
    operationQuery
  );
}

async function loadPersistedBranchAnalyticsRowCohorts(
  db: BranchAnalyticsRowCohortClient,
  organizationId: string,
  query: BranchListOperationQuery
): Promise<BranchAnalyticsRowCohorts> {
  if (!hasDateWindow(query)) {
    const candidates = await loadBranchAnalyticsCohortCandidates(
      db,
      organizationId,
      query,
      "branches.analytics.initial"
    );
    const rows = await hydrateBranchAnalyticsRows(
      db,
      organizationId,
      candidates,
      "branches.analytics.initial"
    );
    return {
      rows,
      canonicalRows: rows,
    };
  }
  const candidates = await loadBranchAnalyticsCohortCandidates(
    db,
    organizationId,
    stripDateWindow(query),
    "branches.analytics.canonical"
  );
  const windowedCandidates = filterCandidatesByDateWindow(candidates, query);
  const canonicalRows = await hydrateBranchAnalyticsRows(
    db,
    organizationId,
    candidates,
    "branches.analytics.canonical"
  );
  return {
    rows: filterRowsByCandidateIds(canonicalRows, windowedCandidates),
    canonicalRows,
  };
}

async function loadServerBranchAnalyticsRowCohorts(
  db: BranchAnalyticsRowCohortClient,
  organizationId: string,
  query: BranchListOperationQuery,
  nowIso: string
): Promise<BranchAnalyticsRowCohorts> {
  if (!hasDateWindow(query)) {
    const candidates = await loadBranchAnalyticsCohortCandidates(
      db,
      organizationId,
      query,
      "branches.analytics.server.initial"
    );
    const rows = await getBranchServerAnalyticsRows(
      db,
      organizationId,
      query,
      nowIso,
      { candidates }
    );
    return {
      rows,
      canonicalRows: rows,
    };
  }
  if (!canUseCandidateOrderForServerAnalytics(query)) {
    const canonicalQuery = stripDateWindow(query);
    // ISS-9111: the windowed arm's candidate set is the date-stripped one under
    // `candidateMatchesDateWindow`, which is the JS mirror of the SQL activity
    // predicate, and its list rows are those rows under the same select. Both
    // are read once here. The projection each arm runs on top is date-window
    // sensitive (`sessionUsageDateWindow`), so that part still runs per arm.
    const canonicalCandidates = await withAppSpan(
      "branches.analytics.server.canonical.candidate_snapshots",
      async () => {
        const result = await getBranchCandidateSnapshots(
          db,
          organizationId,
          canonicalQuery
        );
        setAppSpanAttributes({
          "branches.analytics.server.canonical.candidate_branch_count":
            result.length,
        });
        return result;
      },
      branchAnalyticsQuerySpanAttributes(query)
    );
    const canonicalListRows = await withAppSpan(
      "branches.analytics.server.canonical.row_hydration",
      () =>
        getBranchRowsById(
          db,
          organizationId,
          canonicalCandidates.map((candidate) => candidate.id),
          canonicalCandidates
        )
    );
    // Both projections share one transaction. Lifetime identity is unchanged
    // by the date arm, while each arm still reads its own windowed usage.
    let canonicalIdentityData: BranchListIdentityData | undefined;
    const canonicalRows = await getBranchServerAnalyticsRows(
      db,
      organizationId,
      canonicalQuery,
      nowIso,
      {
        spanPrefix: "branches.analytics.server.canonical",
        candidates: canonicalCandidates,
        listRows: canonicalListRows,
        onIdentityData: (data) => {
          canonicalIdentityData = data;
        },
      }
    );
    const rows = await getBranchServerAnalyticsRows(
      db,
      organizationId,
      query,
      nowIso,
      {
        candidates: filterCandidatesByDateWindow(canonicalCandidates, query),
        listRows: canonicalListRows,
        preloadedIdentityData: canonicalIdentityData,
      }
    );
    return { rows, canonicalRows };
  }
  const candidates = await loadBranchAnalyticsCohortCandidates(
    db,
    organizationId,
    stripDateWindow(query),
    "branches.analytics.canonical"
  );
  const windowedCandidates = filterCandidatesByDateWindow(candidates, query);
  const canonicalRows = await hydrateBranchAnalyticsRows(
    db,
    organizationId,
    candidates,
    "branches.analytics.canonical"
  );
  return {
    rows: filterRowsByCandidateIds(canonicalRows, windowedCandidates),
    canonicalRows,
  };
}

function loadBranchAnalyticsCohortCandidates(
  db: BranchAnalyticsRowCohortClient,
  organizationId: string,
  query: BranchListOperationQuery,
  spanPrefix: string
): Promise<BranchCandidateSnapshot[]> {
  return withAppSpan(`${spanPrefix}.candidate_snapshots`, async () => {
    const result = await getBranchCandidateSnapshots(db, organizationId, query);
    setAppSpanAttributes({
      [`${spanPrefix}.candidate_branch_count`]: result.length,
    });
    return result;
  });
}

function hydrateBranchAnalyticsRows(
  db: BranchAnalyticsRowCohortClient,
  organizationId: string,
  candidates: readonly BranchCandidateSnapshot[],
  spanPrefix: string
): Promise<BranchAnalyticsArtifactRow[]> {
  return withAppSpan(`${spanPrefix}.analytics_row_hydration`, async () => {
    const result = await getBranchAnalyticsRows(
      db,
      organizationId,
      candidates.map((candidate) => candidate.id),
      candidates
    );
    setAppSpanAttributes({
      [`${spanPrefix}.analytics_row_count`]: result.length,
    });
    return result;
  });
}

function filterRowsByCandidateIds(
  rows: readonly BranchAnalyticsArtifactRow[],
  candidates: readonly BranchCandidateSnapshot[]
): BranchAnalyticsArtifactRow[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return rows.filter((row) => candidateIds.has(row.id));
}

function filterCandidatesByDateWindow(
  candidates: readonly BranchCandidateSnapshot[],
  query: BranchListOperationQuery
): BranchCandidateSnapshot[] {
  const evaluationNow = query.evaluationNow ?? new Date();
  return candidates.filter((candidate) =>
    candidateMatchesDateWindow(candidate, query, evaluationNow)
  );
}

function candidateMatchesDateWindow(
  candidate: BranchCandidateSnapshot,
  query: BranchListOperationQuery,
  evaluationNow: Date
): boolean {
  const occurredAt = candidate.activityAtom?.occurredAt ?? null;
  if (!occurredAt || occurredAt > evaluationNow) {
    return true;
  }
  if (query.startDate && occurredAt < query.startDate) {
    return false;
  }
  if (query.endDate && occurredAt > query.endDate) {
    return false;
  }
  return true;
}

function hasDateWindow(query: BranchListOperationQuery): boolean {
  return Boolean(query.startDate || query.endDate);
}

function stripDateWindow(
  query: BranchListOperationQuery
): BranchListOperationQuery {
  return {
    ...query,
    startDate: undefined,
    endDate: undefined,
  };
}
