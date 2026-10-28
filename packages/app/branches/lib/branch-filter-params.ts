import {
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
  BranchSessionPresence,
} from "@repo/api/src/types/branch";
import type { TableCollapsedGroups } from "@repo/app/shared/lib/table-collapsed-groups";
import {
  readTableGroupViewParams,
  writeTableGroupViewParams,
} from "@repo/app/shared/lib/table-group-view-params";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import {
  type FacetFilterParamMap,
  parseFacetFilterParams,
  writeFacetFilterParams,
} from "../../shared/lib/facet-filter-params";
import { BRANCH_GROUP_FIELDS } from "./branch-column-view-model";
import {
  type BranchFilters,
  clampBranchLocRange,
  DEFAULT_BRANCH_FILTERS,
} from "./branch-row";

export const BRANCH_PAGE_PARAM = "page";
export const BRANCH_SEARCH_PARAM = "search";
export const BRANCH_PAGE_SIZE_PARAM = "pageSize";

/** The multi-select (string[]) subset of `BranchFilters` the generic facet codec drives. */
type BranchFacetFilters = Pick<
  BranchFilters,
  | "names"
  | "statuses"
  | "owners"
  | "collaborators"
  | "repos"
  | "pullRequests"
  | "lastActiveRanges"
  | "tags"
  | "priorities"
  | "sessionPresence"
>;

/**
 * URL param name per multi-select Branches facet (FEA-3560 / FEA-4003). The
 * list URL mirrors the active facet selections so a detail→back (or reload /
 * shared link) restores the filtered view. `github` (connect-return status) is
 * owned by the page, so names here must stay disjoint from it. The LOC-range
 * bounds are scalar params handled separately below.
 */
export const BRANCH_FILTER_PARAMS = {
  names: "branch",
  statuses: "status",
  owners: "owner",
  collaborators: "collaborator",
  repos: "repo",
  pullRequests: "pullRequest",
  lastActiveRanges: "lastActive",
  tags: "tag",
  priorities: "priority",
  sessionPresence: BRANCH_SESSION_PRESENCE_PARAM,
} as const satisfies FacetFilterParamMap<BranchFacetFilters>;

const FACET_DEFAULTS: BranchFacetFilters = {
  names: [],
  statuses: [],
  owners: [],
  collaborators: [],
  repos: [],
  pullRequests: [],
  lastActiveRanges: [],
  tags: [],
  priorities: [],
  sessionPresence: [],
};

/**
 * Parses the Branches facet selections from list-URL search params. Returns
 * `DEFAULT_BRANCH_FILTERS` (the same object) when no filter param is present.
 */
export function parseBranchFilterParams(
  params: Pick<URLSearchParams, "getAll">
): BranchFilters {
  const search = params.getAll(BRANCH_SEARCH_PARAM).at(0)?.trim() || undefined;
  const facets = parseFacetFilterParams(
    params,
    FACET_DEFAULTS,
    BRANCH_FILTER_PARAMS
  );
  const { min, max } = clampBranchLocRange({
    min: parseNumberParam(params, BRANCH_LOC_MIN_PARAM),
    max: parseNumberParam(params, BRANCH_LOC_MAX_PARAM),
  });
  const sessionPresence = facets.sessionPresence.filter(
    isBranchSessionPresence
  );
  // No filter param present at all → the shared default object (referential
  // no-change checks in the seed path keep working).
  if (
    facets === FACET_DEFAULTS &&
    sessionPresence.length === 0 &&
    min === undefined &&
    max === undefined &&
    search === undefined
  ) {
    return DEFAULT_BRANCH_FILTERS;
  }
  return {
    ...facets,
    sessionPresence,
    locMin: min,
    locMax: max,
    ...(search === undefined ? {} : { search }),
  };
}

/** Remove facet identities that belong to the other gated List contract. */
export function normalizeBranchFiltersForMode(
  filters: BranchFilters,
  approved: boolean
): BranchFilters {
  if (approved) {
    return {
      ...filters,
      sessionPresence: [],
    };
  }
  return {
    ...filters,
    names: [],
    owners: filters.owners.filter((owner) => !owner.includes(":")),
    collaborators: [],
    repos: filters.repos.filter((repo) => !repo.includes("/")),
    pullRequests: [],
    lastActiveRanges: [],
    tags: [],
    priorities: [],
  };
}

/** Narrows a raw facet value to a supported legacy session-presence value. */
function isBranchSessionPresence(
  value: string
): value is BranchSessionPresence {
  return (
    value === BranchSessionPresence.Has || value === BranchSessionPresence.None
  );
}

/**
 * Writes the Branches facet selections into `params` (deleting params for
 * empty facets / unset bounds so the default view keeps a clean URL).
 */
export function writeBranchFilterParams(
  params: URLSearchParams,
  filters: BranchFilters
): void {
  // Hand the codec only the multi-select facets it drives — the numeric LOC
  // bounds are scalar params written below and must not leak into the generic
  // `Record<string, string[]>` facet writer.
  const facetFilters: BranchFacetFilters = {
    names: filters.names,
    statuses: filters.statuses,
    owners: filters.owners,
    collaborators: filters.collaborators,
    repos: filters.repos,
    pullRequests: filters.pullRequests,
    lastActiveRanges: filters.lastActiveRanges,
    tags: filters.tags,
    priorities: filters.priorities,
    sessionPresence: filters.sessionPresence,
  };
  writeFacetFilterParams(params, facetFilters, BRANCH_FILTER_PARAMS);
  writeNumberParam(params, BRANCH_LOC_MIN_PARAM, filters.locMin);
  writeNumberParam(params, BRANCH_LOC_MAX_PARAM, filters.locMax);
  // Only a filter set that states a term (possibly `""`) owns the param, so a
  // host that never states one leaves a `?search=` link alone (ISS-13035).
  if ("search" in filters) {
    params.delete(BRANCH_SEARCH_PARAM);
    if (filters.search) {
      params.set(BRANCH_SEARCH_PARAM, filters.search);
    }
  }
}

/** Parse the one-based bookmarked page into a zero-based index. */
export function parseBranchPageParam(
  params: Pick<URLSearchParams, "getAll">
): number {
  const raw = params.getAll(BRANCH_PAGE_PARAM).at(0);
  const page = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(page) && page > 0 ? page - 1 : 0;
}

/**
 * Default page size for the Branches table. Raised from the scaffold's 5 to 25
 * now that the list is wired to the real local branch corpus (FEA-1948 / B2).
 *
 * ISS-10301: with the v1 shell gone this is the ONLY page size a fresh Branches
 * view reads at, so a suite asserting the first request's `limit` has to name
 * this operand. It lives HERE rather than beside the hook that defaults to it
 * because the Playwright specs that must name it cannot import a `"use client"`
 * hooks module into the node runtime (`e2e/AGENTS.md`), and a number re-typed in
 * a spec is the SSOT drift this repo keeps paying for. The fixed
 * `APPROVED_BRANCH_PAGE_SIZE` of 20 that used to sit beside it was the v1 shell's
 * only size and retired with it.
 */
export const BRANCH_PAGE_SIZE = 25;

/** Parse a supported Branches rows-per-page value, falling back when absent or invalid. */
export function parseBranchPageSizeParam(
  params: Pick<URLSearchParams, "getAll">,
  allowedPageSizes: readonly number[],
  fallbackPageSize: number
): number {
  const raw = params.getAll(BRANCH_PAGE_SIZE_PARAM).at(0);
  const pageSize = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(pageSize) && allowedPageSizes.includes(pageSize)
    ? pageSize
    : fallbackPageSize;
}

/**
 * ISS-9692: whether the URL STATES a rows-per-page, as opposed to falling back.
 *
 * `parseBranchPageSizeParam` cannot answer this — an explicit `?pageSize=25` and
 * an absent param both return 25 — and the saved-view adoption needs the
 * difference, because adopting over an explicit param would make a shared link
 * page differently for whoever opens it.
 */
export function hasBranchPageSizeParam(
  params: Pick<URLSearchParams, "getAll">
): boolean {
  return params.getAll(BRANCH_PAGE_SIZE_PARAM).at(0) !== undefined;
}

/** Persist a clean one-based page, omitting the default first page. */
export function writeBranchPageParam(
  params: URLSearchParams,
  pageIndex: number
): void {
  params.delete(BRANCH_PAGE_PARAM);
  if (pageIndex > 0) {
    params.set(BRANCH_PAGE_PARAM, String(pageIndex + 1));
  }
}

/** Persist rows-per-page only when it differs from the selected default. */
export function writeBranchPageSizeParam(
  params: URLSearchParams,
  pageSize: number,
  defaultPageSize: number
): void {
  params.delete(BRANCH_PAGE_SIZE_PARAM);
  if (pageSize !== defaultPageSize) {
    params.set(BRANCH_PAGE_SIZE_PARAM, String(pageSize));
  }
}

/** Reads a single scalar numeric query param (first value; empty/NaN ⇒ undefined). */
function parseNumberParam(
  params: Pick<URLSearchParams, "getAll">,
  name: string
): number | undefined {
  const raw = params.getAll(name).at(0);
  if (raw === undefined || raw.trim() === "") {
    return;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Writes (or deletes when unset) a single scalar numeric query param. */
function writeNumberParam(
  params: URLSearchParams,
  name: string,
  value: number | undefined
): void {
  params.delete(name);
  if (value !== undefined) {
    params.set(name, String(value));
  }
}

/** A grouping axis and its collapsed bands, as a Branches link states them. */
export type BranchGroupViewParams = {
  grouping: TableGroupingState;
  collapsedGroups: TableCollapsedGroups;
};

/**
 * ISS-9582: the grouping and collapse state a Branches link states, or `null`
 * when it states none this build can honour.
 *
 * `null` covers junk too — an unknown field, an order this build cannot spell,
 * more than two levels, one field twice — so the reader lands on their stored
 * view rather than on a half-applied link. `collapsed` is only read under a
 * valid `group`: a band key means nothing without the axis that cut it. A
 * collapsed key naming no band is kept here and simply never matches one.
 *
 * A valid `group` with no `collapsed` states "every band open" for that axis,
 * which is what the writer below emits for a view with nothing collapsed.
 */
export function parseBranchGroupViewParams(
  params: Pick<URLSearchParams, "getAll">
): BranchGroupViewParams | null {
  return readTableGroupViewParams(params, (field) =>
    Object.hasOwn(BRANCH_GROUP_FIELDS, field)
  );
}

/**
 * ISS-9582: write the grouping axis and the bands collapsed under it. Both
 * params are removed for an ungrouped view, and `collapsed` is removed when
 * nothing is collapsed, so the default view keeps a clean URL. Only the ACTIVE
 * axis is written: a link describes the view on screen, not every axis the
 * reader ever collapsed a band under.
 */
export function writeBranchGroupViewParams(
  params: URLSearchParams,
  grouping: TableGroupingState,
  collapsedGroups: Readonly<TableCollapsedGroups>
): void {
  writeTableGroupViewParams(params, grouping, collapsedGroups);
}

/**
 * Drop a Tags selection a host whose source cannot serve `tags` must not apply.
 *
 * ISS-12456 (Cosimo Corrigan, 2026-10-14): "In single-user mode, rows should not
 * be filtered by tags." Such a host also offers no Tags facet, so a selection
 * restored from a saved view (FEA-4180) or carried by a link would narrow the
 * corpus with no affordance left to clear it. Dropped from the filter STATE
 * rather than at the row predicate so the active-filter readout, the URL, and
 * the server request agree with the rows on screen.
 *
 * Identity is preserved when there is nothing to drop, for the referential
 * no-change checks the seed path relies on.
 */
export function withoutUnsupportedBranchTagFilter(
  filters: BranchFilters,
  tagsSupported: boolean
): BranchFilters {
  if (tagsSupported || filters.tags.length === 0) {
    return filters;
  }
  return { ...filters, tags: [] };
}
