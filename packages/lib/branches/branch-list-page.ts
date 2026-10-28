import {
  type BranchRow,
  BranchStatus,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  type BranchPerson,
  branchPersonKey,
} from "@repo/api/src/types/branch-identity";
import {
  type BranchListFacetAvailability,
  type BranchListFacetOption,
  type BranchListFacetResult,
  type BranchListFacets,
  BranchListFilterFacet,
  BranchListLastActiveRange,
  type BranchListPageInfo,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
  BranchListFacetAvailability as FacetAvailability,
} from "@repo/api/src/types/branch-list-contract";
import {
  BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS,
  BRANCH_LIST_FILTER_VALUE_SEMANTICS,
  BRANCH_LIST_SORT_VALUE_SEMANTICS,
} from "@repo/api/src/types/branch-list-value-semantics";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { isSupportedBranchProjectionVersion } from "@repo/api/src/types/branch-projection";
import {
  type BranchStatusOrdering,
  DEFAULT_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import {
  compareListQueryText,
  ListQueryTextOrdering,
  listQueryWindowBoundMs,
} from "@repo/api/src/types/list-query-ordering-semantics";
import {
  ListQueryRowValueCase,
  listQueryFoldedRowDisposition,
  listQueryOrdersUnrankedRowFirst,
  listQueryRetainsUnjudgeableRow,
} from "@repo/api/src/types/list-query-value-semantics";
import { matchesPriorityFilter } from "@repo/api/src/types/priority-filter";
import { priorityOrdinal } from "@repo/api/src/types/search-query";
import { repairOffset } from "@repo/api/src/utils/math";

export type BranchServerPageResult = {
  items: BranchRow[];
  total: number;
  facets: BranchListFacets;
  pageInfo: BranchListPageInfo;
};

export type BranchServerPageSnapshot = {
  cohortRows: BranchRow[];
  page: BranchServerPageResult;
};

/** Build one exact page and compact facets from an already eligible corpus. */
export function buildBranchServerPage(
  rows: readonly BranchRow[],
  query: BranchServerPageQuery,
  nowIso: string,
  ordering: BranchStatusOrdering = DEFAULT_BRANCH_STATUS_ORDERING
): BranchServerPageResult {
  return buildBranchServerPageSnapshot(rows, query, nowIso, ordering).page;
}

/**
 * Build a page and expose its exact pre-pagination cohort to producer metrics.
 *
 * ISS-9437: `ordering` is the ONE resolved status ordering this page is built
 * with, and it decides BOTH the Status sort rank and the Status facet's option
 * order. Those are two derivations today that agree only because
 * `branchStatusRank`'s ranks and the facet's inline `Object.values(BranchStatus)`
 * happen to coincide; reading one value is what makes the invariant ISS-9666
 * rests on — the order you sort by is the order the filter menu lists —
 * structural rather than coincidental.
 *
 * Omitted means today's ordering exactly, so a caller that has not resolved the
 * flag keeps the current page byte for byte.
 */
export function buildBranchServerPageSnapshot(
  rows: readonly BranchRow[],
  query: BranchServerPageQuery,
  nowIso: string,
  ordering: BranchStatusOrdering = DEFAULT_BRANCH_STATUS_ORDERING
): BranchServerPageSnapshot {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new TypeError("Branch List snapshot now must be an ISO timestamp");
  }
  const dateRows = rows.filter((row) => matchesScope(row, query, now));
  const cohortRows = sortRows(
    filterRows(dateRows, query, now),
    query.sortKey,
    query.sortDir,
    now,
    ordering
  );
  const requestedOffset = query.offset;
  const offset = repairOffset(requestedOffset, cohortRows.length, query.limit);
  return {
    cohortRows,
    page: {
      items: cohortRows.slice(offset, offset + query.limit),
      total: cohortRows.length,
      facets: buildFacets(dateRows, query, now, ordering),
      pageInfo: {
        capability: "server_pagination_v1",
        limit: query.limit,
        offset,
        requestedOffset,
        now: nowIso,
      },
    },
  };
}

/** Return the exact filtered/sorted pre-pagination cohort for producer metrics. */
export function selectBranchServerRows(
  rows: readonly BranchRow[],
  query: BranchServerPageQuery,
  nowIso: string,
  ordering: BranchStatusOrdering = DEFAULT_BRANCH_STATUS_ORDERING
): BranchRow[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new TypeError("Branch List snapshot now must be an ISO timestamp");
  }
  const dateRows = rows.filter((row) => matchesScope(row, query, now));
  return sortRows(
    filterRows(dateRows, query, now),
    query.sortKey,
    query.sortDir,
    now,
    ordering
  );
}

/** Count final-cohort rows retained without a trustworthy Last-active instant. */
export function countRetainedUnavailableBranchRows(
  rows: readonly BranchRow[],
  nowIso: string
): number {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new TypeError("Branch List snapshot now must be an ISO timestamp");
  }
  return rows.filter(
    (row) => lastActivityAt(row, projectionFor(row), now) === undefined
  ).length;
}

/**
 * Count final-cohort rows whose Last-active instant was PRESENT and impossible
 * — unparseable, out of `Date` range, or after the pinned evaluation clock.
 *
 * ISS-9482 (PRD-706 R10-S07): the window RETAINS such a row, which is the right
 * result and the one that stays, but it retains it under the same shape as a row
 * that simply has no instant. Collapsing the two silently would make corrupt
 * stored activity indistinguishable from a branch nobody has touched, so the
 * anomaly is counted here and each NODE-side producer routes a non-zero count to
 * its runtime's existing diagnostic sink — the same split `spend-kpi.ts`'s
 * `isAnomalousSpendTotal` uses, and for the same reason: this package is inside
 * the browser-reachable closure and may not import a logger.
 *
 * - web server — `apps/api/app/branches/branch-last-active-cohort.ts` reports it
 *   on `branch_last_active_cohort_invalid`, the Datadog-exported `log.warn`
 *   event that already watches this cohort's producer.
 * - desktop main — `apps/desktop/src/main/branch/shared-branches-list-result.ts`
 *   emits `writePersistentLog("warn", …)`, the main-process diagnostic log.
 *
 * `0` is the ordinary answer and says nothing is wrong; it is not a coverage
 * claim about rows this cohort never loaded.
 */
export function countImpossibleBranchLastActiveInstants(
  rows: readonly BranchRow[],
  nowIso: string
): number {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new TypeError("Branch List snapshot now must be an ISO timestamp");
  }
  return rows.filter(
    (row) =>
      resolveLastActive(row, projectionFor(row), now).impossibleValue !==
      undefined
  ).length;
}

function filterRows(
  rows: readonly BranchRow[],
  query: BranchServerPageQuery,
  now: number,
  omittedFacet?: BranchListFilterFacet
): BranchRow[] {
  return rows.filter((row) => matchesFilters(row, query, now, omittedFacet));
}

function matchesFilters(
  row: BranchRow,
  query: BranchServerPageQuery,
  now: number,
  omittedFacet: BranchListFilterFacet | undefined
): boolean {
  const projection = projectionFor(row);
  const owner = ownerFor(row, projection);
  const collaborators = collaboratorsFor(row, projection);
  const repository = repositoryFor(row, projection);
  const tags = tagsFor(row, projection);
  return (
    (omittedFacet === BranchListFilterFacet.Name ||
      emptyOrIncludes(query.names, row.branchName)) &&
    (omittedFacet === BranchListFilterFacet.Owner ||
      emptyOrIncludes(query.owners, owner.key)) &&
    (omittedFacet === BranchListFilterFacet.Collaborators ||
      emptyOrOverlaps(
        query.collaborators,
        collaborators.people.map(branchPersonKey)
      )) &&
    (omittedFacet === BranchListFilterFacet.Status ||
      emptyOrIncludes(query.statuses, row.status)) &&
    (omittedFacet === BranchListFilterFacet.PullRequest ||
      emptyOrIncludes(
        query.pullRequests,
        hasPullRequest(row, projection)
          ? BranchListPullRequestPresence.Linked
          : BranchListPullRequestPresence.None
      )) &&
    (omittedFacet === BranchListFilterFacet.LastActive ||
      emptyOrIncludes(
        query.lastActiveRanges,
        lastActiveRange(lastActivityAt(row, projection, now), now) ?? ""
      )) &&
    (omittedFacet === BranchListFilterFacet.Repository ||
      emptyOrIncludes(query.repositories, repository)) &&
    (omittedFacet === BranchListFilterFacet.Tags ||
      emptyOrOverlaps(
        query.tags,
        tags.items.map((tag) => tag.id)
      )) &&
    (omittedFacet === BranchListFilterFacet.Changes ||
      matchesLocRange(row, query.locMin, query.locMax)) &&
    (omittedFacet === BranchListFilterFacet.Priority ||
      matchesPriorityFilter(row.priority, query.priorities))
  );
}

function buildFacets(
  rows: readonly BranchRow[],
  query: BranchServerPageQuery,
  now: number,
  ordering: BranchStatusOrdering
): BranchListFacets {
  const repositoryLabels = repositoryDisplayLabels(rows);
  return {
    names: dynamicFacet(
      rows,
      filterRows(rows, query, now, BranchListFilterFacet.Name),
      (row) => [[row.branchName, row.branchName]],
      FacetAvailability.Complete
    ),
    owners: dynamicFacet(
      rows,
      filterRows(rows, query, now, BranchListFilterFacet.Owner),
      (row) => {
        const owner = ownerFor(row, projectionFor(row));
        return [[owner.key, owner.label]];
      },
      identityFacetAvailability(
        rows.map((row) => ownerFor(row, projectionFor(row)).availability)
      )
    ),
    collaborators: dynamicFacet(
      rows,
      filterRows(rows, query, now, BranchListFilterFacet.Collaborators),
      (row) =>
        collaboratorsFor(row, projectionFor(row)).people.map((person) => [
          branchPersonKey(person),
          personLabel(person),
        ]),
      identityFacetAvailability(
        rows.map(
          (row) => collaboratorsFor(row, projectionFor(row)).availability
        )
      )
    ),
    statuses: fixedFacet(
      filterRows(rows, query, now, BranchListFilterFacet.Status),
      // ISS-9437: the resolved ordering, not a second `Object.values(BranchStatus)`
      // — this menu and the Status sort rank below are now one decision.
      ordering.order.map((status) => [status, branchStatusLabel(status)]),
      (row) => row.status
    ),
    pullRequests: fixedFacet(
      filterRows(rows, query, now, BranchListFilterFacet.PullRequest),
      BRANCH_LIST_PULL_REQUEST_OPTIONS,
      (row) =>
        hasPullRequest(row, projectionFor(row))
          ? BranchListPullRequestPresence.Linked
          : BranchListPullRequestPresence.None
    ),
    lastActiveRanges: fixedFacet(
      filterRows(rows, query, now, BranchListFilterFacet.LastActive),
      BRANCH_LIST_LAST_ACTIVE_OPTIONS,
      (row) =>
        lastActiveRange(lastActivityAt(row, projectionFor(row), now), now)
    ),
    repositories: dynamicFacet(
      rows,
      filterRows(rows, query, now, BranchListFilterFacet.Repository),
      (row) => {
        const repository = repositoryFor(row, projectionFor(row));
        return [[repository, repositoryLabels.get(repository) ?? repository]];
      },
      FacetAvailability.Complete
    ),
    tags: dynamicFacet(
      rows,
      filterRows(rows, query, now, BranchListFilterFacet.Tags),
      (row) =>
        tagsFor(row, projectionFor(row)).items.map((tag) => [tag.id, tag.name]),
      tagFacetAvailability(rows)
    ),
  };
}

function dynamicFacet(
  universeRows: readonly BranchRow[],
  countedRows: readonly BranchRow[],
  values: (row: BranchRow) => readonly (readonly [string, string])[],
  availability: BranchListFacetAvailability
): BranchListFacetResult {
  const universe = collectLabels(universeRows, values);
  const counts = countValues(countedRows, values);
  return {
    availability,
    options: [...universe]
      .map(([id, label]) => ({ id, label, count: counts.get(id) ?? 0 }))
      .sort(compareFacetOptions),
  };
}

function fixedFacet(
  rows: readonly BranchRow[],
  options: readonly (readonly [string, string])[],
  value: (row: BranchRow) => string | null
): BranchListFacetResult {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = value(row);
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return {
    availability: FacetAvailability.Complete,
    options: options.map(([id, label]) => ({
      id,
      label,
      count: counts.get(id) ?? 0,
    })),
  };
}

function sortRows(
  rows: readonly BranchRow[],
  key: BranchListSortKey,
  direction: BranchListSortDirection,
  now: number,
  ordering: BranchStatusOrdering
): BranchRow[] {
  return [...rows].sort((left, right) => {
    const compared = compareAvailable(
      sortValue(left, key, now, ordering),
      sortValue(right, key, now, ordering)
    );
    if (compared !== 0) {
      if (compared === null) {
        return compareMissing(
          sortValue(left, key, now, ordering),
          sortValue(right, key, now, ordering),
          key
        );
      }
      return direction === BranchListSortDirection.Asc ? compared : -compared;
    }
    return compareListQueryText(
      canonicalIdentity(left),
      canonicalIdentity(right),
      ListQueryTextOrdering.Collated
    );
  });
}

type SortValue =
  | string
  | number
  | { repository: string; number: number }
  | null;

function sortValue(
  row: BranchRow,
  key: BranchListSortKey,
  now: number,
  ordering: BranchStatusOrdering
): SortValue {
  const projection = projectionFor(row);
  switch (key) {
    case BranchListSortKey.Name:
      return row.branchName;
    case BranchListSortKey.Owner:
      return ownerFor(row, projection).label;
    case BranchListSortKey.Sessions:
      return row.sessionIds.length;
    case BranchListSortKey.Changes:
      return rowLocChange(row);
    case BranchListSortKey.Status:
      // ISS-9666: the semantic rank, never the display label — the same rank the
      // client comparator uses, so a row cannot order one way on the server page
      // and another after a client re-sort.
      //
      // ISS-9437: `rank` may report `null` for a status the resolved ordering
      // does not name. That falls into the `compareAvailable`/`compareMissing`
      // pair below, which resolve an unavailable value BEFORE the direction sign
      // is applied — so an unranked row lands last ascending AND descending.
      return ordering.rank(row.status);
    case BranchListSortKey.PullRequest:
      return row.prNumber === null
        ? null
        : { repository: repositoryFor(row, projection), number: row.prNumber };
    case BranchListSortKey.LastActivity: {
      const value = lastActivityAt(row, projection, now);
      return value ? Date.parse(value) : null;
    }
    case BranchListSortKey.Repo:
      return repositoryFor(row, projection);
    case BranchListSortKey.Priority:
      // ISS-10332: the wire ordinal, never the string. A row with no priority —
      // or one only a newer peer knows — is unavailable, so it lands last in
      // both directions like every other missing sort value.
      return row.priority == null
        ? null
        : (priorityOrdinal(row.priority) ?? null);
    default:
      return unsupportedSortKey(key);
  }
}

function compareAvailable(left: SortValue, right: SortValue): number | null {
  if (left === null || right === null) {
    return left === right ? 0 : null;
  }
  if (typeof left === "object" && typeof right === "object") {
    return (
      compareListQueryText(
        left.repository,
        right.repository,
        ListQueryTextOrdering.Collated
      ) || left.number - right.number
    );
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return compareListQueryText(
    String(left),
    String(right),
    ListQueryTextOrdering.Collated
  );
}

function compareMissing(
  left: SortValue,
  right: SortValue,
  key: BranchListSortKey
): number {
  const unrankedLeads = listQueryOrdersUnrankedRowFirst(
    BRANCH_LIST_SORT_VALUE_SEMANTICS[key]
  );
  if (left === null && right !== null) {
    return unrankedLeads ? -1 : 1;
  }
  if (right === null && left !== null) {
    return unrankedLeads ? 1 : -1;
  }
  return 0;
}

/**
 * The window and the free-text term: the scope the facets are counted over.
 * Branch name and repository, the two fields Desktop carries (it has no pull
 * request title); the cloud mirror is `branchListSearchSql`.
 */
function matchesScope(
  row: BranchRow,
  query: Pick<BranchServerPageQuery, "endDate" | "search" | "startDate">,
  now: number
): boolean {
  return matchesDateWindow(row, query, now) && matchesSearch(row, query.search);
}

function matchesSearch(row: BranchRow, search: string | undefined): boolean {
  const term = search?.trim().toLocaleLowerCase();
  if (!term) {
    return true;
  }
  const repository = repositoryFor(row, projectionFor(row)).toLocaleLowerCase();
  return (
    row.branchName.toLocaleLowerCase().includes(term) ||
    repository.includes(term)
  );
}

function matchesDateWindow(
  row: BranchRow,
  query: Pick<BranchServerPageQuery, "startDate" | "endDate">,
  now: number
): boolean {
  if (!(query.startDate || query.endDate)) {
    return true;
  }
  const resolved = resolveLastActive(row, projectionFor(row), now);
  if (resolved.instant === undefined) {
    // Both columns are read, and by the case the ROW is actually in: a window
    // whose two declarations differ selects different rows, which is what makes
    // each of them load-bearing here rather than only the one.
    return listQueryRetainsUnjudgeableRow(
      BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS[resolved.rowValueCase]
    );
  }
  const occurredAt = resolved.instant;
  const instant = Date.parse(occurredAt);
  const start = query.startDate
    ? listQueryWindowBoundMs(query.startDate)
    : Number.NEGATIVE_INFINITY;
  const end = query.endDate
    ? listQueryWindowBoundMs(query.endDate)
    : Number.POSITIVE_INFINITY;
  return instant >= start && instant <= end;
}

function lastActiveRange(
  value: string | undefined,
  now: number
): string | null {
  if (!value) {
    return null;
  }
  const occurredAt = Date.parse(value);
  const age = now - occurredAt;
  if (Number.isNaN(occurredAt) || age < 0) {
    return null;
  }
  if (age < 60 * 60 * 1000) {
    return BranchListLastActiveRange.WithinLastHour;
  }
  if (age < 7 * 60 * 60 * 1000) {
    return BranchListLastActiveRange.OneToSixHours;
  }
  if (age < 24 * 60 * 60 * 1000) {
    return BranchListLastActiveRange.SevenToTwentyFourHours;
  }
  return BranchListLastActiveRange.OneDayOrMore;
}

function matchesLocRange(
  row: BranchRow,
  min: number | undefined,
  max: number | undefined
): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }
  const loc = rowLocChange(row);
  if (loc === null) {
    // `rowLocChange` carries no availability state, so this predicate genuinely
    // cannot tell a change count that is absent from one that failed to load —
    // hence the folded read, which refuses a Changes declaration naming two
    // different answers instead of honouring `.missing` and ignoring the other.
    return listQueryRetainsUnjudgeableRow(
      listQueryFoldedRowDisposition(
        BRANCH_LIST_FILTER_VALUE_SEMANTICS[BranchListFilterFacet.Changes]
      )
    );
  }
  return (min === undefined || loc >= min) && (max === undefined || loc <= max);
}

function rowLocChange(row: BranchRow): number | null {
  return row.additions === null && row.deletions === null
    ? null
    : (row.additions ?? 0) + (row.deletions ?? 0);
}

function projectionFor(row: BranchRow) {
  return isSupportedBranchProjectionVersion(row.canonicalProjection)
    ? row.canonicalProjection
    : undefined;
}

function repositoryFor(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>
): string {
  return (
    projection?.common.identity.repositoryFullName ??
    row.repoFullName ??
    BRANCH_REPOSITORY_UNKNOWN_LABEL
  );
}

function ownerFor(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>
) {
  const identity = projection?.common.people.owner ?? row.ownerIdentity;
  const person = identity?.person;
  const label = person
    ? personLabel(person)
    : (row.owner ?? BRANCH_OWNER_UNATTRIBUTED_LABEL);
  return {
    key: person ? branchPersonKey(person) : label,
    label,
    availability:
      identity?.availability ?? BranchIdentityAvailability.Unavailable,
  };
}

function collaboratorsFor(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>
) {
  return (
    projection?.common.people.collaborators ??
    row.collaborators ?? {
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {},
    }
  );
}

function tagsFor(row: BranchRow, projection: ReturnType<typeof projectionFor>) {
  return {
    items: projection?.common.tags.items ?? row.tags ?? [],
    availability:
      projection?.common.tags.availability ??
      row.tagAvailability ??
      BranchTagAvailability.Unavailable,
  };
}

function hasPullRequest(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>
): boolean {
  return (
    (projection?.common.pullRequests.associatedCount ?? 0) > 0 ||
    row.prNumber !== null
  );
}

/**
 * Which of the row-value cases a row's Last-active instant falls into, resolved
 * ONCE so the window and the cohort counters cannot disagree about a row.
 *
 * `impossibleValue` is set only for the third outcome, which the two declared
 * cases do not name: a value that is PRESENT and cannot be true. It takes the
 * `unavailable` column because that is what the case is — a value this read
 * could not resolve into an instant — but unlike a metric that simply did not
 * load it is a DEFECT in the stored data, so the Node-side producers report it
 * (ISS-9482; `countImpossibleBranchLastActiveInstants`).
 */
type BranchLastActiveResolution =
  | {
      readonly instant: string;
      readonly rowValueCase?: undefined;
      readonly impossibleValue?: undefined;
    }
  | {
      readonly instant?: undefined;
      readonly rowValueCase: ListQueryRowValueCase;
      readonly impossibleValue?: string;
    };

function resolveLastActive(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>,
  now: number
): BranchLastActiveResolution {
  const result = projection?.common.lastActiveAt ?? row.canonicalLastActiveAt;
  if (result === undefined) {
    return resolveTimestamp(row.lastActivityAt, now);
  }
  if (
    result.state !== BranchMetricAvailability.Complete &&
    result.state !== BranchMetricAvailability.Partial
  ) {
    return { rowValueCase: ListQueryRowValueCase.Unavailable };
  }
  return resolveTimestamp(result.value, now);
}

/**
 * `Number.isNaN` covers the whole impossible set for this domain, not just the
 * unparseable half: `Date.parse` also yields `NaN` past the ±8.64e15 ms range a
 * `Date` can represent. A blank or absent value is MISSING rather than
 * impossible, and an instant after the pinned evaluation clock cannot have
 * happened yet.
 */
function resolveTimestamp(
  value: string | undefined,
  now: number
): BranchLastActiveResolution {
  if (!value) {
    return { rowValueCase: ListQueryRowValueCase.Missing };
  }
  const instant = Date.parse(value);
  if (Number.isNaN(instant) || instant > now) {
    return {
      rowValueCase: ListQueryRowValueCase.Unavailable,
      impossibleValue: value,
    };
  }
  return { instant: value, rowValueCase: undefined };
}

function lastActivityAt(
  row: BranchRow,
  projection: ReturnType<typeof projectionFor>,
  now: number
): string | undefined {
  return resolveLastActive(row, projection, now).instant;
}

function personLabel(person: BranchPerson): string {
  return person.displayName ?? person.login ?? person.id;
}

function canonicalIdentity(row: BranchRow): string {
  return (
    projectionFor(row)?.common.identity.artifactId ?? row.artifactId ?? row.id
  );
}

function collectLabels(
  rows: readonly BranchRow[],
  values: (row: BranchRow) => readonly (readonly [string, string])[]
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    for (const [id, label] of values(row)) {
      labels.set(id, labels.get(id) ?? label);
    }
  }
  return labels;
}

function countValues(
  rows: readonly BranchRow[],
  values: (row: BranchRow) => readonly (readonly [string, string])[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const id of new Set(values(row).map(([value]) => value))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

function repositoryDisplayLabels(
  rows: readonly BranchRow[]
): Map<string, string> {
  return branchListRepositoryDisplayLabels(
    rows.map((row) => repositoryFor(row, projectionFor(row)))
  );
}

function identityFacetAvailability(
  values: readonly BranchIdentityAvailability[]
): BranchListFacetAvailability {
  return branchListFacetAvailabilityFromCounts(
    values.length,
    values.filter((value) => value !== BranchIdentityAvailability.Complete)
      .length,
    values.filter((value) => value === BranchIdentityAvailability.Unavailable)
      .length
  );
}

function tagFacetAvailability(
  rows: readonly BranchRow[]
): BranchListFacetAvailability {
  const values = rows.map(
    (row) => tagsFor(row, projectionFor(row)).availability
  );
  return branchListFacetAvailabilityFromCounts(
    values.length,
    values.filter((value) => value !== BranchTagAvailability.Available).length,
    values.filter((value) => value === BranchTagAvailability.Unavailable).length
  );
}

function emptyOrIncludes(
  values: readonly string[] | undefined,
  value: string
): boolean {
  return !values || values.length === 0 || values.includes(value);
}

function emptyOrOverlaps(
  selected: readonly string[] | undefined,
  values: readonly string[]
): boolean {
  return (
    !selected ||
    selected.length === 0 ||
    values.some((value) => selected.includes(value))
  );
}

/**
 * Ranks the options of one facet menu, for BOTH Branch list mirrors — the SQL
 * page read imports this rather than keeping a second comparator, because two
 * facet menus over the same corpus that disagree on order are a divergence a
 * reader sees directly.
 *
 * The two arguments take different classes on purpose (ISS-9585): the LABEL is
 * prose a reader expects alphabetized, while the ID is a person key, a
 * repository full name or a tag id — a value the menu never shows, so it takes
 * the class this ruling gives machine identifiers. Both classes DO separate a
 * pair differing only by case; they disagree on WHICH way, because the root
 * collation ranks lowercase first and code units rank uppercase first. The id
 * class is therefore not chosen to break a tie the collation could not — it is
 * chosen because an id is a machine identifier, which is the class this ruling
 * gives one. No `ORDER BY` names a collation for it: the SQL page read imports
 * THIS comparator (`branch-server-page-read.ts`) and ranks facet options in TS,
 * so both mirrors reach the tie-break by running the same code.
 */
export function compareFacetOptions(
  left: BranchListFacetOption,
  right: BranchListFacetOption
): number {
  return (
    compareListQueryText(
      left.label,
      right.label,
      ListQueryTextOrdering.Collated
    ) || compareListQueryText(left.id, right.id, ListQueryTextOrdering.CodeUnit)
  );
}

function unsupportedSortKey(value: never): null {
  return value;
}

/**
 * The Owner facet id and label for a branch whose owner identity resolved to
 * nobody. Exported because the Branch list's SQL page read derives the same
 * facet in the database and must emit this exact value, not a second spelling.
 */
export const BRANCH_OWNER_UNATTRIBUTED_LABEL = "unattributed";

const BRANCH_STATUS_LABELS: Record<BranchStatus, string> = {
  [BranchStatus.Open]: "Open",
  [BranchStatus.Review]: "In review",
  [BranchStatus.Merged]: "Merged",
  [BranchStatus.Draft]: "Draft",
  [BranchStatus.Blocked]: "Changes requested",
  [BranchStatus.Closed]: "Closed",
};

export const BRANCH_LIST_LAST_ACTIVE_OPTIONS = [
  [BranchListLastActiveRange.WithinLastHour, "Within last hour"],
  [BranchListLastActiveRange.OneToSixHours, "1–6 hours ago"],
  [BranchListLastActiveRange.SevenToTwentyFourHours, "7–24 hours ago"],
  [BranchListLastActiveRange.OneDayOrMore, "1 day or more"],
] as const;

/**
 * The display label for a status the resolved ordering names.
 *
 * A guarded lookup rather than a cast: `BranchStatusOrdering.order` is typed
 * `readonly string[]` because an ordering is free to be derived, and a label map
 * indexed by an unnarrowed string would otherwise need one. Both shipped
 * orderings are permutations of `BranchStatus`, so the fallback is unreachable
 * today; it exists so a future ordering carrying an unlabelled member renders
 * the raw value instead of `undefined`.
 */
function branchStatusLabel(status: string): string {
  return Object.hasOwn(BRANCH_STATUS_LABELS, status)
    ? BRANCH_STATUS_LABELS[status as BranchStatus]
    : status;
}

/**
 * The Pull-request facet's fixed options. Exported beside the Last-active list
 * because the Branch list's SQL page read builds the same facets from counts
 * the database returns and must render this exact copy rather than a second
 * spelling of it.
 */
export const BRANCH_LIST_PULL_REQUEST_OPTIONS = [
  [BranchListPullRequestPresence.Linked, "Linked pull request"],
  [BranchListPullRequestPresence.None, "No pull request"],
] as const;

/** The display label for a status the resolved ordering names. */
export function branchListStatusLabel(status: string): string {
  return branchStatusLabel(status);
}

/**
 * `identityFacetAvailability` and `tagFacetAvailability` expressed over the
 * three tallies a SQL aggregate can return: an all-unavailable population is
 * Unavailable, any non-complete member makes it Incomplete, and an empty
 * population is Complete.
 */
export function branchListFacetAvailabilityFromCounts(
  rows: number,
  nonComplete: number,
  unavailable: number
): BranchListFacetAvailability {
  if (rows > 0 && unavailable === rows) {
    return FacetAvailability.Unavailable;
  }
  return nonComplete > 0
    ? FacetAvailability.Incomplete
    : FacetAvailability.Complete;
}

/**
 * The Repository facet id for a branch whose repository identity is unknown.
 * Exported because the Branch list's SQL page read derives the same column in
 * the database and must emit this exact value, not a second spelling.
 */
export const BRANCH_REPOSITORY_UNKNOWN_LABEL = "\u2014";

/**
 * A repository shows its short name unless two distinct identities share it, in
 * which case both show the full name. Takes the repository values rather than
 * the rows so the SQL page read — which has the distinct values and no rows —
 * calls the same implementation.
 */
export function branchListRepositoryDisplayLabels(
  repositories: readonly string[]
): Map<string, string> {
  const identitiesByShortName = new Map<string, Set<string>>();
  for (const repository of repositories) {
    const shortName = shortRepositoryName(repository);
    const identities =
      identitiesByShortName.get(shortName) ?? new Set<string>();
    identities.add(repository);
    identitiesByShortName.set(shortName, identities);
  }
  return new Map(
    repositories.map((repository) => {
      const shortName = shortRepositoryName(repository);
      return [
        repository,
        (identitiesByShortName.get(shortName)?.size ?? 0) > 1
          ? repository
          : shortName,
      ];
    })
  );
}

function shortRepositoryName(repository: string): string {
  return repository.split("/").filter(Boolean).at(-1) ?? repository;
}
