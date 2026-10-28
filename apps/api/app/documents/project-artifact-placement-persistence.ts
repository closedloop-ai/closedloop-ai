import { LinkType } from "@repo/api/src/types/artifact";
import type {
  CommittedProjectArtifactPlacement,
  ProjectArtifactPlacementSourceRoot,
} from "@repo/api/src/types/project-artifact-placement";
import { Prisma, type TransactionClient } from "@repo/database";
import { STACK_RANK_GAP } from "@/app/documents/document-sort-order";
import { parseNeighborhoodKey } from "@/app/documents/project-artifact-placement-helpers";
import {
  emptyReceiptSnapshot,
  type PlacementReceiptSnapshot,
  type PlacementSnapshotRow,
} from "@/app/documents/project-artifact-placement-service-support";

export type PlacementPlan = {
  mode: "place" | "restore";
  affectedArtifactIds: string[];
  affectedProjectIds: string[];
  beforeState: PlacementSnapshotRow[];
  receiptBeforeState: PlacementReceiptSnapshot;
  destinationParentId: string | null;
  createdParentIds: Map<string, string | null>;
  resultParentIds: Map<string, string | null>;
  currentParentIds: Map<string, string | null>;
  movedArtifactIds: string[];
  sourceArtifactIds: string[];
  sourceRootMappings: ProjectArtifactPlacementSourceRoot[];
  parentProjections: Map<string, PlacementParentProjection[]>;
  placement: CommittedProjectArtifactPlacement;
  rankOrders: Map<string, string[]>;
  restoreState?: PlacementReceiptSnapshot;
};

export type PlacementParentProjection = {
  parentId: string;
  canonical: boolean;
  suppressed: boolean;
};

/** Persist a validated placement plan inside the caller-owned transaction. */
export async function applyPlacementPlan(
  tx: TransactionClient,
  organizationId: string,
  plan: PlacementPlan
): Promise<void> {
  if (plan.mode === "restore") {
    await swapCanonicalParents(
      tx,
      organizationId,
      plan.sourceArtifactIds.map((artifactId) => ({
        artifactId,
        beforeParentId: plan.currentParentIds.get(artifactId) ?? null,
        afterParentId:
          plan.restoreState?.movedRootParents.find(
            (parent) => parent.artifactId === artifactId
          )?.sourceIds[0] ?? null,
        createParentId: plan.createdParentIds.get(artifactId) ?? null,
      }))
    );
    await writeParentProjections(tx, organizationId, plan.parentProjections);
    await restoreSnapshot(
      tx,
      organizationId,
      plan.restoreState ?? emptyReceiptSnapshot()
    );
    return;
  }

  if (plan.movedArtifactIds.length > 0) {
    await tx.artifact.updateMany({
      where: { organizationId, id: { in: plan.movedArtifactIds } },
      data: { projectId: plan.placement.destinationProjectId },
    });
  }
  await swapCanonicalParents(
    tx,
    organizationId,
    plan.sourceArtifactIds.map((artifactId) => ({
      artifactId,
      beforeParentId: plan.currentParentIds.get(artifactId) ?? null,
      afterParentId: plan.destinationParentId,
      createParentId: plan.createdParentIds.get(artifactId) ?? null,
    }))
  );
  await writeParentProjections(tx, organizationId, plan.parentProjections);
  await writeRankOrders(tx, organizationId, plan.rankOrders);
}

async function restoreSnapshot(
  tx: TransactionClient,
  organizationId: string,
  snapshot: PlacementReceiptSnapshot
): Promise<void> {
  const valueRows = snapshot.rankRows.map(
    (row) => Prisma.sql`(${row.artifactId}::uuid, ${row.projectId}::uuid)`
  );
  if (valueRows.length > 0) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "artifacts"
      SET "project_id" = data.project_id
      FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, project_id)
      WHERE "artifacts"."id" = data.id
        AND "artifacts"."organization_id" = ${organizationId}::uuid
    `);
  }
  const rootRows = snapshot.rankRows.filter((row) => row.parentId === null);
  if (rootRows.length > 0) {
    const rootValues = rootRows.map(
      (row) => Prisma.sql`(${row.artifactId}::uuid, ${row.sortOrder}::int)`
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "artifacts"
      SET "sort_order" = data.sort_order
      FROM (VALUES ${Prisma.join(rootValues)}) AS data(id, sort_order)
      WHERE "artifacts"."id" = data.id
        AND "artifacts"."organization_id" = ${organizationId}::uuid
    `);
  }
  const childRows = snapshot.rankRows.filter(
    (row): row is PlacementSnapshotRow & { parentId: string } =>
      row.parentId !== null
  );
  if (childRows.length > 0) {
    const childValues = childRows.map(
      (row) =>
        Prisma.sql`(${row.parentId}::uuid, ${row.artifactId}::uuid, ${row.sortOrder}::int)`
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "artifact_links"
      SET "sort_order" = data.sort_order
      FROM (VALUES ${Prisma.join(childValues)}) AS data(source_id, target_id, sort_order)
      WHERE "artifact_links"."organization_id" = ${organizationId}::uuid
        AND "artifact_links"."source_id" = data.source_id
        AND "artifact_links"."target_id" = data.target_id
        AND "artifact_links"."link_type" = ${LinkType.Produces}::"LinkType"
    `);
  }
}

async function swapCanonicalParents(
  tx: TransactionClient,
  organizationId: string,
  parents: Array<{
    artifactId: string;
    beforeParentId: string | null;
    afterParentId: string | null;
    createParentId: string | null;
  }>
): Promise<void> {
  const changed = parents.filter(
    (parent) => parent.beforeParentId !== parent.afterParentId
  );
  for (const parent of changed) {
    if (parent.beforeParentId) {
      await tx.artifactLink.deleteMany({
        where: {
          organizationId,
          sourceId: parent.beforeParentId,
          targetId: parent.artifactId,
          linkType: LinkType.Produces,
        },
      });
    }
  }
  const data = changed.flatMap((parent) =>
    parent.createParentId
      ? [
          {
            organizationId,
            sourceId: parent.createParentId,
            targetId: parent.artifactId,
            linkType: LinkType.Produces,
          },
        ]
      : []
  );
  if (data.length > 0) {
    await tx.artifactLink.createMany({ data, skipDuplicates: true });
  }
}

async function writeRankOrders(
  tx: TransactionClient,
  organizationId: string,
  rankOrders: ReadonlyMap<string, string[]>
): Promise<void> {
  const rootRanks: Array<{ artifactId: string; sortOrder: number }> = [];
  const childRanks: Array<{
    artifactId: string;
    parentId: string;
    sortOrder: number;
  }> = [];
  for (const [key, artifactIds] of rankOrders) {
    const [, parentId] = parseNeighborhoodKey(key);
    artifactIds.forEach((artifactId, index) => {
      const sortOrder = index * STACK_RANK_GAP;
      if (parentId) {
        childRanks.push({ artifactId, parentId, sortOrder });
      } else {
        rootRanks.push({ artifactId, sortOrder });
      }
    });
  }
  if (rootRanks.length > 0) {
    const values = rootRanks.map(
      ({ artifactId, sortOrder }) =>
        Prisma.sql`(${artifactId}::uuid, ${sortOrder}::int)`
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "artifacts"
      SET "sort_order" = data.sort_order
      FROM (VALUES ${Prisma.join(values)}) AS data(id, sort_order)
      WHERE "artifacts"."id" = data.id
        AND "artifacts"."organization_id" = ${organizationId}::uuid
    `);
  }
  if (childRanks.length > 0) {
    const values = childRanks.map(
      ({ artifactId, parentId, sortOrder }) =>
        Prisma.sql`(${parentId}::uuid, ${artifactId}::uuid, ${sortOrder}::int)`
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "artifact_links"
      SET "sort_order" = data.sort_order
      FROM (VALUES ${Prisma.join(values)}) AS data(source_id, target_id, sort_order)
      WHERE "artifact_links"."organization_id" = ${organizationId}::uuid
        AND "artifact_links"."source_id" = data.source_id
        AND "artifact_links"."target_id" = data.target_id
        AND "artifact_links"."link_type" = ${LinkType.Produces}::"LinkType"
    `);
  }
}

async function writeParentProjections(
  tx: TransactionClient,
  organizationId: string,
  projectionsByArtifact: ReadonlyMap<string, PlacementParentProjection[]>
): Promise<void> {
  const values = [...projectionsByArtifact].flatMap(
    ([artifactId, projections]) =>
      projections.map(
        ({ parentId, canonical, suppressed }) =>
          Prisma.sql`(${parentId}::uuid, ${artifactId}::uuid, ${canonical}::boolean, ${suppressed}::boolean)`
      )
  );
  if (values.length === 0) {
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "artifact_links"
    SET "metadata" = jsonb_set(
      COALESCE("artifact_links"."metadata", '{}'::jsonb),
      '{hierarchy}',
      COALESCE("artifact_links"."metadata" -> 'hierarchy', '{}'::jsonb) ||
        jsonb_build_object(
          'canonical', data.canonical,
          'managed', true,
          'suppressed', data.suppressed,
          'version', 1
        ),
      true
    )
    FROM (VALUES ${Prisma.join(values)}) AS data(source_id, target_id, canonical, suppressed)
    WHERE "artifact_links"."organization_id" = ${organizationId}::uuid
      AND "artifact_links"."source_id" = data.source_id
      AND "artifact_links"."target_id" = data.target_id
      AND "artifact_links"."link_type" = ${LinkType.Produces}::"LinkType"
  `);
}
