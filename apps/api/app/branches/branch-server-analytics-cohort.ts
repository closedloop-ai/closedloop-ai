import type { BranchRow } from "@repo/api/src/types/branch";
import { selectBranchServerRows } from "@repo/lib/branches/branch-list-page";
import {
  setAppSpanAttributes,
  withAppSpan,
} from "@repo/observability/tracing/spans";
import { canUseCandidateOrderForServerAnalytics } from "./branch-analytics-query-scope";
import {
  type BranchCandidateSnapshot,
  getBranchCandidateSnapshots,
} from "./branch-candidate-read";
import { projectBranchListRows } from "./branch-list-projection";
import type { BranchListOperationQuery } from "./branch-list-query";
import type { BranchListIdentityData } from "./branch-read-service/identity-attribution";
import {
  asBranchAnalyticsRow,
  type BranchArtifactRow,
  getBranchAnalyticsRows,
  getBranchRowsById,
  selectRowsInIdOrder,
} from "./branch-read-service/persisted-row-read";
import { toBranchServerPageQuery } from "./branch-server-page-query";

type ServerAnalyticsClient = Parameters<typeof getBranchCandidateSnapshots>[0] &
  Parameters<typeof getBranchRowsById>[0] &
  Parameters<typeof projectBranchListRows>[0] &
  Parameters<typeof getBranchAnalyticsRows>[0];

type ServerAnalyticsOptions = {
  spanPrefix?: string;
  preloadedIdentityData?: BranchListIdentityData;
  onIdentityData?: (data: BranchListIdentityData) => void;
  /**
   * ISS-8016: the candidate cohort the caller already scanned. ISS-8148 made
   * the Product and metric-denominator predicates select the same population,
   * so a caller holding one has already paid for the scan this function would
   * otherwise repeat; supplying it keeps the server page on a single LATERAL.
   */
  candidates?: BranchCandidateSnapshot[];
  /**
   * ISS-9111: the list rows the caller already hydrated for a SUPERSET of
   * `candidates`, under the same select and the same candidate snapshots. The
   * projection filter this function runs is date-window sensitive and so still
   * runs per arm, but the artifact read behind it is scope-wide and identical,
   * so a caller resolving two date arms pays for it once.
   */
  listRows?: readonly BranchArtifactRow[];
};

/** Resolve analytics rows for the exact server List cohort. */
export async function getBranchServerAnalyticsRows(
  db: ServerAnalyticsClient,
  organizationId: string,
  query: BranchListOperationQuery,
  nowIso: string,
  options: ServerAnalyticsOptions = {}
) {
  const spanPrefix = options.spanPrefix ?? "branches.analytics.server.initial";
  const operationQuery = query.evaluationNow
    ? query
    : { ...query, evaluationNow: new Date(nowIso) };
  const candidates =
    options.candidates ??
    (await withAppSpan(
      `${spanPrefix}.candidate_snapshots`,
      async () => {
        const result = await getBranchCandidateSnapshots(
          db,
          organizationId,
          operationQuery
        );
        setAppSpanAttributes({
          [`${spanPrefix}.candidate_branch_count`]: result.length,
        });
        return result;
      },
      branchAnalyticsQuerySpanAttributes(query)
    ));
  // ISS-9111: the projection arm already hydrated these rows under the superset
  // list select, so re-reading them narrowed bought nothing and resolved the
  // cohort against a second, later database state.
  if (!canUseCandidateOrderForServerAnalytics(query)) {
    const projectedRows = await selectProjectedServerAnalyticsRows(
      db,
      organizationId,
      candidates,
      operationQuery,
      nowIso,
      spanPrefix,
      options.listRows,
      options
    );
    return withAppSpan(`${spanPrefix}.analytics_row_hydration`, () =>
      instrumentAnalyticsRowCount(
        projectedRows.map(asBranchAnalyticsRow),
        spanPrefix
      )
    );
  }
  const selectedIds = candidates.map((candidate) => candidate.id);
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  return withAppSpan(`${spanPrefix}.analytics_row_hydration`, async () =>
    instrumentAnalyticsRowCount(
      await getBranchAnalyticsRows(
        db,
        organizationId,
        selectedIds,
        selectedIds.flatMap((id) => {
          const candidate = candidatesById.get(id);
          return candidate ? [candidate] : [];
        })
      ),
      spanPrefix
    )
  );
}

async function selectProjectedServerAnalyticsRows(
  db: ServerAnalyticsClient,
  organizationId: string,
  candidates: Awaited<ReturnType<typeof getBranchCandidateSnapshots>>,
  query: BranchListOperationQuery,
  nowIso: string,
  spanPrefix: string,
  hydratedListRows?: readonly BranchArtifactRow[],
  options: ServerAnalyticsOptions = {}
): Promise<BranchArtifactRow[]> {
  const rows = hydratedListRows
    ? selectRowsInIdOrder(
        hydratedListRows,
        candidates.map((candidate) => candidate.id)
      )
    : await withAppSpan(`${spanPrefix}.row_hydration`, () =>
        getBranchRowsById(
          db,
          organizationId,
          candidates.map((candidate) => candidate.id),
          candidates
        )
      );
  const projected = await withAppSpan(`${spanPrefix}.list_projection`, () =>
    projectBranchListRows(db, organizationId, rows, query, undefined, {
      includeAttributedCost: false,
      preloadedIdentityData: options.preloadedIdentityData,
      onIdentityData: options.onIdentityData,
    })
  );
  const selected = withAppSpan(`${spanPrefix}.server_row_selection`, () =>
    selectAndInstrumentServerRows(projected.items, query, nowIso, spanPrefix)
  );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return selected.flatMap((row) => {
    const hydrated = rowsById.get(row.id);
    return hydrated ? [hydrated] : [];
  });
}

function selectAndInstrumentServerRows(
  rows: BranchRow[],
  query: BranchListOperationQuery,
  nowIso: string,
  spanPrefix: string
): BranchRow[] {
  const selected = selectBranchServerRows(
    rows,
    toBranchServerPageQuery(query),
    nowIso
  );
  setAppSpanAttributes({
    [`${spanPrefix}.projected_row_count`]: rows.length,
    [`${spanPrefix}.selected_page_row_count`]: selected.length,
  });
  return selected;
}

/** Keep both arms reporting the same analytics row-count attribute. */
function instrumentAnalyticsRowCount<Row>(
  rows: Row[],
  spanPrefix: string
): Row[] {
  setAppSpanAttributes({
    [`${spanPrefix}.analytics_row_count`]: rows.length,
  });
  return rows;
}

/** The query-shape attributes every server-analytics candidate scan carries. */
export function branchAnalyticsQuerySpanAttributes(
  query: BranchListOperationQuery
) {
  return {
    "branches.analytics.page_mode_server": true,
    "branches.analytics.date_bounded": Boolean(
      query.startDate || query.endDate
    ),
    "branches.analytics.has_status_filter": Boolean(query.status),
    "branches.analytics.has_search_filter": Boolean(query.search),
    "branches.analytics.has_repository_filter": Boolean(query.repository),
  };
}
