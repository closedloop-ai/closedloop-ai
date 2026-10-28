import { createHash } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import type {
  ProjectTreeIntegrityDiagnostic,
  ProjectTreeQueryFilters,
} from "@repo/api/src/types/project-tree";
import {
  PROJECT_TREE_DEFAULT_CHILD_LIMIT,
  PROJECT_TREE_MAX_CHILD_LIMIT,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  PROJECT_TREE_MAX_VISIBLE_LEVELS,
  ProjectTreeCategory,
  ProjectTreeIntegrityDiagnosticKind,
} from "@repo/api/src/types/project-tree";
import {
  ArtifactSubtype,
  ArtifactType,
  Prisma,
  type TransactionClient,
} from "@repo/database";
import type {
  ArtifactPlacementRow,
  PlacementState,
} from "@/app/documents/project-artifact-placement-service-support";
import { compareStackRankKeys } from "../artifact-tree-shared";
import {
  decodeProjectHierarchyCursor,
  encodeProjectHierarchyCursor,
  hierarchyPathFor,
  ProjectHierarchyParentUnavailableError,
  ProjectHierarchyStaleCursorError,
  type ProjectHierarchyWindow,
} from "./hierarchy-projection";

const PROJECT_TREE_MAX_WINDOW_ARTIFACTS = 5000;
const PROJECT_VERSION_HEX_LENGTH = 32;

export type BoundedProjectHierarchyRead = {
  childCountsByParent: Map<string, number>;
  state: PlacementState;
  window: ProjectHierarchyWindow;
};

/**
 * Read one hierarchy page and its bounded visible descendants at the storage
 * layer. Canonical placement stays owned by PRD-725; this read-only projection
 * applies the same edge and stack-rank ordering to every artifact kind.
 */
export async function readBoundedProjectHierarchy(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  options: ProjectTreeQueryFilters
): Promise<BoundedProjectHierarchyRead> {
  const { hierarchyVersion, mutationVersion } = await readProjectVersions(
    tx,
    projectId,
    organizationId
  );
  const pageSize = hierarchyPageSize(options);
  const cursor = await readCursorKey(
    tx,
    projectId,
    organizationId,
    options,
    hierarchyVersion
  );
  const parentArtifactId = options.parentArtifactId;
  if (parentArtifactId) {
    await requireProjectArtifact(
      tx,
      parentArtifactId,
      projectId,
      organizationId
    );
  }

  const peeked = await readPageRows(
    tx,
    projectId,
    organizationId,
    parentArtifactId,
    options.category,
    cursor,
    pageSize + 1
  );
  const pageRows = peeked.slice(0, pageSize);
  const rootIds = pageRows.map((row) => row.id);
  const artifactsById = new Map(
    pageRows.map((row) => [row.id, placementRow(row)])
  );
  const canonicalParents = new Map<
    string,
    { linkType: LinkType; parentId: string }
  >();
  addParentEdges(canonicalParents, pageRows);
  if (parentArtifactId) {
    addAncestorEdges(
      canonicalParents,
      await readAncestorEdges(tx, parentArtifactId, projectId, organizationId)
    );
  }

  const childrenByParent = new Map<string, string[]>();
  const flatCategoryRead =
    parentArtifactId === undefined && options.category !== undefined;
  const nodeBudgetHit = flatCategoryRead
    ? false
    : await readVisibleDescendants({
        artifactsById,
        canonicalParents,
        childrenByParent,
        organizationId,
        projectId,
        rootIds,
        tx,
      });
  sortChildren(childrenByParent, artifactsById);

  const childCountsByParent = flatCategoryRead
    ? new Map<string, number>()
    : await readChildCounts(tx, projectId, organizationId, [
        ...artifactsById.keys(),
      ]);
  const state = placementState(
    projectId,
    mutationVersion,
    artifactsById,
    canonicalParents,
    childrenByParent
  );
  const diagnostics = await readBoundedDiagnostics(
    tx,
    projectId,
    organizationId,
    state,
    childCountsByParent
  );
  const last = pageRows.at(-1);
  const hasMore = peeked.length > pageSize && last !== undefined;
  const nextCursor =
    hasMore && last
      ? encodeProjectHierarchyCursor({
          artifactId: last.id,
          createdAt: last.createdAt,
          kind: parentArtifactId ? "child" : "root",
          ...(parentArtifactId && { parentArtifactId }),
          sortOrder: last.sortOrder,
          version: hierarchyVersion,
        })
      : undefined;
  const totalChildCount = parentArtifactId
    ? await readDirectChildCount(
        tx,
        projectId,
        organizationId,
        parentArtifactId
      )
    : undefined;
  return {
    childCountsByParent,
    state,
    window: {
      diagnostics,
      diagnosticsComplete: false,
      includedArtifactIds: new Set(artifactsById.keys()),
      nodeBudgetHit,
      ...(parentArtifactId && { parentArtifactId }),
      rootIds,
      ...(parentArtifactId
        ? nextCursor && { nextCursor }
        : nextCursor && { rootNextCursor: nextCursor }),
      ...(totalChildCount !== undefined && { totalChildCount }),
      mutationVersion,
      version: hierarchyVersion,
    },
  };
}

async function readProjectVersions(
  tx: TransactionClient,
  projectId: string,
  organizationId: string
): Promise<{ hierarchyVersion: string; mutationVersion: string }> {
  const [row] = await tx.$queryRaw<
    Array<{ hierarchyVersion: string; mutationVersion: string }>
  >(Prisma.sql`
    SELECT
      hierarchy_version AS "hierarchyVersion",
      hierarchy_mutation_version AS "mutationVersion"
    FROM projects
    WHERE id = ${projectId}::uuid
      AND organization_id = ${organizationId}::uuid
  `);
  return {
    hierarchyVersion:
      row?.hierarchyVersion ??
      hashProjectVersionSeed("--eligible-produces-edges--\n"),
    mutationVersion: row?.mutationVersion ?? hashProjectVersionSeed(""),
  };
}

function readPageRows(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  parentArtifactId: string | undefined,
  category: ProjectTreeCategory | undefined,
  cursor: CursorKey | undefined,
  limit: number
): Promise<HierarchyReadRow[]> {
  const parentPredicate = hierarchyPageParentPredicate(
    parentArtifactId,
    category
  );
  const rank =
    category === undefined
      ? Prisma.sql`a.hierarchy_rank`
      : Prisma.sql`a.sort_order`;
  return tx.$queryRaw<HierarchyReadRow[]>(Prisma.sql`
    SELECT
      a.id,
      a.project_id AS "projectId",
      ${rank} AS "sortOrder",
      a.created_at AS "createdAt",
      a.canonical_parent_id AS "parentId"
    FROM artifacts a
    WHERE a.organization_id = ${organizationId}::uuid
      AND a.project_id = ${projectId}::uuid
      AND ${parentPredicate}
      ${stackRankCursorPredicate(cursor, rank)}
    ORDER BY ${rank} ASC NULLS LAST, a.created_at DESC, a.id ASC
    LIMIT ${limit}
  `);
}

function hierarchyPageParentPredicate(
  parentArtifactId: string | undefined,
  category: ProjectTreeCategory | undefined
): Prisma.Sql {
  if (parentArtifactId) {
    return Prisma.sql`a.canonical_parent_id = ${parentArtifactId}::uuid`;
  }
  if (category !== undefined) {
    return projectTreeCategoryPredicate(category);
  }
  return Prisma.sql`a.canonical_parent_id IS NULL`;
}

function readBoundedChildren(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  parentIds: string[],
  limit: number
): Promise<HierarchyReadRow[]> {
  if (parentIds.length === 0) {
    return Promise.resolve([]);
  }
  return tx.$queryRaw<HierarchyReadRow[]>(Prisma.sql`
    SELECT
      child.id,
      child.project_id AS "projectId",
      child.hierarchy_rank AS "sortOrder",
      child.created_at AS "createdAt",
      child.canonical_parent_id AS "parentId"
    FROM unnest(ARRAY[${uuidList(parentIds)}]::uuid[]) parent(parent_id)
    JOIN LATERAL (
      SELECT a.*
      FROM artifacts a
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.project_id = ${projectId}::uuid
        AND a.canonical_parent_id = parent.parent_id
      ORDER BY a.hierarchy_rank ASC NULLS LAST, a.created_at DESC, a.id ASC
      LIMIT ${PROJECT_TREE_DEFAULT_CHILD_LIMIT}
    ) child ON true
    ORDER BY parent.parent_id ASC, child.hierarchy_rank ASC NULLS LAST,
      child.created_at DESC, child.id ASC
    LIMIT ${limit}
  `);
}

async function readChildCounts(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  parentIds: string[]
): Promise<Map<string, number>> {
  if (parentIds.length === 0) {
    return new Map();
  }
  const rows = await tx.$queryRaw<Array<{ count: bigint; parentId: string }>>(
    Prisma.sql`
      SELECT id AS "parentId", canonical_child_count AS count
      FROM artifacts
      WHERE organization_id = ${organizationId}::uuid
        AND project_id = ${projectId}::uuid
        AND id IN (${uuidList(parentIds)})
    `
  );
  return new Map(rows.map((row) => [row.parentId, Number(row.count)]));
}

async function readDirectChildCount(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  parentArtifactId: string
): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT canonical_child_count AS count
    FROM artifacts
    WHERE organization_id = ${organizationId}::uuid
      AND project_id = ${projectId}::uuid
      AND id = ${parentArtifactId}::uuid
  `);
  return Number(row?.count ?? 0);
}

async function readBoundedDiagnostics(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  state: PlacementState,
  childCountsByParent: ReadonlyMap<string, number>
): Promise<ProjectTreeIntegrityDiagnostic[]> {
  const diagnostics: ProjectTreeIntegrityDiagnostic[] = [];
  const boundaryParentIds: string[] = [];
  for (const artifact of state.artifacts) {
    const path = hierarchyPathFor(artifact.id, state.canonicalParents);
    if (path.length > PROJECT_TREE_MAX_VISIBLE_LEVELS) {
      diagnostics.push({
        artifactId: artifact.id,
        kind: ProjectTreeIntegrityDiagnosticKind.DepthCapped,
        ...(state.canonicalParents.get(artifact.id)?.parentId && {
          relatedArtifactId: state.canonicalParents.get(artifact.id)?.parentId,
        }),
      });
    } else if (
      path.length === PROJECT_TREE_MAX_VISIBLE_LEVELS &&
      (childCountsByParent.get(artifact.id) ?? 0) > 0
    ) {
      boundaryParentIds.push(artifact.id);
    }
  }
  const cappedChildren = await readFirstChildren(
    tx,
    projectId,
    organizationId,
    boundaryParentIds
  );
  for (const child of cappedChildren) {
    diagnostics.push({
      artifactId: child.id,
      kind: ProjectTreeIntegrityDiagnosticKind.DepthCapped,
      ...(child.parentId && { relatedArtifactId: child.parentId }),
    });
  }
  const incomingEdges = await readIncomingEdges(
    tx,
    projectId,
    organizationId,
    state.artifacts.map((artifact) => artifact.id)
  );
  for (const edge of incomingEdges) {
    const canonical = state.canonicalParents.get(edge.targetId);
    if (canonical?.parentId === edge.sourceId) {
      continue;
    }
    diagnostics.push({
      artifactId: edge.targetId,
      kind: canonical
        ? ProjectTreeIntegrityDiagnosticKind.DuplicateParent
        : ProjectTreeIntegrityDiagnosticKind.CycleRejected,
      relatedArtifactId: edge.sourceId,
    });
  }
  return diagnostics;
}

function readFirstChildren(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  parentIds: string[]
): Promise<HierarchyReadRow[]> {
  if (parentIds.length === 0) {
    return Promise.resolve([]);
  }
  return tx.$queryRaw<HierarchyReadRow[]>(Prisma.sql`
    SELECT
      child.id,
      child.project_id AS "projectId",
      child.hierarchy_rank AS "sortOrder",
      child.created_at AS "createdAt",
      child.canonical_parent_id AS "parentId"
    FROM unnest(ARRAY[${uuidList(parentIds)}]::uuid[]) parent(parent_id)
    JOIN LATERAL (
      SELECT a.*
      FROM artifacts a
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.project_id = ${projectId}::uuid
        AND a.canonical_parent_id = parent.parent_id
      ORDER BY a.hierarchy_rank ASC NULLS LAST, a.created_at DESC, a.id ASC
      LIMIT 1
    ) child ON true
    ORDER BY parent.parent_id ASC
    LIMIT ${PROJECT_TREE_MAX_WINDOW_ARTIFACTS}
  `);
}

function readIncomingEdges(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  targetIds: string[]
): Promise<IncomingEdgeRow[]> {
  if (targetIds.length === 0) {
    return Promise.resolve([]);
  }
  return tx.$queryRaw<IncomingEdgeRow[]>(Prisma.sql`
    SELECT
      link.source_id AS "sourceId",
      link.target_id AS "targetId"
    FROM artifact_links link
    JOIN artifacts source ON source.id = link.source_id
      AND source.organization_id = ${organizationId}::uuid
      AND source.project_id = ${projectId}::uuid
    JOIN artifacts target ON target.id = link.target_id
      AND target.organization_id = ${organizationId}::uuid
      AND target.project_id = ${projectId}::uuid
    WHERE link.organization_id = ${organizationId}::uuid
      AND link.link_type = ${LinkType.Produces}::"LinkType"
      AND link.target_id IN (${uuidList(targetIds)})
      AND NOT COALESCE((
        jsonb_typeof(link.metadata #> '{hierarchy,suppressed}') = 'boolean'
        AND link.metadata #>> '{hierarchy,suppressed}' = 'true'
      ), false)
    ORDER BY link.created_at ASC, link.id ASC
    LIMIT ${PROJECT_TREE_MAX_WINDOW_ARTIFACTS + 1}
  `);
}

function readAncestorEdges(
  tx: TransactionClient,
  artifactId: string,
  projectId: string,
  organizationId: string
): Promise<ParentEdgeRow[]> {
  return tx.$queryRaw<ParentEdgeRow[]>(Prisma.sql`
    WITH RECURSIVE ancestor_path AS (
      SELECT
        id AS child_id,
        canonical_parent_id AS parent_id,
        ARRAY[id, canonical_parent_id] AS visited,
        1 AS depth
      FROM artifacts
      WHERE id = ${artifactId}::uuid
        AND organization_id = ${organizationId}::uuid
        AND project_id = ${projectId}::uuid
        AND canonical_parent_id IS NOT NULL
      UNION ALL
      SELECT
        parent.id,
        parent.canonical_parent_id,
        ancestor_path.visited || parent.canonical_parent_id,
        ancestor_path.depth + 1
      FROM ancestor_path
      JOIN artifacts parent ON parent.id = ancestor_path.parent_id
        AND parent.organization_id = ${organizationId}::uuid
        AND parent.project_id = ${projectId}::uuid
      WHERE ancestor_path.depth < ${PROJECT_TREE_MAX_WINDOW_ARTIFACTS}
        AND parent.canonical_parent_id IS NOT NULL
        AND NOT parent.canonical_parent_id = ANY(ancestor_path.visited)
    )
    SELECT child_id AS "childId", parent_id AS "parentId"
    FROM ancestor_path
    ORDER BY depth ASC
  `);
}

async function readCursorKey(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  options: ProjectTreeQueryFilters,
  version: string
): Promise<CursorKey | undefined> {
  const encoded = options.parentArtifactId
    ? options.childCursor
    : options.rootCursor;
  if (!encoded) {
    return undefined;
  }
  const cursor = decodeProjectHierarchyCursor(encoded);
  const kind = options.parentArtifactId ? "child" : "root";
  if (
    cursor.version !== version ||
    cursor.kind !== kind ||
    cursor.parentArtifactId !== options.parentArtifactId
  ) {
    throw new ProjectHierarchyStaleCursorError(version);
  }
  const stored = cursor.createdAt
    ? undefined
    : await tx.artifact.findFirst({
        where: { id: cursor.artifactId, organizationId, projectId },
        select: { createdAt: true, sortOrder: true },
      });
  if (!cursor.createdAt && stored?.sortOrder !== cursor.sortOrder) {
    throw new ProjectHierarchyStaleCursorError(version);
  }
  const createdAt = cursor.createdAt ?? stored?.createdAt;
  if (!createdAt) {
    throw new ProjectHierarchyStaleCursorError(version);
  }
  return {
    artifactId: cursor.artifactId,
    createdAt,
    sortOrder: cursor.sortOrder,
  };
}

async function requireProjectArtifact(
  tx: TransactionClient,
  artifactId: string,
  projectId: string,
  organizationId: string
): Promise<void> {
  const artifact = await tx.artifact.findFirst({
    where: { id: artifactId, organizationId, projectId },
    select: { id: true },
  });
  if (!artifact) {
    throw new ProjectHierarchyParentUnavailableError();
  }
}

function projectTreeCategoryPredicate(
  category: ProjectTreeCategory
): Prisma.Sql {
  switch (category) {
    case ProjectTreeCategory.Prds:
      return Prisma.sql`a.type = ${ArtifactType.DOCUMENT}::"ArtifactType"
        AND a.subtype = ${ArtifactSubtype.PRD}::"ArtifactSubtype"`;
    case ProjectTreeCategory.Features:
      return Prisma.sql`a.type = ${ArtifactType.DOCUMENT}::"ArtifactType"
        AND a.subtype = ${ArtifactSubtype.FEATURE}::"ArtifactSubtype"`;
    case ProjectTreeCategory.Plans:
      return Prisma.sql`a.type = ${ArtifactType.DOCUMENT}::"ArtifactType"
        AND a.subtype = ${ArtifactSubtype.IMPLEMENTATION_PLAN}::"ArtifactSubtype"`;
    case ProjectTreeCategory.Branches:
      return Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

function hashProjectVersionSeed(seed: string | null | undefined): string {
  return createHash("sha256")
    .update(seed ?? "")
    .digest("hex")
    .slice(0, PROJECT_VERSION_HEX_LENGTH);
}

function stackRankCursorPredicate(
  cursor: CursorKey | undefined,
  rank: Prisma.Sql
): Prisma.Sql {
  if (!cursor) {
    return Prisma.empty;
  }
  const trailing = Prisma.sql`(
    a.created_at < ${cursor.createdAt}
    OR (a.created_at = ${cursor.createdAt} AND a.id > ${cursor.artifactId}::uuid)
  )`;
  if (cursor.sortOrder === null) {
    return Prisma.sql`AND ${rank} IS NULL AND ${trailing}`;
  }
  return Prisma.sql`AND (
    ${rank} > ${cursor.sortOrder}
    OR ${rank} IS NULL
    OR (${rank} = ${cursor.sortOrder} AND ${trailing})
  )`;
}

function hierarchyPageSize(options: ProjectTreeQueryFilters): number {
  if (options.parentArtifactId) {
    return Math.min(
      PROJECT_TREE_MAX_CHILD_LIMIT,
      Math.max(1, options.childLimit ?? PROJECT_TREE_DEFAULT_CHILD_LIMIT)
    );
  }
  return Math.min(
    PROJECT_TREE_MAX_ROOT_LIMIT,
    Math.max(1, options.limit ?? PROJECT_TREE_MAX_ROOT_LIMIT)
  );
}

function placementRow(row: HierarchyReadRow): ArtifactPlacementRow {
  return {
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    sortOrder: row.sortOrder,
  };
}

function addParentEdges(
  canonicalParents: Map<string, { linkType: LinkType; parentId: string }>,
  rows: readonly HierarchyReadRow[]
): void {
  for (const row of rows) {
    if (row.parentId) {
      canonicalParents.set(row.id, {
        linkType: LinkType.Produces,
        parentId: row.parentId,
      });
    }
  }
}

function addAncestorEdges(
  canonicalParents: Map<string, { linkType: LinkType; parentId: string }>,
  rows: readonly ParentEdgeRow[]
): void {
  for (const row of rows) {
    canonicalParents.set(row.childId, {
      linkType: LinkType.Produces,
      parentId: row.parentId,
    });
  }
}

function addChildren(
  childrenByParent: Map<string, string[]>,
  rows: readonly HierarchyReadRow[]
): void {
  for (const row of rows) {
    if (!row.parentId) {
      continue;
    }
    const children = childrenByParent.get(row.parentId) ?? [];
    children.push(row.id);
    childrenByParent.set(row.parentId, children);
  }
}

function sortChildren(
  childrenByParent: Map<string, string[]>,
  artifactsById: ReadonlyMap<string, ArtifactPlacementRow>
): void {
  for (const children of childrenByParent.values()) {
    children.sort((leftId, rightId) => {
      const left = artifactsById.get(leftId);
      const right = artifactsById.get(rightId);
      if (!(left && right)) {
        return leftId.localeCompare(rightId);
      }
      return compareStackRankKeys(left, right);
    });
  }
}

function placementState(
  projectId: string,
  version: string,
  artifactsById: Map<string, ArtifactPlacementRow>,
  canonicalParents: Map<string, { linkType: LinkType; parentId: string }>,
  childrenByParent: Map<string, string[]>
): PlacementState {
  return {
    allParentIds: new Map(),
    artifacts: [...artifactsById.values()],
    artifactsById,
    canonicalParents,
    childrenByParent,
    incomingProduces: new Map(),
    parentProjectIds: new Map(),
    projectVersions: { [projectId]: version },
  };
}

function uuidList(ids: string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

async function readVisibleDescendants({
  artifactsById,
  canonicalParents,
  childrenByParent,
  organizationId,
  projectId,
  rootIds,
  tx,
}: VisibleDescendantReadInput): Promise<boolean> {
  let frontier = rootIds;
  let nodeBudgetHit = false;
  for (
    let depth = 1;
    depth < PROJECT_TREE_MAX_VISIBLE_LEVELS && frontier.length > 0;
    depth += 1
  ) {
    const remaining = PROJECT_TREE_MAX_WINDOW_ARTIFACTS - artifactsById.size;
    if (remaining <= 0) {
      return true;
    }
    const descendants = await readBoundedChildren(
      tx,
      projectId,
      organizationId,
      frontier,
      remaining + 1
    );
    if (descendants.length > remaining) {
      nodeBudgetHit = true;
    }
    const included = descendants.slice(0, remaining);
    addParentEdges(canonicalParents, included);
    addChildren(childrenByParent, included);
    for (const row of included) {
      artifactsById.set(row.id, placementRow(row));
    }
    frontier = included.map((row) => row.id);
  }
  return nodeBudgetHit;
}

type CursorKey = {
  artifactId: string;
  createdAt: Date;
  sortOrder: number | null;
};

type HierarchyReadRow = ArtifactPlacementRow & {
  parentId: string | null;
};

type ParentEdgeRow = {
  childId: string;
  parentId: string;
};

type IncomingEdgeRow = {
  sourceId: string;
  targetId: string;
};

type VisibleDescendantReadInput = {
  artifactsById: Map<string, ArtifactPlacementRow>;
  canonicalParents: Map<string, { linkType: LinkType; parentId: string }>;
  childrenByParent: Map<string, string[]>;
  organizationId: string;
  projectId: string;
  rootIds: string[];
  tx: TransactionClient;
};
