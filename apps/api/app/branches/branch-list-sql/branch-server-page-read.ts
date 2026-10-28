import {
  BranchListFacetAvailability,
  type BranchListFacetOption,
  type BranchListFacetResult,
  type BranchListFacets,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import type { BranchStatusOrdering } from "@repo/api/src/types/branch-status-order";
import type { Prisma } from "@repo/database";
import {
  BRANCH_LIST_LAST_ACTIVE_OPTIONS,
  BRANCH_LIST_PULL_REQUEST_OPTIONS,
  branchListFacetAvailabilityFromCounts,
  branchListRepositoryDisplayLabels,
  branchListStatusLabel,
  compareFacetOptions,
} from "@repo/lib/branches/branch-list-page";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type BranchListEnrichmentDomain,
  BranchListEnrichmentRead,
  markBranchListEnrichmentUnavailable,
} from "../branch-list-enrichment";
import type { BranchListOperationQuery } from "../branch-list-query";
import {
  BranchListSqlAvailabilityMeasure,
  type BranchListSqlRow,
  BranchListSqlRowKind,
  branchServerPageSql,
} from "./branch-server-page-sql";

type BranchServerPageSqlClient = {
  $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
};

/**
 * The page's ids, its cohort totals and all eight corpus-wide facets, read in
 * one statement. The caller hydrates and projects `pageIds` and nothing else.
 */
export type BranchServerPageSqlSnapshot = {
  pageIds: string[];
  total: number;
  repairedOffset: number;
  retainedUnavailableCount: number;
  facets: BranchListFacets;
};

/**
 * Run the Branch list page read and decode its single result set.
 *
 * ISS-10297's contract — "optional enrichment must not sit on a fatal path"
 * (`apps/api/AGENTS.md`) — survives the identity reads moving INTO this
 * statement (davetho review on #7545). They are the page's only optional
 * ingredient: everything else here is the page itself. So a rejection is
 * attributed to identity, recorded on the domain, and rethrown, which is what
 * makes `readBranchListFailingOpen` re-run the whole read on a fresh
 * snapshot with the identity CTEs replaced by their UNAVAILABLE stanza. `/branches`
 * then returns its page with the Collaborator facet marked unavailable, instead
 * of the 500 a bare throw produced. Owner is the branch's assignee column
 * (ISS-12463), so it stays complete on the retry.
 *
 * A P2028 means the snapshot itself expired, so dropping optional joins cannot
 * recover its spent budget and must not buy a second full-corpus attempt.
 * Statement cancellation (57014) still permits the existing identity fallback
 * on a fresh snapshot; the second pass skips identity and cannot retry again.
 */
export async function readBranchServerPageFromSql(
  db: BranchServerPageSqlClient,
  organizationId: string,
  operationQuery: BranchListOperationQuery,
  query: BranchServerPageQuery,
  evaluationNow: Date,
  ordering: BranchStatusOrdering,
  enrichment: BranchListEnrichmentDomain
): Promise<BranchServerPageSqlSnapshot> {
  const identityResolved = !enrichment.skip.has(
    BranchListEnrichmentRead.Identity
  );
  try {
    const rows = await db.$queryRaw<BranchListSqlRow[]>(
      branchServerPageSql(
        organizationId,
        operationQuery,
        query,
        evaluationNow,
        ordering,
        identityResolved
      )
    );
    return decodeBranchServerPageRows(rows, ordering);
  } catch (error) {
    if (identityResolved && getPrismaErrorCode(error) !== "P2028") {
      markBranchListEnrichmentUnavailable({
        read: BranchListEnrichmentRead.Identity,
        domain: enrichment,
        context: { organizationId },
        error,
      });
    }
    throw error;
  }
}

/** Exported for the parity suite, which compares this against the JS kernel. */
export function decodeBranchServerPageRows(
  rows: readonly BranchListSqlRow[],
  ordering: BranchStatusOrdering
): BranchServerPageSqlSnapshot {
  const pageIds = rows
    .filter((row) => row.kind === BranchListSqlRowKind.Page)
    .sort((left, right) => Number(left.ord ?? 0) - Number(right.ord ?? 0))
    .flatMap((row) => (row.value === null ? [] : [row.value]));
  const facetRows = rows.filter(
    (row) => row.kind === BranchListSqlRowKind.Facet
  );
  const availability = availabilityTallies(rows);
  const repositoryLabels = branchListRepositoryDisplayLabels(
    facetOptions(facetRows, "repositories").map((option) => option.id)
  );
  return {
    pageIds,
    total: scalar(rows, BranchListSqlRowKind.Total),
    repairedOffset: scalar(rows, BranchListSqlRowKind.Offset),
    retainedUnavailableCount: scalar(rows, BranchListSqlRowKind.Retained),
    facets: {
      names: dynamicFacet(
        facetOptions(facetRows, "names"),
        BranchListFacetAvailability.Complete
      ),
      owners: dynamicFacet(
        facetOptions(facetRows, "owners"),
        availability("owners")
      ),
      collaborators: dynamicFacet(
        facetOptions(facetRows, "collaborators"),
        availability("collaborators")
      ),
      statuses: fixedFacet(
        facetRows,
        "statuses",
        ordering.order.map((status) => [status, branchListStatusLabel(status)])
      ),
      pullRequests: fixedFacet(
        facetRows,
        "pullRequests",
        BRANCH_LIST_PULL_REQUEST_OPTIONS
      ),
      lastActiveRanges: fixedFacet(
        facetRows,
        "lastActiveRanges",
        BRANCH_LIST_LAST_ACTIVE_OPTIONS
      ),
      repositories: dynamicFacet(
        facetOptions(facetRows, "repositories").map((option) => ({
          ...option,
          label: repositoryLabels.get(option.id) ?? option.label,
        })),
        BranchListFacetAvailability.Complete
      ),
      // The cloud list always loads the tag relation, so every row reports
      // `available` and the fold is Complete for any population including an
      // empty one (`projectArtifactTags`).
      tags: dynamicFacet(
        facetOptions(facetRows, "tags"),
        BranchListFacetAvailability.Complete
      ),
    },
  };
}

function scalar(
  rows: readonly BranchListSqlRow[],
  kind: BranchListSqlRowKind
): number {
  return Number(rows.find((row) => row.kind === kind)?.count ?? 0);
}

function facetOptions(
  facetRows: readonly BranchListSqlRow[],
  facet: string
): BranchListFacetOption[] {
  return facetRows
    .filter((row) => row.facet === facet && row.value !== null)
    .map((row) => ({
      id: row.value ?? "",
      label: row.label ?? row.value ?? "",
      count: Number(row.count ?? 0),
    }));
}

function dynamicFacet(
  options: readonly BranchListFacetOption[],
  facetAvailability: BranchListFacetAvailability
): BranchListFacetResult {
  return {
    availability: facetAvailability,
    options: [...options].sort(compareFacetOptions),
  };
}

/**
 * A fixed facet lists every offered option, including the ones no row carries —
 * `review` and `blocked` have no producer and are always zero.
 */
function fixedFacet(
  facetRows: readonly BranchListSqlRow[],
  facet: string,
  options: readonly (readonly [string, string])[]
): BranchListFacetResult {
  const counts = new Map(
    facetOptions(facetRows, facet).map((option) => [option.id, option.count])
  );
  return {
    availability: BranchListFacetAvailability.Complete,
    options: options.map(([id, label]) => ({
      id,
      label,
      count: counts.get(id) ?? 0,
    })),
  };
}

function availabilityTallies(
  rows: readonly BranchListSqlRow[]
): (facet: string) => BranchListFacetAvailability {
  const measures = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === BranchListSqlRowKind.Availability && row.facet) {
      measures.set(`${row.facet}:${row.value}`, Number(row.count ?? 0));
    }
  }
  const measure = (facet: string, name: BranchListSqlAvailabilityMeasure) =>
    measures.get(`${facet}:${name}`) ?? 0;
  return (facet: string) =>
    branchListFacetAvailabilityFromCounts(
      measure(facet, BranchListSqlAvailabilityMeasure.Rows),
      measure(facet, BranchListSqlAvailabilityMeasure.NonComplete),
      measure(facet, BranchListSqlAvailabilityMeasure.Unavailable)
    );
}
