import { LinkType } from "@repo/api/src/types/artifact";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import { type ArtifactLink, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";
import {
  type ArtifactWithAssignee,
  normalizeArtifactRowSubtype,
} from "./artifact-tree-shared";

/**
 * Hard bound on how far a chain is walked, in EITHER direction.
 *
 * `artifact_links` is a user-writable graph: it can contain a cycle
 * (A produces B produces A) or a pathologically deep chain, and neither may
 * turn this read into an unbounded loop. A walk that is still producing new
 * rows at this bound reports {@link TreeTruncationReason.DepthCap} rather than
 * letting the caller present a mid-chain node as a root.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * Hard bound on how many artifacts one response may materialize, across both
 * walks. Depth alone does not bound a wide graph — a single branch can produce
 * hundreds of sessions — so breadth needs its own ceiling (wongk, PR #4461).
 */
export const MAX_TREE_NODES = 2000;

/**
 * Ids per `IN (...)` predicate.
 *
 * PostgreSQL's bind-parameter limit is 65,535 and Prisma binds one parameter
 * per element, so an uncapped frontier eventually fails the whole query with a
 * 500. Every frontier predicate in this module goes through
 * {@link chunkIds}; none of them takes the caller's array directly.
 */
export const ID_CHUNK_SIZE = 500;

/** A declared PRODUCES edge from a child artifact up to one of its parents. */
export type ParentEdge = { parentId: string; linkType: LinkType };

export type GraphWalkResult = {
  /** Parent edges keyed by CHILD id, every declared edge preserved. */
  parentEdges: Map<string, ParentEdge[]>;
  /** Bounds that actually bound during the walk. Empty on a complete walk. */
  reasons: TreeTruncationReason[];
};

/**
 * Split ids into bind-safe chunks. Returns `[]` for an empty input so callers
 * issue no query at all rather than one that matches nothing.
 */
export function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += ID_CHUNK_SIZE) {
    chunks.push(ids.slice(start, start + ID_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Load artifacts by id, chunked, org-scoped, into `artifactsById`.
 *
 * Org scoping lives in the `where` of every hop — a parent or child chain is
 * exactly how a cross-organization row could otherwise be pulled in. A row
 * outside the caller's organization simply does not come back and the chain
 * ends there.
 *
 * Returns the ids that actually loaded, in query order, stopping once
 * `artifactsById` reaches {@link MAX_TREE_NODES}.
 */
export async function loadArtifactsById(
  organizationId: string,
  ids: string[],
  artifactsById: Map<string, ArtifactWithAssignee>
): Promise<{ loadedIds: string[]; hitNodeBudget: boolean }> {
  const loadedIds: string[] = [];
  for (const chunk of chunkIds(ids)) {
    if (artifactsById.size >= MAX_TREE_NODES) {
      return { loadedIds, hitNodeBudget: true };
    }
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: { id: { in: chunk }, organizationId },
        include: { assignee: basicUserSelect },
      })
    );
    for (const row of rows) {
      if (artifactsById.size >= MAX_TREE_NODES && !artifactsById.has(row.id)) {
        return { loadedIds, hitNodeBudget: true };
      }
      artifactsById.set(row.id, normalizeArtifactRowSubtype(row));
      loadedIds.push(row.id);
    }
  }
  return { loadedIds, hitNodeBudget: false };
}

/**
 * Walk every anchor's parent chain upward, one DEPTH LEVEL at a time.
 *
 * Each level issues one chunked link query plus one chunked artifact query for
 * the entire frontier, so resolving N anchors costs `O(depth)` round trips
 * rather than `O(N)`. Mutates `artifactsById` with every ancestor it loads.
 *
 * EVERY declared PRODUCES edge is recorded, not just the first: the data model
 * allows an artifact to have several PRODUCES parents, and keeping only one
 * edge here would hide a valid chain or drop a cross-project link before the
 * assembly phase can see it (wongk, PR #4461).
 */
export async function collectAncestors(
  organizationId: string,
  artifactsById: Map<string, ArtifactWithAssignee>,
  anchorIds: string[]
): Promise<GraphWalkResult> {
  const parentEdges = new Map<string, ParentEdge[]>();
  const reasons: TreeTruncationReason[] = [];
  // Ids already fetched or already attempted. An id that was attempted but did
  // not come back (deleted, or owned by another organization) stays here so a
  // later level never re-queries it.
  const attemptedIds = new Set<string>(anchorIds);
  let frontier = anchorIds;

  for (let level = 0; level < MAX_CHAIN_DEPTH && frontier.length > 0; level++) {
    const links = await fetchLinksByTargetIds(organizationId, frontier);
    const candidateIds: string[] = [];
    for (const link of links) {
      addParentEdge(parentEdges, link);
      if (!attemptedIds.has(link.sourceId)) {
        attemptedIds.add(link.sourceId);
        candidateIds.push(link.sourceId);
      }
    }
    if (candidateIds.length === 0) {
      return { parentEdges, reasons };
    }

    const { loadedIds, hitNodeBudget } = await loadArtifactsById(
      organizationId,
      candidateIds,
      artifactsById
    );
    if (hitNodeBudget) {
      reasons.push(TreeTruncationReason.NodeBudget);
      return { parentEdges, reasons };
    }
    if (loadedIds.length === 0) {
      return { parentEdges, reasons };
    }
    frontier = loadedIds;
  }

  // Falling out of the loop with a non-empty frontier means the depth bound cut
  // a chain that was still producing ancestors. Saying so is the difference
  // between "this is the root" and "this is as far as we looked".
  if (frontier.length > 0) {
    reasons.push(TreeTruncationReason.DepthCap);
  }
  return { parentEdges, reasons };
}

/**
 * Walk every anchor's chain DOWNWARD, one depth level at a time, recording the
 * same parent-edge map shape the upward walk produces.
 *
 * The per-project fan-out this endpoint replaces returned every artifact in the
 * project, so a branch the user owns rendered with its sessions nested beneath
 * it. An ancestors-only read turns those rows into leaves — the expand caret
 * opens into nothing (closedloop-ai-stage, PR #4461). Walking down from the
 * same anchors restores the nesting for the user's OWN work without
 * re-materializing every artifact in every project the user touches, which is
 * the unbounded read the anchor cap and node budget exist to prevent.
 */
export async function collectDescendants(
  organizationId: string,
  artifactsById: Map<string, ArtifactWithAssignee>,
  anchorIds: string[]
): Promise<GraphWalkResult> {
  const parentEdges = new Map<string, ParentEdge[]>();
  const reasons: TreeTruncationReason[] = [];
  const attemptedIds = new Set<string>(anchorIds);
  let frontier = anchorIds;

  for (let level = 0; level < MAX_CHAIN_DEPTH && frontier.length > 0; level++) {
    const links = await fetchLinksBySourceIds(organizationId, frontier);
    const candidateIds: string[] = [];
    for (const link of links) {
      addParentEdge(parentEdges, link);
      if (!attemptedIds.has(link.targetId)) {
        attemptedIds.add(link.targetId);
        candidateIds.push(link.targetId);
      }
    }
    if (candidateIds.length === 0) {
      return { parentEdges, reasons };
    }

    const { loadedIds, hitNodeBudget } = await loadArtifactsById(
      organizationId,
      candidateIds,
      artifactsById
    );
    if (hitNodeBudget) {
      reasons.push(TreeTruncationReason.NodeBudget);
      return { parentEdges, reasons };
    }
    if (loadedIds.length === 0) {
      return { parentEdges, reasons };
    }
    frontier = loadedIds;
  }

  if (frontier.length > 0) {
    reasons.push(TreeTruncationReason.DepthCap);
  }
  return { parentEdges, reasons };
}

/**
 * Fold one walk's parent edges into another's, preserving every distinct edge.
 * The upward and downward walks can both discover the same edge (an anchor that
 * is another anchor's parent), so identical `(child, parent)` pairs collapse.
 */
export function mergeParentEdges(
  into: Map<string, ParentEdge[]>,
  from: Map<string, ParentEdge[]>
): void {
  for (const [childId, edges] of from) {
    const existing = into.get(childId);
    if (!existing) {
      into.set(childId, [...edges]);
      continue;
    }
    for (const edge of edges) {
      if (!existing.some((known) => known.parentId === edge.parentId)) {
        existing.push(edge);
      }
    }
  }
}

function addParentEdge(
  parentEdges: Map<string, ParentEdge[]>,
  link: ArtifactLink
): void {
  const edge: ParentEdge = { parentId: link.sourceId, linkType: link.linkType };
  const existing = parentEdges.get(link.targetId);
  if (!existing) {
    parentEdges.set(link.targetId, [edge]);
    return;
  }
  if (existing.some((known) => known.parentId === edge.parentId)) {
    return;
  }
  existing.push(edge);
}

/**
 * PRODUCES links pointing AT a frontier of child ids, chunked.
 *
 * Only PRODUCES expresses a parent-child relationship — BLOCKS and RELATES_TO
 * are peer links and must not drive nesting (the same rule the per-project tree
 * applies). Ordered by `createdAt` then `id` so a child with several declared
 * parents resolves the same canonical one on every request, including when two
 * links share a timestamp.
 */
async function fetchLinksByTargetIds(
  organizationId: string,
  childIds: string[]
): Promise<ArtifactLink[]> {
  const results: ArtifactLink[] = [];
  for (const chunk of chunkIds(childIds)) {
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          linkType: LinkType.Produces,
          targetId: { in: chunk },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    results.push(...links);
  }
  return results;
}

/** PRODUCES links leading OUT of a frontier of parent ids, chunked. */
async function fetchLinksBySourceIds(
  organizationId: string,
  parentIds: string[]
): Promise<ArtifactLink[]> {
  const results: ArtifactLink[] = [];
  for (const chunk of chunkIds(parentIds)) {
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          linkType: LinkType.Produces,
          sourceId: { in: chunk },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    results.push(...links);
  }
  return results;
}
