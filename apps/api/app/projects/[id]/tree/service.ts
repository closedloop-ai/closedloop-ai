import {
  type EntityLink,
  EntityType,
  LinkType,
} from "@repo/api/src/types/entity-link";
import type {
  ProjectTreeResponse,
  TreeChild,
  TreeEntity,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import { withDb } from "@repo/database";
import { entityLinksService } from "@/app/entity-links/service";
import { basicUserSelect } from "@/lib/db-utils";

export const projectTreeService = {
  async getProjectTree(
    projectId: string,
    organizationId: string
  ): Promise<ProjectTreeResponse> {
    const [artifacts, externalLinks] = await Promise.all([
      withDb((db) =>
        db.document.findMany({
          where: { projectId, organizationId },
          include: { assignee: basicUserSelect },
        })
      ),
      withDb((db) =>
        db.externalLink.findMany({
          where: { projectId, organizationId },
        })
      ),
    ]);

    const entityMap = new Map<EntityKey, TreeEntity>();

    for (const a of artifacts) {
      entityMap.set(entityKey(a.id, EntityType.Document), {
        entityType: EntityType.Document,
        id: a.id,
        slug: a.slug,
        title: a.title,
        type: a.type,
        status: a.status,
        assignee: a.assignee ?? null,
        createdAt: a.createdAt,
      });
    }
    for (const e of externalLinks) {
      entityMap.set(entityKey(e.id, EntityType.ExternalLink), {
        entityType: EntityType.ExternalLink,
        id: e.id,
        title: e.title,
        externalUrl: e.externalUrl,
        type: e.type,
        createdAt: e.createdAt,
      });
    }

    if (entityMap.size === 0) {
      return { nodes: [] };
    }

    const artifactIds = artifacts.map((a) => a.id);
    const externalLinkIds = externalLinks.map((e) => e.id);

    const allLinks = await fetchEntityLinks(
      organizationId,
      artifactIds,
      externalLinkIds
    );

    // Filter to links where both sides are in this project
    const projectLinks = allLinks.filter((link) => {
      const sourceKey = entityKey(link.sourceId, link.sourceType);
      const targetKey = entityKey(link.targetId, link.targetType);
      return entityMap.has(sourceKey) && entityMap.has(targetKey);
    });

    // Build graph and produce tree
    const graph = buildGraph(projectLinks);
    const components = findConnectedComponents(graph.undirected, entityMap);
    const linkedKeys = new Set<EntityKey>();

    const nodes: TreeNode[] = [];

    for (const component of components) {
      for (const key of component) {
        linkedKeys.add(key);
      }

      const rootKey = findComponentRoot(
        component,
        graph.incomingCount,
        entityMap
      );
      const root = entityMap.get(rootKey)!;
      const children = dfsCollectChildren(
        rootKey,
        graph.adjacency,
        entityMap,
        component
      );

      nodes.push({ root, children });
    }

    // Orphans: entities not in any link
    for (const [key, entity] of entityMap) {
      if (!linkedKeys.has(key)) {
        nodes.push({ root: entity, children: [] });
      }
    }

    // Sort roots lexicographically by title
    nodes.sort((a, b) => a.root.title.localeCompare(b.root.title));

    return { nodes };
  },
};

type EntityKey = string; // "id:entityType"

function entityKey(id: string, type: string): EntityKey {
  return `${id}:${type}`;
}

// ---------------------------------------------------------------------------
// Database query
// ---------------------------------------------------------------------------

function fetchEntityLinks(
  organizationId: string,
  artifactIds: string[],
  externalLinkIds: string[]
): Promise<EntityLink[]> {
  const orClauses: Record<string, unknown>[] = [];

  if (artifactIds.length > 0) {
    orClauses.push(
      { sourceId: { in: artifactIds }, sourceType: EntityType.Document },
      { targetId: { in: artifactIds }, targetType: EntityType.Document }
    );
  }
  if (externalLinkIds.length > 0) {
    orClauses.push(
      {
        sourceId: { in: externalLinkIds },
        sourceType: EntityType.ExternalLink,
      },
      {
        targetId: { in: externalLinkIds },
        targetType: EntityType.ExternalLink,
      }
    );
  }

  if (orClauses.length === 0) {
    return Promise.resolve([]);
  }

  return withDb((db) =>
    db.entityLink.findMany({
      where: {
        organizationId,
        OR: orClauses,
      },
      orderBy: { createdAt: "asc" },
    })
  ).then((links) => links.map(entityLinksService.toEntityLink));
}

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

type GraphEdge = { targetKey: EntityKey; linkType: LinkType };

type Graph = {
  adjacency: Map<EntityKey, GraphEdge[]>;
  undirected: Map<EntityKey, Set<EntityKey>>;
  incomingCount: Map<EntityKey, number>;
};

function buildGraph(links: EntityLink[]): Graph {
  const adjacency = new Map<EntityKey, GraphEdge[]>();
  const undirected = new Map<EntityKey, Set<EntityKey>>();
  const incomingCount = new Map<EntityKey, number>();

  for (const link of links) {
    const sourceKey = entityKey(link.sourceId, link.sourceType);
    const targetKey = entityKey(link.targetId, link.targetType);

    // Directed edge: source → target
    const edges = adjacency.get(sourceKey) ?? [];
    edges.push({ targetKey, linkType: link.linkType });
    adjacency.set(sourceKey, edges);

    // Incoming count
    incomingCount.set(targetKey, (incomingCount.get(targetKey) ?? 0) + 1);
    if (!incomingCount.has(sourceKey)) {
      incomingCount.set(sourceKey, 0);
    }

    // Undirected for connected components
    const sourceNeighbors = undirected.get(sourceKey) ?? new Set();
    sourceNeighbors.add(targetKey);
    undirected.set(sourceKey, sourceNeighbors);

    const targetNeighbors = undirected.get(targetKey) ?? new Set();
    targetNeighbors.add(sourceKey);
    undirected.set(targetKey, targetNeighbors);
  }

  return { adjacency, undirected, incomingCount };
}

// ---------------------------------------------------------------------------
// Connected components (BFS on undirected graph)
// ---------------------------------------------------------------------------

function findConnectedComponents(
  undirected: Map<EntityKey, Set<EntityKey>>,
  entityMap: Map<EntityKey, TreeEntity>
): EntityKey[][] {
  const visited = new Set<EntityKey>();
  const components: EntityKey[][] = [];

  // Only iterate over keys that appear in the undirected graph (linked entities)
  for (const key of undirected.keys()) {
    if (visited.has(key) || !entityMap.has(key)) {
      continue;
    }

    const component: EntityKey[] = [];
    const queue = [key];
    visited.add(key);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      const neighbors = undirected.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor) && entityMap.has(neighbor)) {
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

// ---------------------------------------------------------------------------
// Root finding
// ---------------------------------------------------------------------------

function findComponentRoot(
  component: EntityKey[],
  incomingCount: Map<EntityKey, number>,
  entityMap: Map<EntityKey, TreeEntity>
): EntityKey {
  // Prefer entities with zero incoming edges
  const candidates = component.filter(
    (key) => (incomingCount.get(key) ?? 0) === 0
  );

  const pool = candidates.length > 0 ? candidates : component;

  // Tiebreak: earliest createdAt
  let best = pool[0]!;
  let bestTime = entityMap.get(best)!.createdAt;

  for (let i = 1; i < pool.length; i++) {
    const time = entityMap.get(pool[i]!)!.createdAt;
    if (time < bestTime) {
      best = pool[i]!;
      bestTime = time;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// DFS to collect children in depth-first order
// ---------------------------------------------------------------------------

function dfsCollectChildren(
  rootKey: EntityKey,
  adjacency: Map<EntityKey, GraphEdge[]>,
  entityMap: Map<EntityKey, TreeEntity>,
  componentKeys: EntityKey[]
): TreeChild[] {
  const children: TreeChild[] = [];
  const visited = new Set<EntityKey>([rootKey]);

  function dfs(currentKey: EntityKey, depth: number): void {
    const edges = adjacency.get(currentKey) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.targetKey)) {
        continue;
      }
      visited.add(edge.targetKey);

      const entity = entityMap.get(edge.targetKey);
      if (entity) {
        children.push({
          ...entity,
          linkType: edge.linkType,
          depth,
        });
        dfs(edge.targetKey, depth + 1);
      }
    }
  }

  dfs(rootKey, 1);

  // Add any component members not reachable via directed DFS (e.g. multiple
  // sources pointing at a shared target — the non-root sources have no
  // incoming directed path from the root).
  for (const key of componentKeys) {
    if (visited.has(key)) {
      continue;
    }
    const entity = entityMap.get(key);
    if (entity) {
      // Find the link type from this entity's outgoing edge (if any)
      const edges = adjacency.get(key) ?? [];
      const linkType = edges[0]?.linkType ?? LinkType.RelatesTo;
      children.push({ ...entity, linkType, depth: 1 });
    }
  }

  return children;
}
