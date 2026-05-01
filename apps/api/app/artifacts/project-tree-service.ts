import { LinkType } from "@repo/api/src/types/artifact";
import type {
  ExternalParentLink,
  ProjectTreeResponse,
  TreeChild,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import type { BasicUser } from "@repo/api/src/types/user";
import { type Artifact, type ArtifactLink, withDb } from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

type ArtifactWithAssignee = Artifact & {
  assignee: BasicUser | null;
};

export const projectTreeService = {
  async getProjectTree(
    projectId: string,
    organizationId: string
  ): Promise<ProjectTreeResponse> {
    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          projectId,
          organizationId,
          project: { isTemplatesSentinel: false },
        },
        include: { assignee: basicUserSelect },
      })
    );

    if (artifacts.length === 0) {
      return { nodes: [], externalParents: [] };
    }

    const artifactsById = new Map<string, ArtifactWithAssignee>(
      artifacts.map((a) => [a.id, a])
    );

    const links = await fetchArtifactLinks(
      organizationId,
      Array.from(artifactsById.keys())
    );

    const internalLinks: ArtifactLink[] = [];
    const incomingExternalLinks: ArtifactLink[] = [];
    for (const link of links) {
      const sourceInProject = artifactsById.has(link.sourceId);
      const targetInProject = artifactsById.has(link.targetId);
      if (sourceInProject && targetInProject) {
        internalLinks.push(link);
      } else if (targetInProject && !sourceInProject) {
        incomingExternalLinks.push(link);
      }
    }

    const externalParents = await buildExternalParents(
      organizationId,
      incomingExternalLinks
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

    nodes.sort((a, b) => a.root.name.localeCompare(b.root.name));

    return { nodes, externalParents };
  },
};

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
  organizationId: string,
  incomingExternalLinks: ArtifactLink[]
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
    parents.map((p) => [p.id, p])
  );

  const result: ExternalParentLink[] = [];
  for (const link of incomingExternalLinks) {
    const parent = parentsById.get(link.sourceId);
    if (!parent) {
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
  let bestTime = initial.createdAt;

  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i];
    const artifact = artifactsById.get(candidate);
    if (!artifact) {
      continue;
    }
    if (artifact.createdAt < bestTime) {
      best = candidate;
      bestTime = artifact.createdAt;
    }
  }

  return best;
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
  collectUnreachableComponentMembers(componentIds, adjacency, artifactsById, {
    visited,
    children,
  });

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
      state.children.push({ ...artifact, linkType: edge.linkType, depth });
      dfsStep(edge.targetId, depth + 1, state);
    }
  }
}

function collectUnreachableComponentMembers(
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
      const edges = adjacency.get(id) ?? [];
      const linkType = edges[0]?.linkType ?? LinkType.RelatesTo;
      state.children.push({ ...artifact, linkType, depth: 1 });
    }
  }
}
