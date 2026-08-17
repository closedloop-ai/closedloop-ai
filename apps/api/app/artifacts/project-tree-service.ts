import { LinkType } from "@repo/api/src/types/artifact";
import type { GenerationStatus } from "@repo/api/src/types/document";
import type {
  ArtifactViewDetails,
  DetailedTreeNode,
  ExternalParentLink,
  ProjectTreeDetailsResponse,
  ProjectTreeQueryFilters,
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { TreeTruncationReason } from "@repo/api/src/types/project-tree";
import {
  type ArtifactLink,
  ArtifactType,
  Prisma,
  withDb,
} from "@repo/database";
import { branchContributorExistsSql } from "@/app/branches/branch-contribution-sql";
import {
  mergeLoopStatuses,
  suppressDismissedFailuresForDocumentMap,
} from "@/app/documents/generation-status-helpers";
import { mapTagRelations } from "@/app/tags/service";
import { basicUserSelect } from "@/lib/db-utils";
import {
  type ArtifactWithAssignee,
  compareByStackRank,
  normalizeArtifactRowSubtype,
} from "./artifact-tree-shared";

export const projectTreeService = {
  async getProjectTree(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeResponse> {
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    return getProjectTreeForContributorBranches(
      projectId,
      organizationId,
      contributorBranchIds,
      options.contributorUserId,
      options.limit
    );
  },

  /**
   * `getProjectTree` with every artifact node enriched in place with
   * artifact-level view details (tags, generation status) — the
   * `?include=details` contract (FEA-1763, PLN-874). The enrichment lookups
   * run in parallel with the tree build; the tree shape is untouched and no
   * parallel flat collection is returned.
   */
  async getProjectTreeWithDetails(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeDetailsResponse> {
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    const [tree, detailsById] = await Promise.all([
      getProjectTreeForContributorBranches(
        projectId,
        organizationId,
        contributorBranchIds,
        options.contributorUserId,
        options.limit
      ),
      fetchArtifactViewDetails(projectId, organizationId, contributorBranchIds),
    ]);

    const nodes: DetailedTreeNode[] = tree.nodes.map((node) => ({
      root: attachViewDetails(node.root, detailsById),
      children: node.children.map((child) =>
        attachViewDetails(child, detailsById)
      ),
    }));

    // Spread the bounded read's truncation rather than assigning it: the
    // contract says an untruncated tree OMITS the field, so a plain
    // `truncation: tree.truncation` would serialize an explicit `undefined`
    // key and change the shape a complete read has always had.
    return {
      nodes,
      externalParents: tree.externalParents,
      ...(tree.truncation && { truncation: tree.truncation }),
    };
  },
};

async function getProjectTreeForContributorBranches(
  projectId: string,
  organizationId: string,
  contributorBranchIds: string[] | null,
  contributorUserId: string | undefined,
  limit?: number
): Promise<ProjectTreeResponse> {
  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        projectId,
        organizationId,
        ...contributorArtifactWhere(contributorBranchIds),
      },
      include: { assignee: basicUserSelect },
    })
  );

  if (artifacts.length === 0) {
    return { nodes: [], externalParents: [] };
  }

  const artifactsById = new Map<string, ArtifactWithAssignee>(
    artifacts.map((a) => [a.id, normalizeArtifactRowSubtype(a)])
  );

  const links = await fetchArtifactLinks(
    organizationId,
    Array.from(artifactsById.keys())
  );

  const internalLinks: ArtifactLink[] = [];
  const incomingExternalLinks: ArtifactLink[] = [];
  for (const link of links) {
    // Only PRODUCES links express a parent-child relationship. BLOCKS and
    // RELATES_TO are peer/sibling links and must not drive tree nesting or
    // surface as external parents — artifacts joined solely by those links
    // remain independent (sibling) roots.
    if (link.linkType !== LinkType.Produces) {
      continue;
    }
    const sourceInProject = artifactsById.has(link.sourceId);
    const targetInProject = artifactsById.has(link.targetId);
    if (sourceInProject && targetInProject) {
      internalLinks.push(link);
    } else if (targetInProject && !sourceInProject) {
      incomingExternalLinks.push(link);
    }
  }

  const externalParents = await buildExternalParents(
    projectId,
    organizationId,
    incomingExternalLinks,
    contributorUserId
  );

  const graph = buildGraph(internalLinks);
  const components = findConnectedComponents(graph.undirected, artifactsById);
  const linkedIds = new Set<string>();

  const nodes: TreeNode[] = [];

  for (const component of components) {
    for (const id of component) {
      linkedIds.add(id);
    }

    const rootId = findComponentRoot(
      component,
      graph.incomingCount,
      artifactsById
    );
    const root = artifactsById.get(rootId)!;
    const children = dfsCollectChildren(
      rootId,
      graph.adjacency,
      artifactsById,
      component
    );

    nodes.push({ root, children });
  }

  for (const [id, artifact] of artifactsById) {
    if (!linkedIds.has(id)) {
      nodes.push({ root: artifact, children: [] });
    }
  }

  nodes.sort(compareByStackRank);

  return boundRootNodes(nodes, externalParents, limit);
}

/**
 * Batch-load per-artifact view details for a project: tag summaries for all
 * artifacts, and generation status (resolved from Loop records, dismissed
 * failures suppressed) for DOCUMENT artifacts.
 */
async function fetchArtifactViewDetails(
  projectId: string,
  organizationId: string,
  contributorBranchIds: string[] | null
): Promise<Map<string, ArtifactViewDetails>> {
  const rows = await withDb((db) =>
    db.artifact.findMany({
      where: {
        projectId,
        organizationId,
        ...contributorArtifactWhere(contributorBranchIds),
      },
      select: {
        id: true,
        type: true,
        tagArtifacts: { include: { tag: true } },
      },
    })
  );

  const documentIds = rows
    .filter((row) => row.type === ArtifactType.DOCUMENT)
    .map((row) => row.id);
  const generationStatusMap = new Map<string, GenerationStatus>();
  await mergeLoopStatuses(documentIds, generationStatusMap);
  await suppressDismissedFailuresForDocumentMap(
    documentIds,
    generationStatusMap
  );

  const detailsById = new Map<string, ArtifactViewDetails>();
  for (const row of rows) {
    const tags = mapTagRelations(row.tagArtifacts);
    const generationStatus = generationStatusMap.get(row.id);
    if (tags.length > 0 || generationStatus) {
      detailsById.set(row.id, {
        ...(tags.length > 0 && { tags }),
        ...(generationStatus && { generationStatus }),
      });
    }
  }
  return detailsById;
}

async function fetchContributorBranchIds(
  projectId: string,
  organizationId: string,
  contributorUserId: string | undefined
): Promise<string[] | null> {
  if (!contributorUserId) {
    return null;
  }
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.project_id = ${projectId}::uuid
        AND a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${branchContributorExistsSql(contributorUserId)}
    `)
  );
  return rows.map((row) => row.id);
}

async function fetchContributorBranchIdsById(
  organizationId: string,
  branchIds: string[],
  contributorUserId: string
): Promise<Set<string>> {
  if (branchIds.length === 0) {
    return new Set();
  }
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${branchContributorExistsSql(contributorUserId)}
    `)
  );
  return new Set(rows.map((row) => row.id));
}

function contributorArtifactWhere(contributorBranchIds: string[] | null): {
  OR?: Array<{ type: { not: ArtifactType } } | { id: { in: string[] } }>;
} {
  if (contributorBranchIds === null) {
    return {};
  }
  return {
    OR: [
      { type: { not: ArtifactType.BRANCH } },
      { id: { in: contributorBranchIds } },
    ],
  };
}

function attachViewDetails<T extends { id: string }>(
  artifact: T,
  detailsById: Map<string, ArtifactViewDetails>
): T & ArtifactViewDetails {
  const details = detailsById.get(artifact.id);
  return details ? { ...artifact, ...details } : artifact;
}

function fetchArtifactLinks(
  organizationId: string,
  artifactIds: string[]
): Promise<ArtifactLink[]> {
  if (artifactIds.length === 0) {
    return Promise.resolve([]);
  }

  return withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        OR: [
          { sourceId: { in: artifactIds } },
          { targetId: { in: artifactIds } },
        ],
      },
      orderBy: { createdAt: "asc" },
    })
  );
}

/**
 * Resolve cross-project incoming links into `ExternalParentLink` entries by
 * fetching each distinct external source artifact once and joining back to
 * the link rows. Skips links whose source artifact cannot be located in the
 * organization (defensive: handles soft-deletes or stale rows).
 */
async function buildExternalParents(
  projectId: string,
  organizationId: string,
  incomingExternalLinks: ArtifactLink[],
  contributorUserId: string | undefined
): Promise<ExternalParentLink[]> {
  if (incomingExternalLinks.length === 0) {
    return [];
  }

  const externalSourceIds = Array.from(
    new Set(incomingExternalLinks.map((link) => link.sourceId))
  );

  const parents = await withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: externalSourceIds }, organizationId },
      include: { assignee: basicUserSelect },
    })
  );

  const parentsById = new Map<string, ArtifactWithAssignee>(
    parents.map((p) => [p.id, normalizeArtifactRowSubtype(p)])
  );
  const externalBranchParentIds = parents
    .filter(
      (parent) =>
        parent.type === ArtifactType.BRANCH && parent.projectId !== projectId
    )
    .map((parent) => parent.id);
  const visibleContributorBranchIds = contributorUserId
    ? await fetchContributorBranchIdsById(
        organizationId,
        externalBranchParentIds,
        contributorUserId
      )
    : new Set<string>();

  const result: ExternalParentLink[] = [];
  for (const link of incomingExternalLinks) {
    const parent = parentsById.get(link.sourceId);
    if (!parent) {
      continue;
    }
    if (parent.projectId === projectId) {
      continue;
    }
    if (
      contributorUserId &&
      parent.type === ArtifactType.BRANCH &&
      !visibleContributorBranchIds.has(parent.id)
    ) {
      continue;
    }
    result.push({
      childId: link.targetId,
      parent,
      linkType: link.linkType,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Graph building — operates directly on artifact_links keyed by artifact id.
// ---------------------------------------------------------------------------

type GraphEdge = { targetId: string; linkType: LinkType };

type Graph = {
  adjacency: Map<string, GraphEdge[]>;
  undirected: Map<string, Set<string>>;
  incomingCount: Map<string, number>;
};

function buildGraph(artifactLinks: ArtifactLink[]): Graph {
  const adjacency = new Map<string, GraphEdge[]>();
  const undirected = new Map<string, Set<string>>();
  const incomingCount = new Map<string, number>();

  for (const link of artifactLinks) {
    const edges = adjacency.get(link.sourceId) ?? [];
    edges.push({ targetId: link.targetId, linkType: link.linkType });
    adjacency.set(link.sourceId, edges);

    incomingCount.set(
      link.targetId,
      (incomingCount.get(link.targetId) ?? 0) + 1
    );
    if (!incomingCount.has(link.sourceId)) {
      incomingCount.set(link.sourceId, 0);
    }

    const sourceNeighbors = undirected.get(link.sourceId) ?? new Set();
    sourceNeighbors.add(link.targetId);
    undirected.set(link.sourceId, sourceNeighbors);

    const targetNeighbors = undirected.get(link.targetId) ?? new Set();
    targetNeighbors.add(link.sourceId);
    undirected.set(link.targetId, targetNeighbors);
  }

  return { adjacency, undirected, incomingCount };
}

function findConnectedComponents(
  undirected: Map<string, Set<string>>,
  artifactsById: Map<string, ArtifactWithAssignee>
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const id of undirected.keys()) {
    if (visited.has(id) || !artifactsById.has(id)) {
      continue;
    }

    const component: string[] = [];
    const queue = [id];
    visited.add(id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = undirected.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor) && artifactsById.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    components.push(component);
  }

  return components;
}

/**
 * Pick the representative root of one connected component: the earliest-created
 * parentless member, ties broken on the unique artifact id.
 *
 * ISS-5307 (wongk): the id tie-break matters here, not only in
 * `compareByStackRank`. That comparator orders roots that have ALREADY been
 * chosen, so it cannot rescue a component whose representative was picked
 * nondeterministically in the first place. For `A -> C <- B` with A and B
 * created in the same transaction (a shared millisecond is routine), the old
 * `createdAt <` test never fired on the tie, so the winner was whichever id the
 * `pool` happened to list first — and that order comes from link/BFS iteration,
 * i.e. from the database. Two reads could therefore name different roots for
 * the same component and move a different row across the bounded-read
 * boundary. Comparing ids on a timestamp tie makes the choice a pure function
 * of the component's contents, independent of the order they arrive in.
 */
function findComponentRoot(
  component: string[],
  incomingCount: Map<string, number>,
  artifactsById: Map<string, ArtifactWithAssignee>
): string {
  const candidates = component.filter(
    (id) => (incomingCount.get(id) ?? 0) === 0
  );

  // Caller guarantees `component` only contains ids present in `artifactsById`;
  // `pool` is either a filtered subset or `component` itself.
  const pool = candidates.length > 0 ? candidates : component;

  let best = pool[0];
  const initial = artifactsById.get(best);
  if (!initial) {
    return best;
  }
  let bestTime = initial.createdAt.getTime();

  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i];
    const artifact = artifactsById.get(candidate);
    if (!artifact) {
      continue;
    }
    const candidateTime = artifact.createdAt.getTime();
    if (isBetterComponentRoot(candidate, candidateTime, best, bestTime)) {
      best = candidate;
      bestTime = candidateTime;
    }
  }

  return best;
}

/** Earlier `createdAt` wins; on an exact tie the lexicographically lower id does. */
function isBetterComponentRoot(
  candidateId: string,
  candidateTime: number,
  bestId: string,
  bestTime: number
): boolean {
  if (candidateTime !== bestTime) {
    return candidateTime < bestTime;
  }
  return candidateId.localeCompare(bestId) < 0;
}

function dfsCollectChildren(
  rootId: string,
  adjacency: Map<string, GraphEdge[]>,
  artifactsById: Map<string, ArtifactWithAssignee>,
  componentIds: string[]
): TreeChild[] {
  const children: TreeChild[] = [];
  const visited = new Set<string>([rootId]);

  dfsStep(rootId, 1, { adjacency, artifactsById, visited, children });
  collectUnreachableComponentMembers(
    rootId,
    componentIds,
    adjacency,
    artifactsById,
    { visited, children }
  );

  return children;
}

type DfsState = {
  adjacency: Map<string, GraphEdge[]>;
  artifactsById: Map<string, ArtifactWithAssignee>;
  visited: Set<string>;
  children: TreeChild[];
};

function dfsStep(currentId: string, depth: number, state: DfsState): void {
  const edges = state.adjacency.get(currentId) ?? [];
  for (const edge of edges) {
    if (state.visited.has(edge.targetId)) {
      continue;
    }
    state.visited.add(edge.targetId);
    const artifact = state.artifactsById.get(edge.targetId);
    if (artifact) {
      state.children.push({
        ...artifact,
        linkType: edge.linkType,
        depth,
        parentId: currentId,
      });
      dfsStep(edge.targetId, depth + 1, state);
    }
  }
}

function collectUnreachableComponentMembers(
  rootId: string,
  componentIds: string[],
  adjacency: Map<string, GraphEdge[]>,
  artifactsById: Map<string, ArtifactWithAssignee>,
  state: Pick<DfsState, "visited" | "children">
): void {
  for (const id of componentIds) {
    if (state.visited.has(id)) {
      continue;
    }
    const artifact = artifactsById.get(id);
    if (artifact) {
      // The graph only contains PRODUCES edges (BLOCKS/RELATES_TO are filtered
      // out upstream), so any component member attached under the root here is
      // a produces-child.
      const edges = adjacency.get(id) ?? [];
      const linkType = edges[0]?.linkType ?? LinkType.Produces;
      state.children.push({
        ...artifact,
        linkType,
        depth: 1,
        parentId: rootId,
      });
    }
  }
}

/**
 * Apply the optional `?limit=` root bound to an already-ordered tree
 * (ISS-5307), and say so when it bit.
 *
 * The bound is applied to ROOT NODES, not to artifacts: a root carries its
 * whole subtree, so slicing roots keeps every returned node's nesting intact
 * rather than stranding children whose parent fell off the end. `nodes` must
 * already be sorted by {@link compareByStackRank}, whose id tiebreaker is what
 * makes the same prefix come back on every read.
 *
 * `externalParents` is narrowed to the roots that survived. An external-parent
 * entry names a `childId` the contract promises is present in `nodes`; keeping
 * an entry whose child was bounded away would break that promise and leave the
 * client resolving a parent link to a row it never received.
 */
function boundRootNodes(
  nodes: TreeNode[],
  externalParents: ExternalParentLink[],
  limit?: number
): ProjectTreeResponse {
  if (limit === undefined || nodes.length <= limit) {
    // Complete read: OMIT `truncation` entirely. Returning it as `undefined`
    // would still emit the key for some serializers, and the contract reserves
    // absence as the claim of completeness.
    return { nodes, externalParents };
  }

  const boundedNodes = nodes.slice(0, limit);
  const keptIds = new Set<string>();
  for (const node of boundedNodes) {
    keptIds.add(node.root.id);
    for (const child of node.children) {
      keptIds.add(child.id);
    }
  }

  return {
    nodes: boundedNodes,
    externalParents: externalParents.filter((entry) =>
      keptIds.has(entry.childId)
    ),
    truncation: {
      anchorsIncluded: boundedNodes.length,
      // The whole graph was built in memory to find the roots, so this is the
      // exact root count — reported under a field named as a FLOOR, which an
      // exact value satisfies. No caller may render it as a precise "of N"
      // (the field name is the contract), and none does.
      anchorsMatchedAtLeast: nodes.length,
      reasons: [TreeTruncationReason.AnchorCap],
    },
  };
}
