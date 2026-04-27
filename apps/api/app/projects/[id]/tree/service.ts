import { LinkType } from "@repo/api/src/types/artifact";
import {
  type ProjectTreeResponse,
  type TreeChild,
  type TreeEntity,
  TreeEntityType,
  TreeExternalLinkType,
  type TreeNode,
} from "@repo/api/src/types/project-tree";
import type { BasicUser } from "@repo/api/src/types/user";
import {
  type Artifact,
  type ArtifactLink,
  ArtifactType,
  withDb,
} from "@repo/database";
import { basicUserSelect } from "@/lib/db-utils";

type ArtifactWithAssignee = Artifact & {
  assignee: BasicUser | null;
};

export const projectTreeService = {
  async getProjectTree(
    projectId: string,
    organizationId: string
  ): Promise<ProjectTreeResponse> {
    // Single unified read against the Artifact parent. Relationships live on
    // `artifact_links` with real FKs.
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
      return { nodes: [] };
    }

    const entityMap = new Map<EntityKey, TreeEntity>();

    for (const artifact of artifacts) {
      const entity = toTreeEntity(artifact);
      if (entity) {
        entityMap.set(entityKey(entity.id, entity.entityType), entity);
      }
    }

    const artifactIds = artifacts.map((a) => a.id);
    const links = await fetchArtifactLinks(organizationId, artifactIds);

    // Filter to links where both sides are in this project
    const projectLinks = links.filter((link) => {
      const sourceKey = entityKeyFromArtifactId(link.sourceId, artifacts);
      const targetKey = entityKeyFromArtifactId(link.targetId, artifacts);
      return Boolean(
        sourceKey &&
          targetKey &&
          entityMap.has(sourceKey) &&
          entityMap.has(targetKey)
      );
    });

    const graph = buildGraph(projectLinks, artifacts);
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

    for (const [key, entity] of entityMap) {
      if (!linkedKeys.has(key)) {
        nodes.push({ root: entity, children: [] });
      }
    }

    nodes.sort((a, b) => a.root.title.localeCompare(b.root.title));

    return { nodes };
  },
};

type EntityKey = string; // "id:entityType"

function entityKey(id: string, type: string): EntityKey {
  return `${id}:${type}`;
}

/**
 * Map an artifact to the legacy TreeEntity discriminated union so the public
 * API response shape stays stable. PULL_REQUEST and DEPLOYMENT artifacts
 * surface as EXTERNAL_LINK-typed entries, matching how today's frontend
 * renders them.
 */
function toTreeEntity(artifact: ArtifactWithAssignee): TreeEntity | null {
  if (artifact.type === ArtifactType.DOCUMENT) {
    // Documents require a slug and a subtype in the legacy shape.
    if (!(artifact.slug && artifact.subtype)) {
      return null;
    }
    return {
      entityType: TreeEntityType.Document,
      id: artifact.id,
      slug: artifact.slug,
      title: artifact.name,
      type: artifact.subtype,
      status: artifact.status,
      assignee: artifact.assignee,
      createdAt: artifact.createdAt,
    } as TreeEntity;
  }

  if (artifact.type === ArtifactType.PULL_REQUEST) {
    return {
      entityType: TreeEntityType.ExternalLink,
      id: artifact.id,
      title: artifact.name,
      externalUrl: artifact.externalUrl,
      type: TreeExternalLinkType.PullRequest,
      createdAt: artifact.createdAt,
    } as TreeEntity;
  }

  if (artifact.type === ArtifactType.DEPLOYMENT) {
    return {
      entityType: TreeEntityType.ExternalLink,
      id: artifact.id,
      title: artifact.name,
      externalUrl: artifact.externalUrl,
      type: TreeExternalLinkType.PreviewDeployment,
      createdAt: artifact.createdAt,
    } as TreeEntity;
  }

  return null;
}

/**
 * Re-derive the wire-level entity type from the artifact row so callers
 * don't need a second lookup.
 */
function entityKeyFromArtifactId(
  id: string,
  artifacts: Artifact[]
): EntityKey | null {
  const match = artifacts.find((a) => a.id === id);
  if (!match) {
    return null;
  }
  const entityType =
    match.type === ArtifactType.DOCUMENT
      ? TreeEntityType.Document
      : TreeEntityType.ExternalLink;
  return entityKey(id, entityType);
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

// ---------------------------------------------------------------------------
// Graph building — operates directly on artifact_links, with the entity-type
// discriminator derived on the fly from the parent Artifact rows.
// ---------------------------------------------------------------------------

type LegacyLink = {
  sourceId: string;
  sourceType: TreeEntityType;
  targetId: string;
  targetType: TreeEntityType;
  linkType: LinkType;
};

function linksToLegacy(
  links: ArtifactLink[],
  artifacts: Artifact[]
): LegacyLink[] {
  const typeById = new Map(artifacts.map((a) => [a.id, a.type]));
  const out: LegacyLink[] = [];
  for (const link of links) {
    const sourceArtifactType = typeById.get(link.sourceId);
    const targetArtifactType = typeById.get(link.targetId);
    if (!(sourceArtifactType && targetArtifactType)) {
      continue;
    }
    out.push({
      sourceId: link.sourceId,
      sourceType:
        sourceArtifactType === ArtifactType.DOCUMENT
          ? TreeEntityType.Document
          : TreeEntityType.ExternalLink,
      targetId: link.targetId,
      targetType:
        targetArtifactType === ArtifactType.DOCUMENT
          ? TreeEntityType.Document
          : TreeEntityType.ExternalLink,
      linkType: link.linkType as LinkType,
    });
  }
  return out;
}

type GraphEdge = { targetKey: EntityKey; linkType: LinkType };

type Graph = {
  adjacency: Map<EntityKey, GraphEdge[]>;
  undirected: Map<EntityKey, Set<EntityKey>>;
  incomingCount: Map<EntityKey, number>;
};

function buildGraph(
  artifactLinks: ArtifactLink[],
  artifacts: Artifact[]
): Graph {
  const links = linksToLegacy(artifactLinks, artifacts);
  const adjacency = new Map<EntityKey, GraphEdge[]>();
  const undirected = new Map<EntityKey, Set<EntityKey>>();
  const incomingCount = new Map<EntityKey, number>();

  for (const link of links) {
    const sourceKey = entityKey(link.sourceId, link.sourceType);
    const targetKey = entityKey(link.targetId, link.targetType);

    const edges = adjacency.get(sourceKey) ?? [];
    edges.push({ targetKey, linkType: link.linkType });
    adjacency.set(sourceKey, edges);

    incomingCount.set(targetKey, (incomingCount.get(targetKey) ?? 0) + 1);
    if (!incomingCount.has(sourceKey)) {
      incomingCount.set(sourceKey, 0);
    }

    const sourceNeighbors = undirected.get(sourceKey) ?? new Set();
    sourceNeighbors.add(targetKey);
    undirected.set(sourceKey, sourceNeighbors);

    const targetNeighbors = undirected.get(targetKey) ?? new Set();
    targetNeighbors.add(sourceKey);
    undirected.set(targetKey, targetNeighbors);
  }

  return { adjacency, undirected, incomingCount };
}

function findConnectedComponents(
  undirected: Map<EntityKey, Set<EntityKey>>,
  entityMap: Map<EntityKey, TreeEntity>
): EntityKey[][] {
  const visited = new Set<EntityKey>();
  const components: EntityKey[][] = [];

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

function findComponentRoot(
  component: EntityKey[],
  incomingCount: Map<EntityKey, number>,
  entityMap: Map<EntityKey, TreeEntity>
): EntityKey {
  const candidates = component.filter(
    (key) => (incomingCount.get(key) ?? 0) === 0
  );

  // Caller guarantees `component` only contains keys present in `entityMap`;
  // `pool` is either a filtered subset or `component` itself.
  const pool = candidates.length > 0 ? candidates : component;

  let best = pool[0];
  const initial = entityMap.get(best);
  if (!initial) {
    return best;
  }
  let bestTime = initial.createdAt;

  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[i];
    const entity = entityMap.get(candidate);
    if (!entity) {
      continue;
    }
    if (entity.createdAt < bestTime) {
      best = candidate;
      bestTime = entity.createdAt;
    }
  }

  return best;
}

function dfsCollectChildren(
  rootKey: EntityKey,
  adjacency: Map<EntityKey, GraphEdge[]>,
  entityMap: Map<EntityKey, TreeEntity>,
  componentKeys: EntityKey[]
): TreeChild[] {
  const children: TreeChild[] = [];
  const visited = new Set<EntityKey>([rootKey]);

  dfsStep(rootKey, 1, { adjacency, entityMap, visited, children });
  collectUnreachableComponentMembers(componentKeys, adjacency, entityMap, {
    visited,
    children,
  });

  return children;
}

type DfsState = {
  adjacency: Map<EntityKey, GraphEdge[]>;
  entityMap: Map<EntityKey, TreeEntity>;
  visited: Set<EntityKey>;
  children: TreeChild[];
};

function dfsStep(currentKey: EntityKey, depth: number, state: DfsState): void {
  const edges = state.adjacency.get(currentKey) ?? [];
  for (const edge of edges) {
    if (state.visited.has(edge.targetKey)) {
      continue;
    }
    state.visited.add(edge.targetKey);
    const entity = state.entityMap.get(edge.targetKey);
    if (entity) {
      state.children.push({ ...entity, linkType: edge.linkType, depth });
      dfsStep(edge.targetKey, depth + 1, state);
    }
  }
}

function collectUnreachableComponentMembers(
  componentKeys: EntityKey[],
  adjacency: Map<EntityKey, GraphEdge[]>,
  entityMap: Map<EntityKey, TreeEntity>,
  state: Pick<DfsState, "visited" | "children">
): void {
  for (const key of componentKeys) {
    if (state.visited.has(key)) {
      continue;
    }
    const entity = entityMap.get(key);
    if (entity) {
      const edges = adjacency.get(key) ?? [];
      const linkType = edges[0]?.linkType ?? LinkType.RelatesTo;
      state.children.push({ ...entity, linkType, depth: 1 });
    }
  }
}
