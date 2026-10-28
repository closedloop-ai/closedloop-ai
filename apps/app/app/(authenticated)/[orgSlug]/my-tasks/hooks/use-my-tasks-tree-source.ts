"use client";

import {
  type ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import type {
  ProjectTreeResponse,
  TreeRootSection,
} from "@repo/api/src/types/project-tree";
import {
  type AssignedTreeFacets,
  useAssignedArtifactTree,
} from "@repo/app/projects/hooks/use-assigned-artifact-tree";
import { useMemo } from "react";
import { pruneBranchSubtrees } from "../lib/prune-branch-subtrees";

type MyTasksTreeSourceParams = {
  assigneeId: string | null;
  isListView: boolean;
  /**
   * Whether the flag deciding this read's PARAMS has resolved (FEA-1626).
   *
   * Held for the same reason the documents read is: with the recency window on,
   * an unresolved flag means the first request carries no date facet and the
   * resolved one carries it — a different cache key, so the reader pays for a
   * full assigned-tree walk that is then thrown away and watches the rows
   * change under them. The tree walk is the more expensive of the two reads.
   */
  isFacetFlagReady?: boolean;
  /**
   * One page of root groups, or omitted for the whole tree.
   *
   * `limit` is the page SIZE in both shapes; `offset` is read only when the
   * board is ungrouped.
   */
  paging?: { limit: number; offset: number };
  /** The typed term, applied by the server across the whole assigned set. */
  search?: string;
  /**
   * The facet selection, applied by the server to the ANCHORS (ISS-10471).
   *
   * Server-side for the same reason `search` is, and with a sharper
   * consequence: a facet narrows the population the total is counted over, so a
   * browser predicate would leave the footer counting rows the board is not
   * showing.
   */
  facets?: AssignedTreeFacets;
  /**
   * Section a grouped board server-side and ask for one page of SECTIONS
   * (ISS-10472, operator ruling 2026-10-20).
   *
   * An earlier reading of this slice kept a grouped board UNPAGED so section
   * totals could be counted across the full set in the browser. That was
   * reversed on measurement: the unpaged read is still capped at
   * `MAX_TREE_ANCHORS`, so staying unpaged would have kept the unreachable-row
   * defect for anyone who turns grouping on — and grouping is opt-in but
   * persisted, so they would have stayed there. The server counts the sections
   * instead and sends each one's whole size.
   */
  grouping?: { groupBy: ArtifactGroupByMode; pageIndex: number };
};

export type MyTasksTreeSource = {
  treeData: ProjectTreeResponse | null;
  /**
   * Exact count of root groups behind the current predicate, or null when this
   * read was not paged. Null is "the server did not count", NEVER zero — the
   * footer must not read an unpaged tree as an empty one.
   */
  treeTotal: number | null;
  /**
   * The sections on this page, in render order, or null when the read was not
   * section-paged.
   *
   * Each carries its member ROOT IDS rather than a section key: the renderer
   * derives `GroupSectionDescriptor.key` from the rows itself, and a key
   * spelled on the wire too would be a second spelling that could drift. The
   * consumer maps a section to its key through a row it holds.
   */
  treeSections: TreeRootSection[] | null;
  /**
   * Pages the server laid the whole set into, or null when the read was not
   * section-paged. Variable-height, so it cannot be derived from a total and a
   * page size.
   */
  treeTotalPages: number | null;
  /**
   * Rows on every earlier page, or null when the read was not section-paged.
   * The footer's range anchors on this rather than on `pageIndex * pageSize`,
   * which a variable-height page makes a window nothing returned.
   */
  treeRowsBefore: number | null;
  /**
   * The ROW offset of this page's first root, or null when the read was not
   * row-paged. It is what a row-paged read anchors its range on, the way
   * `treeRowsBefore` does for a section-paged one — the field means a row
   * offset and only that (ISS-10472, marisolashgrove PR #9026).
   */
  treeRowOffset: number | null;
  /**
   * The page SIZE the server applied, after its own clamp, or null when the
   * read was not paged. Read off the response rather than from the request, so
   * a clamped `limit` does not leave the client dividing by a size the page was
   * not drawn at.
   */
  treePageSize: number | null;
  /**
   * The section ordering the response NAMED, or null when it named none.
   *
   * The consumer keys its sections with this rather than re-deciding from its
   * own PostHog gates: the server packed the page in the ordering it names, and
   * the two can disagree (ISS-10472, operator ruling 2026-10-20).
   */
  treeSectionOrdering: ArtifactSectionOrdering | null;
  isTreeLoading: boolean;
  isTreeError: boolean;
  /** Refetch the read this source drives. */
  refetchTree: () => void;
};

/**
 * Resolve the My Tasks list-view tree from the single
 * `GET /artifacts/assigned-tree` read, pruned of branch subtrees.
 *
 * WHAT IS ON THE BOARD, because the endpoint decides it and nothing downstream
 * can widen it: the signed-in user's own assigned artifacts, each one's parent
 * chain, and its descendants. The retired per-project fan-out returned every
 * artifact in every project the user was assigned in, so rows owned by OTHER
 * PEOPLE used to reach this board and no longer do — a change to what the user
 * sees, not an internal one (FEA-1651, ISS-12637).
 */
export function useMyTasksTreeSource({
  assigneeId,
  facets,
  isFacetFlagReady = true,
  grouping,
  isListView,
  paging,
  search,
}: MyTasksTreeSourceParams): MyTasksTreeSource {
  // Branched because the hook's options REQUIRE `paging` alongside `search` and
  // `grouping`: neither reaches the wire without it, so the type refuses the
  // pair rather than dropping the term silently (marisolashgrove, PR #9026).
  const enabled = isListView && isFacetFlagReady;
  const assignedArtifactTree = useAssignedArtifactTree(
    assigneeId,
    paging ? { enabled, facets, grouping, paging, search } : { enabled }
  );

  // Branches are not tasks (ISS-12463), and the endpoint's downward walk still
  // materializes one hanging off an assigned issue. The walk is kept because it
  // is also what produces PRD to Plan to Issue nesting, so the assembled tree
  // is pruned rather than the walk cut.
  const treeData = useMemo(
    () => pruneBranchSubtrees(assignedArtifactTree.data),
    [assignedArtifactTree.data]
  );

  return {
    treeData,
    // Read off the RESPONSE, not off `paging`: a server that predates ISS-10472
    // answers a paged request by ignoring the parameters and returning the
    // whole tree, and reporting a total it never sent would be a fabricated
    // number.
    treeTotal: assignedArtifactTree.data?.page?.total ?? null,
    // Also read off the RESPONSE: a server that predates section paging answers
    // a grouped request by ignoring `groupBy` entirely, and a section list the
    // caller inferred from its own request would describe sections that read
    // never drew.
    treeSections: assignedArtifactTree.data?.page?.sections ?? null,
    treeTotalPages: assignedArtifactTree.data?.page?.totalPages ?? null,
    treeRowsBefore: assignedArtifactTree.data?.page?.rowsBefore ?? null,
    treeRowOffset: assignedArtifactTree.data?.page?.offset ?? null,
    treePageSize: assignedArtifactTree.data?.page?.limit ?? null,
    // Narrowed rather than cast: the wire schema decodes `ordering` as a bare
    // string so an unknown spelling from a newer server cannot reject the whole
    // payload, and a spelling this bundle does not know must fall through to
    // the browser's own resolution rather than key sections on nothing.
    treeSectionOrdering: resolveNamedOrdering(
      assignedArtifactTree.data?.page?.ordering
    ),
    isTreeLoading: assignedArtifactTree.isLoading,
    isTreeError: assignedArtifactTree.isError,
    refetchTree: assignedArtifactTree.refetch,
  };
}

/** One of the three named orderings, or null for absent and unrecognized. */
function resolveNamedOrdering(
  named: string | undefined
): ArtifactSectionOrdering | null {
  return (
    Object.values(ArtifactSectionOrdering).find((value) => value === named) ??
    null
  );
}
