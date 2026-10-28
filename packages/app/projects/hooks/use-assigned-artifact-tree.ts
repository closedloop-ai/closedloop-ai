"use client";

import type { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { ArtifactGroupByMode } from "@repo/api/src/types/artifact-group-by-mode";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { PriorityFilterValue } from "@repo/api/src/types/priority-filter";
import {
  ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM,
  ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS,
  ASSIGNED_ARTIFACT_TREE_PATH,
  AssignedArtifactTreeParam,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { isRecord } from "@repo/lib/harness/type-guards";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";
import { useApiClient } from "../../shared/api/use-api-client";
import { projectTreeKeys } from "./project-tree-keys";

/**
 * Nested UNDER the canonical project-tree prefix on purpose.
 *
 * The document and artifact-link mutation paths invalidate
 * `projectTreeKeys.all` and nothing else (`documents/hooks/use-artifact-links`,
 * `tags/hooks/use-tags`). A sibling top-level key would sit outside every one
 * of those invalidators, so an edit or a reparent would leave My Tasks stale
 * until an incidental refetch. Nesting means the existing invalidators cover
 * this cache with no second list to keep in sync.
 */
export const assignedArtifactTreeKeys = {
  all: [...projectTreeKeys.all, "assigned"] as const,
  detail: (assigneeId: string) =>
    [...assignedArtifactTreeKeys.all, assigneeId] as const,
  /**
   * ISS-10472: one cache entry PER PAGE.
   *
   * The paging pair has to be in the key. Without it every page writes the same
   * entry, so turning a page serves the previous page's rows from cache until
   * the refetch lands, and going back shows whichever page was fetched last —
   * the cache reproducing the very defect server paging removes. Still nested
   * under `detail`, so the existing `projectTreeKeys.all` invalidators reach
   * every page with no second list to maintain.
   */
  page: (assigneeId: string, request: AssignedTreePageRequest) =>
    [...assignedArtifactTreeKeys.detail(assigneeId), "page", request] as const,
};

/**
 * The route's opt-in anchor facets (ISS-10471), as the browser holds them.
 *
 * Every field narrows the ANCHOR set, so it narrows the population the page is
 * drawn from and the total counted beside it. That is why they belong on the
 * wire rather than in a browser predicate: a filter applied to one page narrows
 * the rows on screen and leaves the footer counting a different set.
 *
 * `status` is the STORED inventory only. The browser's `Unknown` facet value is
 * a render bucket for an off-vocabulary row, not a persisted status, and the
 * route's enum is the same inventory its write bodies accept — so there is
 * nothing to send for it (ISS-10472).
 */
export type AssignedTreeFacets = {
  status?: readonly ArtifactStatus[];
  priority?: readonly PriorityFilterValue[];
  tagId?: readonly string[];
  favoritesOnly?: boolean;
  hideCompletedItems?: boolean;
  /**
   * Resolved instants, never a preset. A preset re-resolved per request moves
   * the window between page 1 and page 2, which skips or duplicates rows — the
   * defect PRD-743 exists to remove, and the reason `ArtifactDateWindow` is
   * specified as absolute bounds.
   */
  dateField?: ArtifactDateField;
  dateFrom?: Date;
  dateTo?: Date;
};

/**
 * A PAGED read's options. `search` and `grouping` live here, not beside
 * `paging`, because neither reaches the wire without it: the request descriptor
 * is only built when `paging` is present, so `{ search }` alone used to return
 * unfiltered rows under a key that did not mention the term — silently, with no
 * error (marisolashgrove, PR #9026). Requiring `paging` in the TYPE is what makes
 * that unsayable rather than merely wrong.
 */
type AssignedArtifactTreePagedOptions = {
  enabled?: boolean;
  /** Request one page of ROOT GROUPS. */
  paging: { limit: number; offset: number };
  /**
   * Narrow the anchors server-side. Part of the cache key for the same reason
   * `paging` is: a different selection is a different result set.
   */
  facets?: AssignedTreeFacets;
  /**
   * Case-insensitive substring over title or slug, applied by the SERVER.
   *
   * It has to be server-side once the board pages server-side: filtering one
   * page in the browser would search the rows on screen rather than the
   * assignee's work, so the box would stop finding rows the reader knows exist
   * (ISS-10472, operator ruling 2026-10-19). It is part of the cache key for
   * the same reason `paging` is — a term change is a different result set, not
   * a view of the same one.
   */
  search?: string;
  /**
   * Section a GROUPED board and ask for one PAGE of sections (ISS-10472).
   *
   * Mutually exclusive with `paging.offset` on the wire, and the route rejects
   * the pair: a grouped page is variable-height because whole sections stay
   * together, so a row offset names nothing. `paging.limit` is still the page
   * SIZE either way.
   */
  grouping?: { groupBy: ArtifactGroupByMode; pageIndex: number };
};

/** The UNPAGED read: the whole tree, which is what every caller got before. */
type AssignedArtifactTreeUnpagedOptions = {
  enabled?: boolean;
  paging?: never;
  search?: never;
  grouping?: never;
  facets?: never;
};

type AssignedArtifactTreeOptions =
  | AssignedArtifactTreePagedOptions
  | AssignedArtifactTreeUnpagedOptions;

/**
 * Everything that makes one page a DIFFERENT result set rather than another
 * view of the same one, and therefore everything the cache must key on.
 *
 * A descriptor rather than positional arguments because this list has grown
 * twice already (search, then grouping) and a forgotten argument does not fail
 * to compile — it silently serves one page's rows under another page's key,
 * which is the defect server paging exists to remove.
 */
export type AssignedTreePageRequest = {
  limit: number;
  offset?: number;
  search: string;
  groupBy?: ArtifactGroupByMode;
  pageIndex?: number;
  facets?: AssignedTreeFacets;
};

/**
 * Runtime shape guard for the tree payload.
 *
 * The API client returns parsed JSON without checking it, so a 200 carrying
 * `data: {}` (a deploy skew, a proxy that swallowed the body, a route that
 * changed shape) would otherwise be cached as a `ProjectTreeResponse` and
 * crash the board on `treeData.nodes.filter`. This validates the STRUCTURE the
 * consumer actually walks — the arrays and their node shape — and deliberately
 * leaves the artifact bodies loose: they are owned by the API contract, and a
 * strict re-declaration here would reject additive server fields, which is
 * exactly the version-skew failure the repo's cross-repo rule forbids.
 */
const treeNodeSchema = z.looseObject({
  root: z.looseObject({ id: z.string() }),
  children: z.array(z.looseObject({ id: z.string() })),
});

const assignedArtifactTreeSchema = z.looseObject({
  nodes: z.array(treeNodeSchema),
  externalParents: z.array(z.looseObject({ childId: z.string() })),
  /**
   * Optional because an UNPAGED read omits it. A consumer that finds no `page`
   * on a response it asked to be paged is holding the complete tree, not page
   * zero of it.
   *
   * NOT a version-skew tolerance. An API that predates ISS-10472 answers a
   * paged request with a 400, not the whole tree: its query schema is
   * `.strict()` and has no `limit`, `offset`, `search`, `groupBy` or
   * `pageIndex`, so an `apps/app` bundle that deploys ahead of the API ERRORS
   * the board rather than degrading to an unpaged one (marisolashgrove, PR #9026).
   * Whoever wires `page.tsx` to the server-paged read owns that window.
   */
  page: z
    .looseObject({
      /**
       * ROW-paged only, so it is optional for the same reason the section-paged
       * fields below are. A section-paged page is variable-height — whole
       * groups stay together — so it has no row offset to report and the route
       * OMITS this field (`project-tree.ts` declares it `offset?: number` and
       * says so). Declaring it required made the schema reject every grouped
       * 200: the parse threw inside the queryFn, the query landed in `isError`,
       * and turning on Group by broke the board outright (ISS-10472).
       */
      offset: z.number().optional(),
      limit: z.number(),
      total: z.number(),
      /**
       * Section-paged only, so each stays optional — an ungrouped page omits
       * them, and so does a server that predates them.
       */
      totalPages: z.number().optional(),
      rowsBefore: z.number().optional(),
      ordering: z.string().optional(),
      sections: z
        .array(
          z.looseObject({
            rootIds: z.array(z.string()),
            total: z.number(),
            continued: z.boolean(),
          })
        )
        .optional(),
    })
    .optional(),
});

/**
 * Fetch one assignee's merged, org-scoped artifact tree in a SINGLE request
 * (FEA-1651, parent FEA-908; flagged by whitlockk in the PR #1077 review).
 *
 * The server resolves the anchors, walks the graph, and merges the result, so
 * this hook is one `useQuery` over `GET /artifacts/assigned-tree` however many
 * projects the assignee has work in.
 *
 * WHAT THE PAYLOAD CONTAINS — `ProjectTreeResponse` is the shape, but it is a
 * NARROWER corpus than `GET /projects/:id/tree` returns for the same user, and
 * this is the line to read before treating the two as interchangeable. The
 * per-project read returns every artifact in a project; this endpoint returns
 * the artifacts assigned to the user, excluding sessions and branches
 * (ISS-12251 D-5, ISS-12463), plus each anchor's parent chain and its
 * descendants. Other people's unrelated artifacts in the same project are NOT
 * included.
 *
 * The response may also carry `truncation` when the server hit one of its
 * bounds; a tree WITHOUT that field is a claim of completeness, and consumers
 * must not present a truncated tree as a complete one.
 *
 * @param assigneeId - User whose work anchors the tree. A null or empty value
 *   disables the read (there is nothing to scope it to).
 * @param options.enabled - When false, no fetch is issued and `data` is null.
 *   Defaults to true. Used to defer the read until the consuming panel is
 *   actually visible (per `apps/app/AGENTS.md` on-mount fetch convention).
 */
export function useAssignedArtifactTree(
  assigneeId: string | null | undefined,
  options?: AssignedArtifactTreeOptions
): {
  data: ProjectTreeResponse | null;
  isLoading: boolean;
  isError: boolean;
  /**
   * Re-run this read. Exposed so a consumer's "Try again" can retry the tree
   * stream it actually failed on, rather than only the reads it happens to hold
   * a refetch for.
   */
  refetch: () => void;
} {
  const apiClient = useApiClient();
  const enabled = options?.enabled !== false && Boolean(assigneeId);
  const resolvedAssigneeId = assigneeId ?? "";
  const paging = options?.paging;
  const grouping = options?.grouping;
  // Trimmed here as well as on the route so an incidental space does not open a
  // second cache entry for the same search.
  const search = options?.search?.trim() ?? "";
  const isGrouped =
    grouping !== undefined && grouping.groupBy !== ArtifactGroupByMode.None;
  const pageRequest: AssignedTreePageRequest | undefined = paging
    ? {
        limit: paging.limit,
        search,
        ...(options?.facets ? { facets: cappedFacets(options.facets) } : {}),
        // A grouped read pages by SECTION, so it carries a page index and no
        // row offset. Sending both is a 400 rather than a guess.
        ...(isGrouped
          ? { groupBy: grouping.groupBy, pageIndex: grouping.pageIndex }
          : { offset: paging.offset }),
      }
    : undefined;

  const query = useQuery({
    queryKey: pageRequest
      ? assignedArtifactTreeKeys.page(resolvedAssigneeId, pageRequest)
      : assignedArtifactTreeKeys.detail(resolvedAssigneeId),
    queryFn: async () => {
      const response = await apiClient.get<ProjectTreeResponse>(
        assignedArtifactTreePath(resolvedAssigneeId, pageRequest)
      );
      // Throwing here puts the query into `isError`, which the board already
      // renders as a load failure — a malformed 200 must surface as an error,
      // not be cached and crash the render downstream.
      assignedArtifactTreeSchema.parse(response);
      return response;
    },
    enabled,
    ...(pageRequest
      ? { placeholderData: keepSamePopulationPlaceholder(pageRequest) }
      : {}),
  });

  const { refetch } = query;
  const refetchTree = useCallback(() => {
    refetch().catch(() => {
      // The retried query records its own error state; this catch only stops
      // the refetch rejection surfacing as an unhandled rejection.
    });
  }, [refetch]);

  return {
    data: enabled ? (query.data ?? null) : null,
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError,
    refetch: refetchTree,
  };
}

export function assignedArtifactTreePath(
  assigneeId: string,
  request?: AssignedTreePageRequest
): string {
  const params = new URLSearchParams({
    [ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM]: assigneeId,
  });
  if (request === undefined) {
    return `${ASSIGNED_ARTIFACT_TREE_PATH}?${params.toString()}`;
  }
  const term = request.search.trim();
  if (term) {
    params.set(AssignedArtifactTreeParam.Search, term);
  }
  // `limit` is what selects the server's paged derivation at all; an offset or
  // a page index without it indexes into an unbounded result.
  params.set(AssignedArtifactTreeParam.Limit, String(request.limit));
  if (request.groupBy === undefined) {
    params.set(AssignedArtifactTreeParam.Offset, String(request.offset ?? 0));
  } else {
    params.set(AssignedArtifactTreeParam.GroupBy, request.groupBy);
    params.set(
      AssignedArtifactTreeParam.PageIndex,
      String(request.pageIndex ?? 0)
    );
  }
  appendFacetParams(params, request.facets);
  return `${ASSIGNED_ARTIFACT_TREE_PATH}?${params.toString()}`;
}

/**
 * The facets, each repeated once per value (`?status=TODO&status=DONE`).
 *
 * The repeated shape is what the route parses and what `apps/api/AGENTS.md`
 * requires of a new multi-value parameter; a comma-joined list would arrive as
 * one unparseable element. An empty array appends nothing rather than an empty
 * occurrence, which the route rejects as a value that failed to spell itself.
 */
function appendFacetParams(
  params: URLSearchParams,
  facets: AssignedTreeFacets | undefined
): void {
  if (!facets) {
    return;
  }
  for (const status of facets.status ?? []) {
    params.append(AssignedArtifactTreeParam.Status, status);
  }
  for (const priority of facets.priority ?? []) {
    params.append(AssignedArtifactTreeParam.Priority, priority);
  }
  for (const tagId of facets.tagId ?? []) {
    params.append(AssignedArtifactTreeParam.TagId, tagId);
  }
  // Only ever sent as "true": the route documents `false` as narrowing nothing,
  // which is what omission already says.
  if (facets.favoritesOnly) {
    params.set(AssignedArtifactTreeParam.FavoritesOnly, "true");
  }
  if (facets.hideCompletedItems) {
    params.set(AssignedArtifactTreeParam.HideCompletedItems, "true");
  }
  // The window goes on the wire only when it is COMPLETE. The route reads the
  // three independently, so a field with one bound would narrow on an end the
  // caller never chose.
  if (facets.dateField && facets.dateFrom && facets.dateTo) {
    params.set(AssignedArtifactTreeParam.DateField, facets.dateField);
    params.set(
      AssignedArtifactTreeParam.DateFrom,
      facets.dateFrom.toISOString()
    );
    params.set(AssignedArtifactTreeParam.DateTo, facets.dateTo.toISOString());
  }
}

/**
 * Keep the previous page mounted while the next one loads — but ONLY across a
 * page turn (ISS-10472).
 *
 * Without a placeholder, turning a page changes the query key, the tree read
 * reports `isLoading`, and the board's `isTotalSettled` goes false — which
 * unmounts the footer, taking the pagination control the user just clicked,
 * and drops `DocumentsView` past its skeleton into the empty state. The
 * sibling `/documents` read carries `keepSamePageSizePlaceholder` for exactly
 * this reason.
 *
 * SCOPED, not a bare `(previous) => previous`: the previous page is only an
 * honest stand-in when it was drawn from the same POPULATION. Every field
 * except the page coordinate has to match, because reusing a page across a
 * facet, search or grouping change would render the old narrowing's rows under
 * a footer about to state a different total — the footer-versus-rows
 * disagreement this slice exists to remove.
 */
function keepSamePopulationPlaceholder(
  request: AssignedTreePageRequest
): (
  previous: ProjectTreeResponse | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined
) => ProjectTreeResponse | undefined {
  return (previous, previousQuery) => {
    if (!previous) {
      return undefined;
    }
    const previousRequest = previousQuery?.queryKey.at(-1);
    if (!isRecord(previousRequest)) {
      return undefined;
    }
    const samePopulation =
      previousRequest.limit === request.limit &&
      previousRequest.search === request.search &&
      previousRequest.groupBy === request.groupBy &&
      JSON.stringify(previousRequest.facets ?? null) ===
        JSON.stringify(request.facets ?? null);
    return samePopulation ? previous : undefined;
  };
}

/**
 * The facets with `tagId` held to the bound the route states.
 *
 * Past that bound the route answers 400, which on the server-paged board is the
 * load-failed state — a persisted selection wider than the cap would take the
 * whole board down rather than narrow it (marisolashgrove, PR #9091). Normalized
 * into the page REQUEST rather than at the URL, so the cache key and the wire
 * describe the same read.
 */
function cappedFacets(facets: AssignedTreeFacets): AssignedTreeFacets {
  const tagId = facets.tagId;
  if (!tagId || tagId.length <= ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS) {
    return facets;
  }
  return {
    ...facets,
    tagId: tagId.slice(0, ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS),
  };
}
