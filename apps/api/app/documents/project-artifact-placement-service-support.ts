import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import type { ArtifactTagPermissions } from "@repo/api/src/types/tag";
import { ArtifactType, Prisma, type TransactionClient } from "@repo/database";
import { z } from "zod";
import { compareParentRankedArtifacts } from "@/app/artifacts/artifact-tree-shared";
import { resolveCanonicalParents } from "@/app/artifacts/project-tree-service/canonical-parents";
import {
  compareArtifactRows,
  computeProjectVersion,
  sortedUnique,
} from "@/app/documents/project-artifact-placement-helpers";

export type PlacementActor = {
  userId: string;
  authMethod: "session" | "api_key" | "desktop_session";
  apiKeyId?: string;
  desktopSessionId?: string;
  tagPermissions?: ArtifactTagPermissions;
};

export type ArtifactPlacementRow = {
  id: string;
  projectId: string | null;
  sortOrder: number | null;
  createdAt: Date;
};

export type PlacementState = {
  artifacts: ArtifactPlacementRow[];
  artifactsById: Map<string, ArtifactPlacementRow>;
  canonicalParents: Map<
    string,
    { parentId: string; linkType: LinkType; sortOrder?: number | null }
  >;
  allParentIds: Map<string, string[]>;
  incomingProduces: Map<string, string[]>;
  parentProjectIds: Map<string, string | null>;
  childrenByParent: Map<string, string[]>;
  projectVersions: Record<string, string>;
};

export type PlacementSnapshotRow = {
  artifactId: string;
  projectId: string;
  parentId: string | null;
  sortOrder: number | null;
  createdAt?: string;
};

export type PlacementParentSnapshot = {
  artifactId: string;
  sourceIds: string[];
};

export type PlacementReceiptSnapshot = {
  version: 2;
  rankRows: PlacementSnapshotRow[];
  movedRootParents: PlacementParentSnapshot[];
  rootFields?: PlacementRootFieldSnapshot[];
};

export type PlacementRootFieldSnapshot = {
  artifactId: string;
  status: string;
  assigneeId: string | null;
  priority: Priority | null;
  tagIds: string[];
};

const placementSnapshotRowValidator = z.object({
  artifactId: z.uuid(),
  projectId: z.uuid(),
  parentId: z.uuid().nullable(),
  sortOrder: z.number().int().nullable(),
  createdAt: z.iso.datetime().optional(),
});
const placementSnapshotValidator = z.array(placementSnapshotRowValidator);
const placementReceiptSnapshotValidator = z.object({
  version: z.literal(2),
  rankRows: placementSnapshotValidator,
  movedRootParents: z.array(
    z.object({ artifactId: z.uuid(), sourceIds: z.array(z.uuid()).max(1) })
  ),
  rootFields: z
    .array(
      z.object({
        artifactId: z.uuid(),
        status: z.string(),
        assigneeId: z.uuid().nullable(),
        priority: z.enum(Priority).nullable(),
        tagIds: z.array(z.uuid()),
      })
    )
    .optional(),
});

/** Authorize the live actor, credential, organization, and complete project set. */
export async function authorizePlacementDomain(
  client: PlacementAuthorizationClient,
  organizationId: string,
  projectIds: string[],
  actor: PlacementActor,
  requireWrite: boolean
): Promise<{ authorized: boolean; canWrite: boolean }> {
  const uniqueProjectIds = sortedUnique(projectIds);
  const user = await client.user.findFirst({
    where: { id: actor.userId, organizationId, active: true },
    select: { id: true },
  });
  const projects = await client.project.findMany({
    where: { id: { in: uniqueProjectIds }, organizationId },
    select: { id: true },
  });
  if (!(user && projects.length === uniqueProjectIds.length)) {
    return { authorized: false, canWrite: false };
  }
  const canWrite = await credentialCanWritePlacement(
    client,
    organizationId,
    actor
  );
  return { authorized: requireWrite ? canWrite : true, canWrite };
}

/**
 * Read one locked or snapshot-consistent placement state. With
 * `fieldRevisions` the project version also hashes row fields, the revision
 * the flag-off hierarchy transaction fences on. Without it the version hashes
 * every kind's hierarchy and rank, whichever kinds the state can place, so it
 * is the seed the tree read reports as `mutationVersion` and an all-kind move
 * (ISS-12929) fences on the same value the client rendered.
 */
export async function readPlacementState(
  tx: TransactionClient,
  organizationId: string,
  projectIds: string[],
  includeAllTypes = false,
  fieldRevisions = includeAllTypes
): Promise<PlacementState> {
  const artifacts = await tx.artifact.findMany({
    where: {
      organizationId,
      projectId: { in: projectIds },
      ...(includeAllTypes ? {} : { type: ArtifactType.DOCUMENT }),
    },
    select: { id: true, projectId: true, sortOrder: true, createdAt: true },
  });
  const versionArtifacts =
    includeAllTypes || fieldRevisions
      ? artifacts
      : await tx.artifact.findMany({
          where: { organizationId, projectId: { in: projectIds } },
          select: {
            id: true,
            projectId: true,
            sortOrder: true,
            createdAt: true,
          },
        });
  const revisionArtifacts = fieldRevisions
    ? await tx.artifact.findMany({
        where: { organizationId, projectId: { in: projectIds } },
        select: {
          id: true,
          projectId: true,
          type: true,
          subtype: true,
          sortOrder: true,
          status: true,
          assigneeId: true,
          priority: true,
          updatedAt: true,
          tagArtifacts: { select: { tagId: true } },
        },
      })
    : null;
  const links = await tx.artifactLink.findMany({
    where: {
      organizationId,
      linkType: LinkType.Produces,
      ...(includeAllTypes
        ? {
            OR: [
              { source: { projectId: { in: projectIds } } },
              { target: { projectId: { in: projectIds } } },
            ],
          }
        : { target: { projectId: { in: projectIds } } }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      sourceId: true,
      targetId: true,
      linkType: true,
      sortOrder: true,
      metadata: true,
      createdAt: true,
      source: { select: { projectId: true } },
      target: { select: { projectId: true } },
    },
  });
  const ancestorLinks = await tx.$queryRaw<
    Array<{ sourceId: string; targetId: string }>
  >(Prisma.sql`
    WITH RECURSIVE parent_edges AS (
      SELECT link."source_id", link."target_id"
      FROM "artifact_links" link
      JOIN "artifacts" child ON child."id" = link."target_id"
      WHERE link."organization_id" = ${organizationId}::uuid
        AND link."link_type" = ${LinkType.Produces}::"LinkType"
        AND child."project_id" IN (${Prisma.join(
          projectIds.map((projectId) => Prisma.sql`${projectId}::uuid`)
        )})
      UNION
      SELECT link."source_id", link."target_id"
      FROM "artifact_links" link
      JOIN parent_edges edge ON edge."source_id" = link."target_id"
      WHERE link."organization_id" = ${organizationId}::uuid
        AND link."link_type" = ${LinkType.Produces}::"LinkType"
    )
    SELECT "source_id" AS "sourceId", "target_id" AS "targetId"
    FROM parent_edges
  `);
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact])
  );
  const canonicalParents = new Map<
    string,
    {
      parentId: string;
      linkType: LinkType;
      sortOrder?: number | null;
    }
  >();
  const allParentIds = new Map<string, string[]>();
  const incomingProduces = new Map<string, string[]>();
  const parentProjectIds = new Map(
    artifacts.map((artifact) => [artifact.id, artifact.projectId])
  );
  for (const link of links) {
    const sourceIds = incomingProduces.get(link.targetId) ?? [];
    sourceIds.push(link.sourceId);
    incomingProduces.set(link.targetId, sourceIds);
    parentProjectIds.set(link.sourceId, link.source.projectId);
  }
  for (const link of ancestorLinks) {
    const parentIds = allParentIds.get(link.targetId) ?? [];
    parentIds.push(link.sourceId);
    allParentIds.set(link.targetId, parentIds);
  }
  for (const projectId of projectIds) {
    const projectLinks = links.filter(
      (link) =>
        link.source.projectId === projectId &&
        link.target.projectId === projectId
    );
    const resolved = resolveCanonicalParents(projectLinks);
    for (const [childId, parent] of resolved) {
      canonicalParents.set(childId, parent);
    }
  }
  const childrenByParent = new Map<string, string[]>();
  for (const [childId, parent] of canonicalParents) {
    const children = childrenByParent.get(parent.parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parent.parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) =>
      compareParentRankedArtifacts(
        artifactsById.get(left) ?? missingArtifactRow(left),
        artifactsById.get(right) ?? missingArtifactRow(right),
        canonicalParents
      )
    );
  }
  const projectVersions = Object.create(null) as Record<string, string>;
  for (const projectId of projectIds) {
    projectVersions[projectId] = revisionArtifacts
      ? computeHierarchyProjectVersion(projectId, revisionArtifacts, links)
      : computeProjectVersion(
          versionArtifacts.filter(
            (artifact) => artifact.projectId === projectId
          ),
          canonicalParents
        );
  }
  return {
    artifacts,
    artifactsById,
    canonicalParents,
    allParentIds,
    incomingProduces,
    parentProjectIds,
    childrenByParent,
    projectVersions,
  };
}

function computeHierarchyProjectVersion(
  projectId: string,
  artifacts: readonly {
    id: string;
    projectId: string | null;
    type: ArtifactType;
    subtype: string | null;
    sortOrder: number | null;
    status: string;
    assigneeId: string | null;
    priority: Priority | null;
    updatedAt: Date;
    tagArtifacts: readonly { tagId: string }[];
  }[],
  links: readonly {
    id: string;
    sourceId: string;
    targetId: string;
    createdAt: Date;
    sortOrder: number | null;
    metadata: Prisma.JsonValue;
  }[]
): string {
  const rows = artifacts
    .filter((row) => row.projectId === projectId)
    .map((row) => ({
      id: row.id,
      projectId: row.projectId,
      type: row.type,
      subtype: row.subtype,
      sortOrder: row.sortOrder,
      status: row.status,
      assigneeId: row.assigneeId,
      priority: row.priority,
      updatedAt: row.updatedAt.toISOString(),
      tagIds: row.tagArtifacts.map((tag) => tag.tagId).sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set(rows.map((row) => row.id));
  const edges = links
    .filter((link) => ids.has(link.sourceId) || ids.has(link.targetId))
    .map((link) => ({
      id: link.id,
      sourceId: link.sourceId,
      targetId: link.targetId,
      createdAt: link.createdAt.toISOString(),
      sortOrder: link.sortOrder,
      metadata: link.metadata,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(stableStringify({ rows, edges }))
    .digest("hex");
}

export function siblingsFor(
  state: PlacementState,
  projectId: string,
  parentId: string | null
): string[] {
  const siblings = state.artifacts.filter(
    (artifact) =>
      artifact.projectId === projectId &&
      (state.canonicalParents.get(artifact.id)?.parentId ?? null) === parentId
  );
  siblings.sort((left, right) =>
    parentId
      ? compareParentRankedArtifacts(left, right, state.canonicalParents)
      : compareArtifactRows(left, right)
  );
  return siblings.map((artifact) => artifact.id);
}

export function snapshotRows(
  artifactIds: ReadonlySet<string>,
  state: PlacementState
): PlacementSnapshotRow[] {
  return [...artifactIds].flatMap((artifactId) => {
    const artifact = state.artifactsById.get(artifactId);
    if (!artifact?.projectId) {
      return [];
    }
    return [
      {
        artifactId,
        projectId: artifact.projectId,
        parentId: state.canonicalParents.get(artifactId)?.parentId ?? null,
        sortOrder: effectiveSortOrder(state, artifact),
        createdAt: artifact.createdAt.toISOString(),
      },
    ];
  });
}

export function emptyReceiptSnapshot(): PlacementReceiptSnapshot {
  return { version: 2, rankRows: [], movedRootParents: [] };
}

export function parseReceiptSnapshot(
  value: unknown,
  sourceArtifactIds: string[]
): PlacementReceiptSnapshot | null {
  const current = placementReceiptSnapshotValidator.safeParse(value);
  if (
    current.success &&
    hasExactParentSnapshot(current.data.movedRootParents, sourceArtifactIds) &&
    (!current.data.rootFields ||
      hasExactRootFieldSnapshot(current.data.rootFields, sourceArtifactIds))
  ) {
    return current.data;
  }
  const legacy = placementSnapshotValidator.safeParse(value);
  if (!legacy.success) {
    return null;
  }
  const byId = new Map(legacy.data.map((row) => [row.artifactId, row]));
  if (sourceArtifactIds.some((artifactId) => !byId.has(artifactId))) {
    return null;
  }
  return {
    version: 2,
    rankRows: legacy.data,
    movedRootParents: sourceArtifactIds.map((artifactId) => {
      const parentId = byId.get(artifactId)?.parentId;
      return { artifactId, sourceIds: parentId ? [parentId] : [] };
    }),
  };
}

function hasExactRootFieldSnapshot(
  snapshots: PlacementRootFieldSnapshot[],
  sourceArtifactIds: string[]
): boolean {
  const expected = new Set(sourceArtifactIds);
  return (
    snapshots.length === expected.size &&
    new Set(snapshots.map((row) => row.artifactId)).size === snapshots.length &&
    snapshots.every((row) => expected.has(row.artifactId))
  );
}

function hasExactParentSnapshot(
  snapshots: PlacementParentSnapshot[],
  sourceArtifactIds: string[]
): boolean {
  const expected = new Set(sourceArtifactIds);
  if (
    expected.size !== sourceArtifactIds.length ||
    snapshots.length !== expected.size
  ) {
    return false;
  }
  const actual = new Set<string>();
  for (const snapshot of snapshots) {
    if (
      !(expected.has(snapshot.artifactId) && !actual.has(snapshot.artifactId))
    ) {
      return false;
    }
    actual.add(snapshot.artifactId);
  }
  return actual.size === expected.size;
}

type PlacementAuthorizationClient = Pick<
  TransactionClient,
  "apiKey" | "desktopSession" | "project" | "user"
>;

async function credentialCanWritePlacement(
  client: PlacementAuthorizationClient,
  organizationId: string,
  actor: PlacementActor
): Promise<boolean> {
  if (actor.authMethod === "session") {
    return true;
  }
  if (actor.authMethod === "api_key") {
    if (!actor.apiKeyId) {
      return false;
    }
    return (
      (await client.apiKey.findFirst({
        where: {
          id: actor.apiKeyId,
          organizationId,
          userId: actor.userId,
          revokedAt: null,
          scopes: { has: ApiKeyScope.Write },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      })) !== null
    );
  }
  if (!actor.desktopSessionId) {
    return false;
  }
  return (
    (await client.desktopSession.findFirst({
      where: {
        id: actor.desktopSessionId,
        organizationId,
        userId: actor.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    })) !== null
  );
}

/** Resolve only receipt-owned parent links that still exist in current state. */
export function receiptExistingParentIds(
  snapshot: PlacementReceiptSnapshot,
  artifactIds: string[],
  state: PlacementState
): Map<string, string | null> {
  return new Map(
    artifactIds.map((artifactId) => {
      const parentId = receiptParentId(snapshot, artifactId);
      const exists = parentId
        ? state.incomingProduces.get(artifactId)?.includes(parentId)
        : false;
      return [artifactId, exists ? parentId : null];
    })
  );
}

/** Resolve desired parent links that a restore must create rather than preserve. */
export function receiptCreatedParentIds(
  desired: PlacementReceiptSnapshot,
  artifactIds: string[],
  state: PlacementState
): Map<string, string | null> {
  return new Map(
    artifactIds.map((artifactId) => {
      const parentId = receiptParentId(desired, artifactId);
      const exists = parentId
        ? state.incomingProduces.get(artifactId)?.includes(parentId)
        : false;
      return [artifactId, parentId && !exists ? parentId : null];
    })
  );
}

/** Serialize parent ids into the receipt snapshot representation. */
export function parentIdsSnapshot(
  parentIds: ReadonlyMap<string, string | null>,
  artifactIds: string[]
): PlacementReceiptSnapshot["movedRootParents"] {
  return artifactIds.map((artifactId) => {
    const parentId = parentIds.get(artifactId);
    return { artifactId, sourceIds: parentId ? [parentId] : [] };
  });
}

function receiptParentId(
  snapshot: PlacementReceiptSnapshot,
  artifactId: string
): string | null {
  return (
    snapshot.movedRootParents.find((parent) => parent.artifactId === artifactId)
      ?.sourceIds[0] ?? null
  );
}

function missingArtifactRow(id: string): ArtifactPlacementRow {
  return { id, projectId: null, sortOrder: null, createdAt: new Date(0) };
}

function effectiveSortOrder(
  state: PlacementState,
  artifact: ArtifactPlacementRow
): number | null {
  const parent = state.canonicalParents.get(artifact.id);
  return parent ? (parent.sortOrder ?? null) : artifact.sortOrder;
}

/**
 * The flag-on placement state: every artifact kind is placeable (ISS-12929,
 * PRD-725 all-kind Project Detail and board), fenced on the hierarchy-only
 * version every flag-on read reports.
 */
export function readAllKindsPlacementState(
  tx: TransactionClient,
  organizationId: string,
  projectIds: string[]
): Promise<PlacementState> {
  return readPlacementState(tx, organizationId, projectIds, true, false);
}
