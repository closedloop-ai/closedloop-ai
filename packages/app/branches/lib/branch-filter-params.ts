import {
  BRANCH_LOC_MAX_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
  BranchSessionPresence,
} from "@repo/api/src/types/branch";
import {
  type FacetFilterParamMap,
  parseFacetFilterParams,
  writeFacetFilterParams,
} from "../../shared/lib/facet-filter-params";
import {
  type BranchFilters,
  clampBranchLocRange,
  DEFAULT_BRANCH_FILTERS,
} from "./branch-row";

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
  sessionPresence: [],
};

/**
 * Parses the Branches facet selections from list-URL search params. Returns
 * `DEFAULT_BRANCH_FILTERS` (the same object) when no filter param is present.
 */
export function parseBranchFilterParams(
  params: Pick<URLSearchParams, "getAll">
): BranchFilters {
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
    max === undefined
  ) {
    return DEFAULT_BRANCH_FILTERS;
  }
  return { ...facets, sessionPresence, locMin: min, locMax: max };
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
    sessionPresence: filters.sessionPresence,
  };
  writeFacetFilterParams(params, facetFilters, BRANCH_FILTER_PARAMS);
  writeNumberParam(params, BRANCH_LOC_MIN_PARAM, filters.locMin);
  writeNumberParam(params, BRANCH_LOC_MAX_PARAM, filters.locMax);
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
