import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementErrorReason,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
  ProjectArtifactPlacementVerificationStatus,
} from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import { ArtifactType, withDb } from "@repo/database";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createArtifact,
  createLineageArtifact,
  seedTenant,
  type Tenant,
  versions,
} from "@/__tests__/support/integration/project-artifact-placement-tenant.test-fixtures";
import {
  applyProjectArtifactPlacementInTransaction,
  projectArtifactPlacementService,
} from "@/app/documents/project-artifact-placement-service";
import { projectArtifactPlacementVerificationService } from "@/app/documents/project-artifact-placement-verification-service";
import { captureArtifactFieldEditAnalytics } from "@/lib/artifact-field-edit-analytics";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

vi.mock("@/lib/artifact-field-edit-analytics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/artifact-field-edit-analytics")
  >()),
  captureArtifactFieldEditAnalytics: vi.fn(),
}));

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

async function place(tenant: Tenant, idempotencyKey: string) {
  return projectArtifactPlacementService.placeProjectArtifacts(
    tenant.sourceProjectId,
    tenant.organizationId,
    {
      kind: ProjectArtifactPlacementKind.Place,
      sourceArtifactIds: [tenant.rootId],
      destinationProjectId: tenant.destinationProjectId,
      position: ProjectArtifactPlacementPosition.Root,
      expectedProjectVersions: await versions(tenant),
      idempotencyKey,
      source: ProjectArtifactPlacementSource.Api,
    },
    { userId: tenant.userId, authMethod: "session" }
  );
}

function readTenantState(tenant: Tenant) {
  return withDb(async (db) => {
    const artifacts = await db.artifact.findMany({
      where: { id: { in: [tenant.rootId, tenant.childId] } },
      orderBy: { id: "asc" },
      select: { id: true, projectId: true, sortOrder: true },
    });
    const links = await db.artifactLink.findMany({
      where: {
        organizationId: tenant.organizationId,
        sourceId: tenant.rootId,
        targetId: tenant.childId,
        linkType: LinkType.Produces,
      },
      select: { sourceId: true, targetId: true },
    });
    const activity = await db.artifactActivityEvent.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        artifactId: true,
        after: true,
        before: true,
        transactionId: true,
        undoOfTransactionId: true,
      },
    });
    const placementEvents = activity.filter(
      ({ after }) =>
        after !== null &&
        typeof after === "object" &&
        !Array.isArray(after) &&
        "receipt" in after
    ).length;
    return { artifacts, links, placementEvents, activity };
  });
}

describe.skipIf(!hasDatabase)(
  "projectArtifactPlacementService (Postgres)",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await organizations.cleanup();
    });

    it("commits a cross-project subtree and restores the stored snapshot on undo", async () => {
      const tenant = await seedTenant(organizations);
      const untouchedParentId = await createArtifact(
        tenant.organizationId,
        tenant.userId,
        tenant.sourceProjectId,
        "Untouched Parent",
        2048
      );
      const untouchedSiblingId = await createArtifact(
        tenant.organizationId,
        tenant.userId,
        tenant.sourceProjectId,
        "Untouched Sibling",
        3072
      );
      const lineageProjectId = await createTestProject(
        tenant.organizationId,
        tenant.userId,
        { name: "Placement Lineage" }
      );
      const lineageParentId = await createArtifact(
        tenant.organizationId,
        tenant.userId,
        lineageProjectId,
        "Cross-project Lineage Parent",
        4096
      );
      await withDb((db) =>
        db.artifactLink.createMany({
          data: [
            {
              organizationId: tenant.organizationId,
              sourceId: untouchedParentId,
              targetId: untouchedSiblingId,
              linkType: LinkType.Produces,
            },
            {
              organizationId: tenant.organizationId,
              sourceId: lineageParentId,
              targetId: tenant.rootId,
              linkType: LinkType.Produces,
            },
          ],
        })
      );
      const committed = await place(tenant, "placement-integration-commit");
      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(committed.error.message);
      }
      const moved = await readTenantState(tenant);
      expect(moved.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.destinationProjectId,
        tenant.destinationProjectId,
      ]);
      expect(moved.links).toEqual([
        { sourceId: tenant.rootId, targetId: tenant.childId },
      ]);
      expect(moved.placementEvents).toBe(1);
      expect(moved.activity.map(({ artifactId }) => artifactId).sort()).toEqual(
        [tenant.rootId, tenant.rootId, tenant.childId].sort()
      );
      expect(moved.activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: tenant.rootId,
            after: expect.objectContaining({
              movedDescendantCount: 1,
              source: ProjectArtifactPlacementSource.Api,
            }),
            before: expect.objectContaining({
              movedDescendantCount: 1,
              source: ProjectArtifactPlacementSource.Api,
            }),
          }),
        ])
      );
      await expect(
        countProducesLink(
          tenant.organizationId,
          untouchedParentId,
          untouchedSiblingId
        )
      ).resolves.toBe(1);
      await expect(
        countProducesLink(tenant.organizationId, lineageParentId, tenant.rootId)
      ).resolves.toBe(1);

      const undone =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Undo,
            undoOfTransactionId: committed.value.transactionId,
            expectedProjectVersions: committed.value.projectVersions,
            idempotencyKey: "placement-integration-undo",
            source: ProjectArtifactPlacementSource.Undo,
          },
          { userId: tenant.userId, authMethod: "session" }
        );

      expect(undone.ok).toBe(true);
      if (!undone.ok) {
        throw new Error(undone.error.message);
      }
      expect(undone.value.affectedProjectIds).toEqual(
        [tenant.sourceProjectId, tenant.destinationProjectId].sort()
      );
      expect(Object.keys(undone.value.projectVersions).sort()).toEqual(
        [tenant.sourceProjectId, tenant.destinationProjectId].sort()
      );
      const restored = await readTenantState(tenant);
      expect(restored.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.sourceProjectId,
        tenant.sourceProjectId,
      ]);
      expect(restored.links).toEqual([
        { sourceId: tenant.rootId, targetId: tenant.childId },
      ]);
      expect(restored.placementEvents).toBe(2);
      expect(restored.activity).toHaveLength(6);
      expect(restored.activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: tenant.rootId,
            undoOfTransactionId: committed.value.transactionId,
          }),
        ])
      );
      await expect(
        countProducesLink(
          tenant.organizationId,
          untouchedParentId,
          untouchedSiblingId
        )
      ).resolves.toBe(1);
      await expect(
        countProducesLink(tenant.organizationId, lineageParentId, tenant.rootId)
      ).resolves.toBe(1);
    });

    it("attributes a board-sourced placement status edit to Board with its commit group", async () => {
      const tenant = await seedTenant(organizations);
      vi.mocked(captureArtifactFieldEditAnalytics).mockClear();
      const result =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Place,
            sourceArtifactIds: [tenant.rootId],
            destinationProjectId: tenant.destinationProjectId,
            position: ProjectArtifactPlacementPosition.Root,
            rootUpdates: { status: DocumentStatus.Approved },
            surface: ArtifactStatusEditSurface.Board,
            expectedProjectVersions: await versions(tenant),
            idempotencyKey: "placement-board-status-analytics",
            source: ProjectArtifactPlacementSource.Pointer,
          },
          { userId: tenant.userId, authMethod: "session" }
        );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected board status placement to commit");
      }
      expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledOnce();
      expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
        before: DocumentStatus.Draft,
        after: DocumentStatus.Approved,
        artifactCount: 1,
        provenance: {
          surface: ArtifactStatusEditSurface.Board,
          commitGroupId: result.value.transactionId,
        },
        commitGroupId: result.value.transactionId,
      });
    });

    it("does not claim Board provenance for an unattributed placement status edit", async () => {
      const tenant = await seedTenant(organizations);
      vi.mocked(captureArtifactFieldEditAnalytics).mockClear();
      const result =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Place,
            sourceArtifactIds: [tenant.rootId],
            destinationProjectId: tenant.destinationProjectId,
            position: ProjectArtifactPlacementPosition.Root,
            rootUpdates: { status: DocumentStatus.Approved },
            expectedProjectVersions: await versions(tenant),
            idempotencyKey: "placement-unattributed-status-analytics",
            source: ProjectArtifactPlacementSource.Keyboard,
          },
          { userId: tenant.userId, authMethod: "session" }
        );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected unattributed status placement to commit");
      }
      expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledOnce();
      expect(captureArtifactFieldEditAnalytics).toHaveBeenCalledWith({
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
        before: DocumentStatus.Draft,
        after: DocumentStatus.Approved,
        artifactCount: 1,
        commitGroupId: result.value.transactionId,
      });
    });

    it("promotes a root while preserving pre-existing destination-project lineage", async () => {
      const tenant = await seedTenant(organizations);
      const destinationParentId = await createArtifact(
        tenant.organizationId,
        tenant.userId,
        tenant.destinationProjectId,
        "Destination Lineage Parent",
        0
      );
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: tenant.organizationId,
            sourceId: destinationParentId,
            targetId: tenant.rootId,
            linkType: LinkType.Produces,
          },
        })
      );

      const result = await place(
        tenant,
        "placement-integration-destination-parent-refusal"
      );

      expect(result.ok).toBe(true);
      const state = await readTenantState(tenant);
      expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.destinationProjectId,
        tenant.destinationProjectId,
      ]);
      expect(state.placementEvents).toBe(1);
      await expect(
        countProducesLink(
          tenant.organizationId,
          destinationParentId,
          tenant.rootId
        )
      ).resolves.toBe(1);
      await expect(
        hierarchyMetadata(
          tenant.organizationId,
          destinationParentId,
          tenant.rootId
        )
      ).resolves.toMatchObject({
        canonical: false,
        managed: true,
        suppressed: true,
        version: 1,
      });
    });

    it.each([ArtifactType.BRANCH, ArtifactType.SESSION] as const)(
      "preserves a destination-project %s lineage parent outside the document projection",
      async (parentType) => {
        const tenant = await seedTenant(organizations);
        const destinationParentId = await createLineageArtifact(
          tenant.organizationId,
          tenant.userId,
          tenant.destinationProjectId,
          parentType
        );
        await withDb((db) =>
          db.artifactLink.create({
            data: {
              organizationId: tenant.organizationId,
              sourceId: destinationParentId,
              targetId: tenant.rootId,
              linkType: LinkType.Produces,
            },
          })
        );

        const result = await place(
          tenant,
          `placement-${parentType.toLowerCase()}-parent-refusal`
        );

        expect(result.ok).toBe(true);
        const state = await readTenantState(tenant);
        expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
          tenant.destinationProjectId,
          tenant.destinationProjectId,
        ]);
        expect(state.placementEvents).toBe(1);
        await expect(
          countProducesLink(
            tenant.organizationId,
            destinationParentId,
            tenant.rootId
          )
        ).resolves.toBe(1);
        await expect(
          hierarchyMetadata(
            tenant.organizationId,
            destinationParentId,
            tenant.rootId
          )
        ).resolves.toMatchObject({
          canonical: false,
          managed: true,
          suppressed: true,
          version: 1,
        });
      }
    );

    it("verifies durable after-state and safely recovers detected drift", async () => {
      const tenant = await seedTenant(organizations);
      const committed = await place(tenant, "placement-verification-commit");
      if (!committed.ok) {
        throw new Error(committed.error.message);
      }
      await withDb((db) =>
        db.artifactLink.update({
          where: {
            sourceId_targetId_linkType: {
              sourceId: tenant.rootId,
              targetId: tenant.childId,
              linkType: LinkType.Produces,
            },
          },
          data: { sortOrder: 8192 },
        })
      );
      const actor = { userId: tenant.userId, authMethod: "session" as const };
      const verification =
        await projectArtifactPlacementVerificationService.verifyProjectArtifactPlacement(
          {
            routeProjectId: tenant.sourceProjectId,
            organizationId: tenant.organizationId,
            transactionId: committed.value.transactionId,
            actor,
          }
        );
      expect(verification).toMatchObject({
        ok: true,
        value: {
          status: ProjectArtifactPlacementVerificationStatus.Drifted,
          driftedArtifactIds: [tenant.childId],
          canRecover: true,
        },
      });

      const recovered =
        await projectArtifactPlacementVerificationService.recoverProjectArtifactPlacement(
          {
            routeProjectId: tenant.sourceProjectId,
            organizationId: tenant.organizationId,
            transactionId: committed.value.transactionId,
            expectedProjectVersions: await versions(tenant),
            actor,
          }
        );
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          status: ProjectArtifactPlacementVerificationStatus.Consistent,
          driftedArtifactIds: [],
        },
      });
      const childLink = await withDb((db) =>
        db.artifactLink.findUniqueOrThrow({
          where: {
            sourceId_targetId_linkType: {
              sourceId: tenant.rootId,
              targetId: tenant.childId,
              linkType: LinkType.Produces,
            },
          },
          select: { sortOrder: true },
        })
      );
      expect(childLink.sortOrder).toBe(1024);
    });

    it("revalidates a session actor inside the locked transaction", async () => {
      const tenant = await seedTenant(organizations);
      const expectedProjectVersions = await versions(tenant);
      deactivateUserBeforeLockedPlacement(tenant.userId);

      const result =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Place,
            sourceArtifactIds: [tenant.rootId],
            destinationProjectId: tenant.destinationProjectId,
            position: ProjectArtifactPlacementPosition.Root,
            expectedProjectVersions,
            idempotencyKey: "placement-integration-revoked-actor",
            source: ProjectArtifactPlacementSource.Api,
          },
          { userId: tenant.userId, authMethod: "session" }
        );

      expect(result).toMatchObject({
        ok: false,
        error: {
          status: Status.NotFound,
          detail: {
            reason: ProjectArtifactPlacementErrorReason.PermissionDenied,
          },
        },
      });
      const state = await readTenantState(tenant);
      expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.sourceProjectId,
        tenant.sourceProjectId,
      ]);
      expect(state.placementEvents).toBe(0);
      expect(state.activity).toHaveLength(0);
    });

    it("serializes simultaneous moves so only the first stale-view intent commits", async () => {
      const tenant = await seedTenant(organizations);
      const expectedProjectVersions = await versions(tenant);
      const request = (idempotencyKey: string) =>
        projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Place,
            sourceArtifactIds: [tenant.rootId],
            destinationProjectId: tenant.destinationProjectId,
            position: ProjectArtifactPlacementPosition.Root,
            expectedProjectVersions,
            idempotencyKey,
            source: ProjectArtifactPlacementSource.Api,
          },
          { userId: tenant.userId, authMethod: "session" }
        );

      const results = await Promise.all([
        request("placement-simultaneous-a"),
        request("placement-simultaneous-b"),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({
            status: Status.Conflict,
            detail: expect.objectContaining({
              reason: ProjectArtifactPlacementErrorReason.StaleVersion,
            }),
          }),
        }),
      ]);
      const state = await readTenantState(tenant);
      expect(state.placementEvents).toBe(1);
      expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.destinationProjectId,
        tenant.destinationProjectId,
      ]);
    });

    it("refuses a stale undo and leaves the committed move intact", async () => {
      const tenant = await seedTenant(organizations);
      const committed = await place(
        tenant,
        "placement-integration-stale-place"
      );
      if (!committed.ok) {
        throw new Error(committed.error.message);
      }
      await withDb((db) =>
        db.artifact.update({
          where: { id: tenant.rootId },
          data: { sortOrder: 4096 },
        })
      );

      const undone =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Undo,
            undoOfTransactionId: committed.value.transactionId,
            expectedProjectVersions: committed.value.projectVersions,
            idempotencyKey: "placement-integration-stale-undo",
            source: ProjectArtifactPlacementSource.Undo,
          },
          { userId: tenant.userId, authMethod: "session" }
        );

      expect(undone).toMatchObject({
        ok: false,
        error: {
          status: Status.Conflict,
          detail: { reason: ProjectArtifactPlacementErrorReason.StaleVersion },
        },
      });
      const state = await readTenantState(tenant);
      expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.destinationProjectId,
        tenant.destinationProjectId,
      ]);
      expect(state.placementEvents).toBe(1);
    });

    it("refuses a populated destination in another organization without writes", async () => {
      const tenant = await seedTenant(organizations);
      const foreignOrganizationId = await organizations.create();
      const foreignUser = await createTestUser(foreignOrganizationId);
      const foreignProjectId = await createTestProject(
        foreignOrganizationId,
        foreignUser.id
      );
      await createArtifact(
        foreignOrganizationId,
        foreignUser.id,
        foreignProjectId,
        "Foreign Target",
        0
      );
      const sourceState =
        await projectArtifactPlacementService.getProjectPlacementState(
          tenant.sourceProjectId,
          tenant.organizationId,
          { userId: tenant.userId, authMethod: "session" }
        );
      if (!sourceState) {
        throw new Error("expected source version");
      }
      const sourceVersion = sourceState.projectVersion;

      const result =
        await projectArtifactPlacementService.placeProjectArtifacts(
          tenant.sourceProjectId,
          tenant.organizationId,
          {
            kind: ProjectArtifactPlacementKind.Place,
            sourceArtifactIds: [tenant.rootId],
            destinationProjectId: foreignProjectId,
            position: ProjectArtifactPlacementPosition.Root,
            expectedProjectVersions: {
              [tenant.sourceProjectId]: sourceVersion,
              [foreignProjectId]: "foreign-version",
            },
            idempotencyKey: "placement-integration-foreign",
            source: ProjectArtifactPlacementSource.Api,
          },
          { userId: tenant.userId, authMethod: "session" }
        );

      expect(result).toMatchObject({
        ok: false,
        error: {
          status: Status.NotFound,
          detail: {
            reason: ProjectArtifactPlacementErrorReason.PermissionDenied,
          },
        },
      });
      const state = await readTenantState(tenant);
      expect(state.artifacts.map((artifact) => artifact.projectId)).toEqual([
        tenant.sourceProjectId,
        tenant.sourceProjectId,
      ]);
      expect(state.placementEvents).toBe(0);
      expect(state.activity).toHaveLength(0);
    });

    it("rolls back claim, links, ranks, and project changes after a late write failure", async () => {
      const tenant = await seedTenant(organizations);
      const before = await readTenantState(tenant);
      abortPlacementActivityWrites();

      await expect(
        place(tenant, "placement-integration-rollback")
      ).rejects.toThrow("placement integration rollback");

      expect(await readTenantState(tenant)).toEqual(before);
    });

    it("rolls back caller-owned writes when a transaction validator throws", async () => {
      const tenant = await seedTenant(organizations);
      const expectedProjectVersions = await versions(tenant);
      const before = await readTenantState(tenant);
      const originalProject = await withDb((db) =>
        db.project.findUniqueOrThrow({
          where: { id: tenant.sourceProjectId },
          select: { name: true },
        })
      );

      await expect(
        withDb.tx(async (tx) => {
          await tx.project.update({
            where: { id: tenant.sourceProjectId },
            data: { name: "Caller transaction pending" },
            select: { id: true },
          });
          await applyProjectArtifactPlacementInTransaction(tx, {
            routeProjectId: tenant.sourceProjectId,
            organizationId: tenant.organizationId,
            input: {
              kind: ProjectArtifactPlacementKind.Place,
              sourceArtifactIds: [tenant.rootId],
              destinationProjectId: tenant.destinationProjectId,
              position: ProjectArtifactPlacementPosition.Root,
              expectedProjectVersions,
              idempotencyKey: "placement-validator-rollback",
              source: ProjectArtifactPlacementSource.Api,
            },
            actor: { userId: tenant.userId, authMethod: "session" },
            validatePlacement: ({ tx: validatorTx }) => {
              expect(validatorTx).toBe(tx);
              throw new Error("caller placement validator rollback");
            },
          });
        })
      ).rejects.toThrow("caller placement validator rollback");

      await expect(
        withDb((db) =>
          db.project.findUniqueOrThrow({
            where: { id: tenant.sourceProjectId },
            select: { name: true },
          })
        )
      ).resolves.toEqual(originalProject);
      expect(await readTenantState(tenant)).toEqual(before);
    });
  }
);

function abortPlacementActivityWrites(): void {
  const openTransaction = withDb.tx;
  vi.spyOn(withDb, "tx").mockImplementation((run, options) =>
    openTransaction((tx) => run(withActivityAbort(tx)), options)
  );
}

function withActivityAbort(tx: TransactionClient): TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "artifactActivityEvent") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(value, {
        get(delegate, key, delegateReceiver) {
          if (key !== "createMany") {
            return Reflect.get(delegate, key, delegateReceiver);
          }
          return () => abortPlacementTransaction(target);
        },
      });
    },
  });
}

async function abortPlacementTransaction(
  tx: TransactionClient
): Promise<never> {
  await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'placement integration rollback'; END $$`;
  throw new Error("placement integration rollback");
}

function countProducesLink(
  organizationId: string,
  sourceId: string,
  targetId: string
): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({
      where: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.Produces,
      },
    })
  );
}

async function hierarchyMetadata(
  organizationId: string,
  sourceId: string,
  targetId: string
): Promise<unknown> {
  const link = await withDb((db) =>
    db.artifactLink.findFirstOrThrow({
      where: {
        organizationId,
        sourceId,
        targetId,
        linkType: LinkType.Produces,
      },
      select: { metadata: true },
    })
  );
  return link.metadata && typeof link.metadata === "object"
    ? Reflect.get(link.metadata, "hierarchy")
    : undefined;
}

function deactivateUserBeforeLockedPlacement(userId: string): void {
  const openTransaction = withDb.tx;
  vi.spyOn(withDb, "tx").mockImplementation(async (run, options) => {
    await withDb((db) =>
      db.user.update({ where: { id: userId }, data: { active: false } })
    );
    return openTransaction(run, options);
  });
}
