import { createHash } from "node:crypto";
import type { LinkType } from "@repo/api/src/types/artifact";
import type {
  PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementConflictDetail,
  ProjectArtifactPlacementRequest,
  ProjectArtifactPlacementSourceRoot,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import { PROJECT_TREE_MAX_VISIBLE_LEVELS } from "@repo/api/src/types/project-tree";
import { compareStackRankKeys } from "@/app/artifacts/artifact-tree-shared";
import type { PlacementState } from "@/app/documents/project-artifact-placement-service-support";

/** Map each requested source to the independent subtree root actually moved. */
export function mapRequestedSourcesToRoots(
  requestedSourceIds: string[],
  normalizedRootIds: string[],
  canonicalParents: PlacementState["canonicalParents"]
): ProjectArtifactPlacementSourceRoot[] {
  const normalizedRoots = new Set(normalizedRootIds);
  const mappings: ProjectArtifactPlacementSourceRoot[] = [];
  for (const sourceArtifactId of requestedSourceIds) {
    let candidateId: string | undefined = sourceArtifactId;
    const visited = new Set<string>();
    while (candidateId && !normalizedRoots.has(candidateId)) {
      if (visited.has(candidateId)) {
        throw new Error(
          "normalized placement source hierarchy contains a cycle"
        );
      }
      visited.add(candidateId);
      candidateId = canonicalParents.get(candidateId)?.parentId;
    }
    if (!candidateId) {
      throw new Error("normalized placement source root is missing");
    }
    mappings.push({ sourceArtifactId, rootArtifactId: candidateId });
  }
  return mappings;
}

const PROJECT_VERSION_HEX_LENGTH = 32;

type RankedArtifact = {
  id: string;
  projectId: string | null;
  sortOrder: number | null;
  createdAt: Date;
};

type ParentEdge = {
  parentId: string;
  linkType?: LinkType;
  sortOrder?: number | null;
};

type PlacementTree = {
  canonicalParents: ReadonlyMap<string, ParentEdge>;
  childrenByParent: ReadonlyMap<string, string[]>;
};

type SnapshotRow = {
  artifactId: string;
  sortOrder: number | null;
  createdAt?: string;
};

/** Build the opaque version used to reject placement against stale hierarchy state. */
export function computeProjectVersion(
  artifacts: RankedArtifact[],
  canonicalParents: ReadonlyMap<string, ParentEdge>
): string {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const parent = canonicalParents.get(artifact.id);
    hash.update(
      `${artifact.id}:${parent?.parentId ?? "root"}:${parent ? (parent.sortOrder ?? "null") : (artifact.sortOrder ?? "null")}\n`
    );
  }
  return hash.digest("hex").slice(0, PROJECT_VERSION_HEX_LENGTH);
}

/** Hash a normalized request for idempotent replay collision detection. */
export function hashPlacementRequest(
  routeProjectId: string,
  input: ProjectArtifactPlacementRequest
): string {
  const canonicalVersions = Object.fromEntries(
    Object.entries(input.expectedProjectVersions).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        routeProjectId,
        ...input,
        expectedProjectVersions: canonicalVersions,
      })
    )
    .digest("hex");
}

/** Remove selected descendants because moving an ancestor already moves its subtree. */
export function normalizeSourceRoots(
  sourceIds: string[],
  parents: ReadonlyMap<string, ParentEdge>
): string[] {
  const selected = new Set(sourceIds);
  return sourceIds.filter((sourceId) => {
    const visited = new Set([sourceId]);
    let parentId = parents.get(sourceId)?.parentId;
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) {
        return false;
      }
      visited.add(parentId);
      parentId = parents.get(parentId)?.parentId;
    }
    return true;
  });
}

/** Expand independent roots into every artifact moved with their subtrees. */
export function collectSubtrees(
  rootIds: string[],
  childrenByParent: ReadonlyMap<string, string[]>
): string[] {
  const result: string[] = [];
  const visit = (artifactId: string) => {
    result.push(artifactId);
    for (const childId of childrenByParent.get(artifactId) ?? []) {
      visit(childId);
    }
  };
  for (const rootId of rootIds) {
    visit(rootId);
  }
  return result;
}

/** Resolve the canonical destination parent for all placement positions. */
export function resolveDestinationParentId(
  input: PlaceProjectArtifactsRequest,
  parents: ReadonlyMap<string, ParentEdge>
): string | null {
  if (input.position === ProjectArtifactPlacementPosition.Root) {
    return null;
  }
  if (input.position === ProjectArtifactPlacementPosition.Inside) {
    return input.targetArtifactId ?? null;
  }
  return input.targetArtifactId
    ? (parents.get(input.targetArtifactId)?.parentId ?? null)
    : null;
}

/** Enforce the four visible levels across the complete moved subtree. */
export function fitsDepthLimit(
  sourceIds: string[],
  destinationParentId: string | null,
  state: PlacementTree
): boolean {
  const destinationDepth = destinationParentId
    ? artifactDepth(destinationParentId, state.canonicalParents) + 1
    : 0;
  return sourceIds.every(
    (sourceId) =>
      destinationDepth + subtreeHeight(sourceId, state.childrenByParent) <=
      PROJECT_TREE_MAX_VISIBLE_LEVELS
  );
}

export function neighborhoodKey(
  projectId: string,
  parentId: string | null
): string {
  return `${projectId}:${parentId ?? "root"}`;
}

export function parseNeighborhoodKey(key: string): [string, string | null] {
  const separator = key.indexOf(":");
  const projectId = key.slice(0, separator);
  const parentId = key.slice(separator + 1);
  return [projectId, parentId === "root" ? null : parentId];
}

/** Total order matching project-tree stack-rank ordering. */
export function compareArtifactRows(
  left: RankedArtifact | undefined,
  right: RankedArtifact | undefined
): number {
  if (!left) {
    return right ? 1 : 0;
  }
  if (!right) {
    return -1;
  }
  return compareStackRankKeys(left, right);
}

export function compareSnapshotRows(
  left: SnapshotRow | undefined,
  right: SnapshotRow | undefined
): number {
  if (!left) {
    return right ? 1 : 0;
  }
  if (!right) {
    return -1;
  }
  return compareStackRankKeys(snapshotRankKeys(left), snapshotRankKeys(right));
}

/** Reject a destination reachable beneath any selected root across every parent edge. */
export function placementWouldCreateCycle(
  sourceIds: ReadonlySet<string>,
  destinationParentId: string | null,
  allParentIds: ReadonlyMap<string, string[]>
): boolean {
  if (!destinationParentId) {
    return false;
  }
  const pending = [destinationParentId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const artifactId = pending.pop();
    if (!artifactId || visited.has(artifactId)) {
      continue;
    }
    if (sourceIds.has(artifactId)) {
      return true;
    }
    visited.add(artifactId);
    pending.push(...(allParentIds.get(artifactId) ?? []));
  }
  return false;
}

export function staleVersionDetail(
  projectIds: string[],
  expected: Record<string, string>,
  actual: Record<string, string>
): ProjectArtifactPlacementConflictDetail | null {
  const stale = projectIds.some(
    (projectId) => expected[projectId] !== actual[projectId]
  );
  return stale
    ? {
        reason: ProjectArtifactPlacementErrorReason.StaleVersion,
        actualProjectVersions: actual,
      }
    : null;
}

export function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Resolve a stable-id placement to its destination neighborhood index. */
export function resolvePlacementInsertionIndex(
  destinationOrder: readonly string[],
  input: PlaceProjectArtifactsRequest
): number | null {
  if (input.position === ProjectArtifactPlacementPosition.Root) {
    return destinationOrder.length;
  }
  if (input.position === ProjectArtifactPlacementPosition.Inside) {
    return 0;
  }
  const targetIndex = input.targetArtifactId
    ? destinationOrder.indexOf(input.targetArtifactId)
    : -1;
  if (targetIndex < 0) {
    return null;
  }
  return input.position === ProjectArtifactPlacementPosition.After
    ? targetIndex + 1
    : targetIndex;
}

/** Honor the existing flag-off start edge without changing manual root placement. */
export function resolveHierarchyInsertionIndex(
  destinationOrder: readonly string[],
  input: PlaceProjectArtifactsRequest,
  rootInsertion: "start" | "end" | undefined
): number | null {
  if (
    input.position === ProjectArtifactPlacementPosition.Root &&
    rootInsertion === "start"
  ) {
    return 0;
  }
  return resolvePlacementInsertionIndex(destinationOrder, input);
}

function snapshotRankKeys(row: SnapshotRow) {
  return {
    id: row.artifactId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt ? new Date(row.createdAt) : new Date(0),
  };
}

function artifactDepth(
  artifactId: string,
  parents: ReadonlyMap<string, ParentEdge>
): number {
  let depth = 0;
  const visited = new Set([artifactId]);
  let parentId = parents.get(artifactId)?.parentId;
  while (parentId && !visited.has(parentId)) {
    depth += 1;
    visited.add(parentId);
    parentId = parents.get(parentId)?.parentId;
  }
  return depth;
}

function subtreeHeight(
  artifactId: string,
  childrenByParent: ReadonlyMap<string, string[]>
): number {
  const children = childrenByParent.get(artifactId) ?? [];
  return (
    1 +
    children.reduce(
      (height, childId) =>
        Math.max(height, subtreeHeight(childId, childrenByParent)),
      0
    )
  );
}
