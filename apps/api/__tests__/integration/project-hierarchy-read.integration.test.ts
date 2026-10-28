import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ProjectTreeCategory } from "@repo/api/src/types/project-tree";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  ArtifactSubtype,
  ArtifactType,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CanonicalParentLinkRow,
  resolveCanonicalParents,
} from "@/app/artifacts/project-tree-service/canonical-parents";
import { ProjectHierarchyStaleCursorError } from "@/app/artifacts/project-tree-service/hierarchy-projection";
import { readBoundedProjectHierarchy } from "@/app/artifacts/project-tree-service/project-hierarchy-read";
import { generateSlug } from "@/app/documents/document-utils";
import { readPlacementState } from "@/app/documents/project-artifact-placement-service-support";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const committedOrganizations = createCommittedTestOrganizationTracker();
const producesCycleRejected = /PRODUCES cycle rejected/;

describe.skipIf(!hasDatabase)("project hierarchy bounded database read", () => {
  afterEach(async () => {
    await committedOrganizations.cleanup();
  });

  it("serializes competing cycle-closing inserts", async () => {
    const organizationId = await committedOrganizations.create();
    const user = await createTestUser(organizationId);
    const projectId = await createTestProject(organizationId, user.id);
    const fixture = { organizationId, projectId, userId: user.id };
    const aId = await createArtifact(fixture, "A", ArtifactType.DOCUMENT, 10);
    const bId = await createArtifact(fixture, "B", ArtifactType.DOCUMENT, 20);

    const results = await Promise.allSettled([
      withDb.tx((tx) =>
        tx.artifactLink.create({
          data: {
            organizationId,
            sourceId: aId,
            targetId: bId,
            linkType: LinkType.Produces,
          },
        })
      ),
      withDb.tx((tx) =>
        tx.artifactLink.create({
          data: {
            organizationId,
            sourceId: bId,
            targetId: aId,
            linkType: LinkType.Produces,
          },
        })
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(producesCycleRejected),
      })
    );
    expect(
      await withDb((db) =>
        db.artifactLink.count({
          where: { organizationId, linkType: LinkType.Produces },
        })
      )
    ).toBe(1);
  });

  it("rejects a cycle spanning projects in one organization", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const secondProjectId = await createTestProject(
        fixture.organizationId,
        fixture.userId
      );
      const aId = await createArtifact(fixture, "A", ArtifactType.DOCUMENT, 10);
      const bId = await createArtifact(
        { ...fixture, projectId: secondProjectId },
        "B",
        ArtifactType.DOCUMENT,
        20
      );
      const cId = await createArtifact(fixture, "C", ArtifactType.DOCUMENT, 30);
      await createOrderedLinks(fixture.organizationId, [
        [aId, bId],
        [bId, cId],
      ]);

      await withDb((db) => db.$executeRaw`SAVEPOINT cross_project_cycle_probe`);
      await expect(
        createOrderedLinks(fixture.organizationId, [[cId, aId]])
      ).rejects.toThrow(producesCycleRejected);
      await withDb(
        (db) => db.$executeRaw`ROLLBACK TO SAVEPOINT cross_project_cycle_probe`
      );
      await withDb(
        (db) => db.$executeRaw`RELEASE SAVEPOINT cross_project_cycle_probe`
      );
      expect((await readFirstPage(fixture)).window.rootIds).toContain(aId);
    });
  });

  it("rejects an update that would close a PRODUCES cycle", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const aId = await createArtifact(fixture, "A", ArtifactType.DOCUMENT, 10);
      const bId = await createArtifact(fixture, "B", ArtifactType.DOCUMENT, 20);
      const cId = await createArtifact(fixture, "C", ArtifactType.DOCUMENT, 30);
      const dId = await createArtifact(fixture, "D", ArtifactType.DOCUMENT, 40);
      const links = await createOrderedLinks(fixture.organizationId, [
        [aId, bId],
        [bId, cId],
        [aId, dId],
      ]);

      await withDb((db) => db.$executeRaw`SAVEPOINT updated_cycle_probe`);
      await expect(
        withDb((db) =>
          db.artifactLink.update({
            where: { id: links[2].id },
            data: { sourceId: cId, targetId: aId },
          })
        )
      ).rejects.toThrow(producesCycleRejected);
      await withDb(
        (db) => db.$executeRaw`ROLLBACK TO SAVEPOINT updated_cycle_probe`
      );
      await withDb(
        (db) => db.$executeRaw`RELEASE SAVEPOINT updated_cycle_probe`
      );
      const link = await withDb((db) =>
        db.artifactLink.findUniqueOrThrow({ where: { id: links[2].id } })
      );
      expect([link.sourceId, link.targetId]).toEqual([aId, dId]);
    });
  });

  it("refuses a cycle-closing edge without changing the canonical projection", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const aId = await createArtifact(fixture, "A", ArtifactType.DOCUMENT, 10);
      const bId = await createArtifact(fixture, "B", ArtifactType.DOCUMENT, 20);
      const cId = await createArtifact(fixture, "C", ArtifactType.DOCUMENT, 30);
      const links = await createOrderedLinks(fixture.organizationId, [
        [aId, bId],
        [cId, aId],
      ]);
      await withDb((db) => db.$executeRaw`SAVEPOINT cycle_admission_probe`);
      await expect(
        createOrderedLinks(fixture.organizationId, [[bId, cId]])
      ).rejects.toThrow(producesCycleRejected);
      await withDb(
        (db) => db.$executeRaw`ROLLBACK TO SAVEPOINT cycle_admission_probe`
      );
      await withDb(
        (db) => db.$executeRaw`RELEASE SAVEPOINT cycle_admission_probe`
      );

      const result = await withDb((db) =>
        readBoundedProjectHierarchy(
          db as TransactionClient,
          fixture.projectId,
          fixture.organizationId,
          { hierarchy: true, limit: 10 }
        )
      );
      const expected = resolveCanonicalParents(links);

      expect(Object.fromEntries(result.state.canonicalParents)).toEqual(
        Object.fromEntries(
          [...expected].map(([id, { linkType, parentId }]) => [
            id,
            { linkType, parentId },
          ])
        )
      );
      expect(result.window.rootIds).toEqual([cId]);
      expect(result.window.includedArtifactIds).toEqual(
        new Set([aId, bId, cId])
      );
    });
  });

  it("pages mixed kinds and stales cursors after every non-document topology change", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const createdAt = new Date("2026-10-20T12:00:00.000Z");
      const branchId = await createArtifact(
        fixture,
        "Branch",
        ArtifactType.BRANCH,
        10,
        createdAt
      );
      const sessionId = await createArtifact(
        fixture,
        "Session",
        ArtifactType.SESSION,
        10,
        createdAt
      );
      const documentId = await createArtifact(
        fixture,
        "Document",
        ArtifactType.DOCUMENT,
        null,
        createdAt
      );

      const firstPage = await withDb((db) =>
        readBoundedProjectHierarchy(
          db as TransactionClient,
          fixture.projectId,
          fixture.organizationId,
          { hierarchy: true, limit: 1 }
        )
      );
      expect(firstPage.window.rootIds).toEqual([
        [branchId, sessionId].sort()[0],
      ]);
      expect(firstPage.window.rootNextCursor).toEqual(expect.any(String));

      const allKinds = await withDb((db) =>
        readBoundedProjectHierarchy(
          db as TransactionClient,
          fixture.projectId,
          fixture.organizationId,
          { hierarchy: true, limit: 10 }
        )
      );
      expect(new Set(allKinds.window.rootIds)).toEqual(
        new Set([branchId, sessionId, documentId])
      );

      await withDb((db) =>
        db.artifact.update({
          where: { id: sessionId },
          data: { sortOrder: 11 },
        })
      );
      await expect(
        readPageWithCursor(fixture, firstPage.window.rootNextCursor)
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);

      const afterRank = await readFirstPage(fixture);
      // ISS-12929 (725-F4): every kind is placeable, so a Session reorder
      // moves the placement fence too.
      expect(afterRank.window.mutationVersion).not.toBe(
        firstPage.window.mutationVersion
      );
      await expect(placementVersion(fixture)).resolves.toBe(
        afterRank.window.mutationVersion
      );
      const insertedBranchId = await createArtifact(
        fixture,
        "Inserted Branch",
        ArtifactType.BRANCH,
        12
      );
      await expect(
        readPageWithCursor(fixture, afterRank.window.rootNextCursor)
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);

      const beforeReparent = await readFirstPage(fixture);
      await createOrderedLinks(fixture.organizationId, [[branchId, sessionId]]);
      await expect(
        readPageWithCursor(fixture, beforeReparent.window.rootNextCursor)
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);

      const beforeDelete = await readFirstPage(fixture);
      await withDb((db) =>
        db.artifact.delete({ where: { id: insertedBranchId } })
      );
      await expect(
        readPageWithCursor(fixture, beforeDelete.window.rootNextCursor)
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);

      const beforeIssue = await readFirstPage(fixture);
      await createArtifact(
        fixture,
        "Inserted Issue",
        ArtifactType.DOCUMENT,
        13,
        undefined,
        ArtifactSubtype.FEATURE
      );
      await expect(
        readPageWithCursor(fixture, beforeIssue.window.rootNextCursor)
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);
    });
  });

  it("filters a nested category match before applying the root page bound", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const branchId = await createArtifact(
        fixture,
        "Branch",
        ArtifactType.BRANCH,
        0
      );
      const prdId = await createArtifact(
        fixture,
        "PRD after the first root",
        ArtifactType.DOCUMENT,
        1000,
        undefined,
        ArtifactSubtype.PRD
      );
      await createOrderedLinks(fixture.organizationId, [[branchId, prdId]]);

      const unfiltered = await readFirstPage(fixture);
      expect(unfiltered.window.rootIds).toEqual([branchId]);
      const filtered = await withDb((db) =>
        readBoundedProjectHierarchy(
          db as TransactionClient,
          fixture.projectId,
          fixture.organizationId,
          {
            category: ProjectTreeCategory.Prds,
            hierarchy: true,
            limit: 1,
          }
        )
      );

      expect(filtered.window.rootIds).toEqual([prdId]);
      expect(filtered.state.childrenByParent.size).toBe(0);
      expect(filtered.state.canonicalParents.get(prdId)?.parentId).toBe(
        branchId
      );
    });
  });

  it("stales cursors for duplicate-parent diagnostics but not refused cycle writes", async () => {
    await autoRollbackTransaction(async () => {
      const duplicateFixture = await createFixture();
      const parentAId = await createArtifact(
        duplicateFixture,
        "Parent A",
        ArtifactType.DOCUMENT,
        10
      );
      const parentBId = await createArtifact(
        duplicateFixture,
        "Parent B",
        ArtifactType.DOCUMENT,
        20
      );
      const childId = await createArtifact(
        duplicateFixture,
        "Child",
        ArtifactType.DOCUMENT,
        30
      );
      await createOrderedLinks(duplicateFixture.organizationId, [
        [parentAId, childId],
      ]);
      const beforeDuplicate = await readFirstPage(duplicateFixture);
      await createOrderedLinks(
        duplicateFixture.organizationId,
        [[parentBId, childId]],
        10
      );
      await expect(
        readPageWithCursor(
          duplicateFixture,
          beforeDuplicate.window.rootNextCursor
        )
      ).rejects.toBeInstanceOf(ProjectHierarchyStaleCursorError);

      const cycleFixture = await createFixture();
      const parentId = await createArtifact(
        cycleFixture,
        "Cycle parent",
        ArtifactType.DOCUMENT,
        10
      );
      await createArtifact(
        cycleFixture,
        "Second root",
        ArtifactType.DOCUMENT,
        20
      );
      const childIdForCycle = await createArtifact(
        cycleFixture,
        "Cycle child",
        ArtifactType.DOCUMENT,
        30
      );
      await createOrderedLinks(cycleFixture.organizationId, [
        [parentId, childIdForCycle],
      ]);
      const beforeCycle = await readFirstPage(cycleFixture);
      await withDb((db) => db.$executeRaw`SAVEPOINT cycle_cursor_probe`);
      await expect(
        createOrderedLinks(
          cycleFixture.organizationId,
          [[childIdForCycle, parentId]],
          10
        )
      ).rejects.toThrow(producesCycleRejected);
      await withDb(
        (db) => db.$executeRaw`ROLLBACK TO SAVEPOINT cycle_cursor_probe`
      );
      await withDb(
        (db) => db.$executeRaw`RELEASE SAVEPOINT cycle_cursor_probe`
      );
      await expect(
        readPageWithCursor(cycleFixture, beforeCycle.window.rootNextCursor)
      ).resolves.toMatchObject({
        window: { version: beforeCycle.window.version },
      });
    });
  });

  it("keeps the projection and cursor version atomic with a rolled-back link write", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await createFixture();
      const parentId = await createArtifact(
        fixture,
        "Parent",
        ArtifactType.DOCUMENT,
        10
      );
      const childId = await createArtifact(
        fixture,
        "Child",
        ArtifactType.DOCUMENT,
        20
      );
      const before = await readFirstPage(fixture);

      await withDb(async (db) => {
        await db.$executeRaw`SAVEPOINT hierarchy_projection_probe`;
        await db.artifactLink.create({
          data: {
            linkType: LinkType.Produces,
            organizationId: fixture.organizationId,
            sourceId: parentId,
            targetId: childId,
          },
          select: { id: true },
        });
        const during = await readBoundedProjectHierarchy(
          db as TransactionClient,
          fixture.projectId,
          fixture.organizationId,
          { hierarchy: true, limit: 10 }
        );
        expect(during.state.canonicalParents.get(childId)?.parentId).toBe(
          parentId
        );
        await db.$executeRaw`ROLLBACK TO SAVEPOINT hierarchy_projection_probe`;
        await db.$executeRaw`RELEASE SAVEPOINT hierarchy_projection_probe`;
      });

      const after = await readFirstPage(fixture);
      expect(after.window.version).toBe(before.window.version);
      expect(after.window.mutationVersion).toBe(before.window.mutationVersion);
      expect(after.window.rootIds).toEqual(before.window.rootIds);
      expect(after.childCountsByParent.get(parentId) ?? 0).toBe(0);
    });
  });

  it("installs indexes matching root, child, and flat-category page predicates", async () => {
    const indexes = await withDb(
      (db) =>
        db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'artifacts'
          AND indexname IN (
            'artifacts_hierarchy_page_idx',
            'artifacts_hierarchy_type_page_idx',
            'artifacts_hierarchy_document_category_page_idx'
          )
      `
    );
    const byName = new Map(
      indexes.map((index) => [index.indexname, index.indexdef])
    );
    expect(byName.get("artifacts_hierarchy_page_idx")).toContain(
      "organization_id, project_id, canonical_parent_id, hierarchy_rank, created_at DESC, id"
    );
    expect(byName.get("artifacts_hierarchy_type_page_idx")).toContain(
      "organization_id, project_id, type, sort_order, created_at DESC, id"
    );
    expect(
      byName.get("artifacts_hierarchy_document_category_page_idx")
    ).toContain(
      "organization_id, project_id, type, subtype, sort_order, created_at DESC, id"
    );
  });
});

async function createFixture() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, projectId, userId: user.id };
}

async function createArtifact(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
  type: ArtifactType,
  sortOrder: number | null,
  createdAt?: Date,
  subtype: ArtifactSubtype = ArtifactSubtype.PRD
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdAt,
        createdById: fixture.userId,
        name,
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        slug: generateSlug(),
        sortOrder,
        status: artifactStatus(type),
        subtype: type === ArtifactType.DOCUMENT ? subtype : null,
        type,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

function readFirstPage(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return withDb((db) =>
    readBoundedProjectHierarchy(
      db as TransactionClient,
      fixture.projectId,
      fixture.organizationId,
      { hierarchy: true, limit: 1 }
    )
  );
}

function readPageWithCursor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  rootCursor: string | undefined
) {
  return withDb((db) =>
    readBoundedProjectHierarchy(
      db as TransactionClient,
      fixture.projectId,
      fixture.organizationId,
      { hierarchy: true, limit: 1, rootCursor }
    )
  );
}

function artifactStatus(type: ArtifactType): string {
  if (type === ArtifactType.BRANCH) {
    return BranchStatus.Open;
  }
  if (type === ArtifactType.SESSION) {
    return SESSION_STATUS.ACTIVE;
  }
  return DocumentStatus.Draft;
}

async function createOrderedLinks(
  organizationId: string,
  edges: ReadonlyArray<readonly [sourceId: string, targetId: string]>,
  startSecond = 0
) {
  const links: CanonicalParentLinkRow[] = [];
  for (const [index, [sourceId, targetId]] of edges.entries()) {
    links.push(
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            createdAt: new Date(
              `2026-10-20T12:00:${String(startSecond + index).padStart(2, "0")}.000Z`
            ),
            linkType: LinkType.Produces,
            organizationId,
            sortOrder: null,
            sourceId,
            targetId,
          },
          select: {
            createdAt: true,
            id: true,
            linkType: true,
            sortOrder: true,
            sourceId: true,
            targetId: true,
          },
        })
      )
    );
  }
  return links;
}

/** The version the placement GET reports, which the tree read must match. */
async function placementVersion(
  fixture: Awaited<ReturnType<typeof createFixture>>
): Promise<string | undefined> {
  const state = await withDb((db) =>
    readPlacementState(db as TransactionClient, fixture.organizationId, [
      fixture.projectId,
    ])
  );
  return state.projectVersions[fixture.projectId];
}
