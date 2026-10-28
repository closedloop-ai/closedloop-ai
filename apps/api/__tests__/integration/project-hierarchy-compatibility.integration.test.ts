import { LinkType } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  type ProjectHierarchyMoveRequest,
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { Status } from "@repo/api/src/types/result";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { generateSlug } from "@/app/documents/document-utils";
import {
  readPlacementState,
  siblingsFor,
} from "@/app/documents/project-artifact-placement-service-support";
import { projectHierarchyCompatibilityService } from "@/app/projects/project-hierarchy-compatibility-service";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

type Tenant = {
  organizationId: string;
  sourceProjectId: string;
  destinationProjectId: string;
  userId: string;
};

async function tenant(): Promise<Tenant> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const sourceProjectId = await createTestProject(organizationId, user.id, {
    name: "Hierarchy Source",
  });
  const destinationProjectId = await createTestProject(
    organizationId,
    user.id,
    { name: "Hierarchy Destination" }
  );
  return {
    organizationId,
    sourceProjectId,
    destinationProjectId,
    userId: user.id,
  };
}

async function artifact(
  row: Tenant,
  projectId: string,
  name: string,
  sortOrder: number,
  type: ArtifactType = ArtifactType.DOCUMENT
): Promise<string> {
  const created = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: row.organizationId,
        createdById: row.userId,
        projectId,
        name,
        slug: generateSlug(),
        type,
        ...(type === ArtifactType.DOCUMENT
          ? { subtype: ArtifactSubtype.PRD, status: DocumentStatus.Draft }
          : { status: BranchStatus.Open }),
        sortOrder,
      },
      select: { id: true },
    })
  );
  return created.id;
}

async function link(row: Tenant, parentId: string, childId: string) {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: row.organizationId,
        sourceId: parentId,
        targetId: childId,
        linkType: LinkType.Produces,
      },
    })
  );
}

async function move(
  row: Tenant,
  artifactIds: string[],
  placement: ProjectHierarchyPlacement,
  rootUpdates?: ProjectHierarchyMoveRequest["rootUpdates"]
) {
  const actor = { userId: row.userId, authMethod: "session" as const };
  const source = await projectHierarchyCompatibilityService.getRevision(
    row.sourceProjectId,
    row.organizationId,
    actor
  );
  const destination = await projectHierarchyCompatibilityService.getRevision(
    row.destinationProjectId,
    row.organizationId,
    actor
  );
  if (!(source && destination)) {
    throw new Error("Expected both hierarchy revisions");
  }
  return projectHierarchyCompatibilityService.transact(
    row.sourceProjectId,
    row.organizationId,
    actor,
    {
      operation: ProjectHierarchyOperation.Move,
      artifactIds,
      targetProjectId: row.destinationProjectId,
      placement,
      ...(rootUpdates ? { rootUpdates } : {}),
      expectedRevisions: [source, destination],
      idempotencyKey: crypto.randomUUID(),
      source: ProjectHierarchySource.Api,
    }
  );
}

function placementState(row: Tenant) {
  return withDb.tx((tx) =>
    readPlacementState(
      tx,
      row.organizationId,
      [row.sourceProjectId, row.destinationProjectId],
      true
    )
  );
}

describe.skipIf(!hasDatabase)(
  "flag-off hierarchy compatibility (Postgres)",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("moves a selected set and its descendant at the requested end edge in one commit", async () => {
      const row = await tenant();
      const firstId = await artifact(row, row.sourceProjectId, "First", 0);
      const childId = await artifact(row, row.sourceProjectId, "Child", 1024);
      const secondId = await artifact(
        row,
        row.sourceProjectId,
        "Second branch",
        2048,
        ArtifactType.BRANCH
      );
      const existingId = await artifact(
        row,
        row.destinationProjectId,
        "Existing",
        0
      );
      await link(row, firstId, childId);

      const result = await move(
        row,
        [firstId, secondId],
        ProjectHierarchyPlacement.End
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      expect(result.value.descendantCount).toBe(1);
      const state = await placementState(row);
      expect(siblingsFor(state, row.destinationProjectId, null)).toEqual([
        existingId,
        firstId,
        secondId,
      ]);
      expect(state.artifactsById.get(childId)?.projectId).toBe(
        row.destinationProjectId
      );
      expect(state.canonicalParents.get(childId)?.parentId).toBe(firstId);
    });

    it("places a selected root at the requested start edge", async () => {
      const row = await tenant();
      const movingId = await artifact(row, row.sourceProjectId, "Moving", 0);
      const existingId = await artifact(
        row,
        row.destinationProjectId,
        "Existing",
        0
      );

      const result = await move(
        row,
        [movingId],
        ProjectHierarchyPlacement.Start
      );
      expect(result.ok).toBe(true);
      const state = await placementState(row);
      expect(siblingsFor(state, row.destinationProjectId, null)).toEqual([
        movingId,
        existingId,
      ]);
    });

    it("records no receipt on any artifact for a no-op start move", async () => {
      const row = await tenant();
      const firstId = await artifact(row, row.sourceProjectId, "First", 0);
      await artifact(row, row.sourceProjectId, "Second", 1024);
      const actor = { userId: row.userId, authMethod: "session" as const };
      const revision = await projectHierarchyCompatibilityService.getRevision(
        row.sourceProjectId,
        row.organizationId,
        actor
      );
      if (!revision) {
        throw new Error("Expected hierarchy revision");
      }
      const result = await projectHierarchyCompatibilityService.transact(
        row.sourceProjectId,
        row.organizationId,
        actor,
        {
          operation: ProjectHierarchyOperation.Move,
          artifactIds: [firstId],
          placement: ProjectHierarchyPlacement.Start,
          expectedRevisions: [revision],
          idempotencyKey: crypto.randomUUID(),
          source: ProjectHierarchySource.Api,
        }
      );
      expect(result).toMatchObject({
        ok: true,
        value: { changedArtifactIds: [] },
      });
      expect(
        await withDb((db) =>
          db.artifactActivityEvent.count({
            where: { organizationId: row.organizationId },
          })
        )
      ).toBe(0);
    });

    it("promotes a selected child and pins its canonical descendant against an older destination edge", async () => {
      const row = await tenant();
      const sourceParentId = await artifact(
        row,
        row.sourceProjectId,
        "Source parent",
        0
      );
      const selectedChildId = await artifact(
        row,
        row.sourceProjectId,
        "Selected child",
        1024
      );
      const grandchildId = await artifact(
        row,
        row.sourceProjectId,
        "Grandchild",
        2048
      );
      const destinationParentId = await artifact(
        row,
        row.destinationProjectId,
        "Destination parent",
        0
      );
      await link(row, destinationParentId, grandchildId);
      await link(row, sourceParentId, selectedChildId);
      await link(row, selectedChildId, grandchildId);

      const result = await move(
        row,
        [selectedChildId],
        ProjectHierarchyPlacement.End
      );
      expect(result.ok).toBe(true);
      const state = await placementState(row);
      expect(state.artifactsById.get(sourceParentId)?.projectId).toBe(
        row.sourceProjectId
      );
      expect(state.artifactsById.get(selectedChildId)?.projectId).toBe(
        row.destinationProjectId
      );
      expect(state.artifactsById.get(grandchildId)?.projectId).toBe(
        row.destinationProjectId
      );
      expect(state.canonicalParents.get(selectedChildId)).toBeUndefined();
      expect(state.canonicalParents.get(grandchildId)?.parentId).toBe(
        selectedChildId
      );
      const oldParentEdge = await withDb((db) =>
        db.artifactLink.count({
          where: {
            organizationId: row.organizationId,
            sourceId: sourceParentId,
            targetId: selectedChildId,
            linkType: LinkType.Produces,
          },
        })
      );
      expect(oldParentEdge).toBe(0);
    });

    it("rolls back the whole selected set when one member rejects a root update", async () => {
      const row = await tenant();
      const documentId = await artifact(
        row,
        row.sourceProjectId,
        "Document",
        0
      );
      const branchId = await artifact(
        row,
        row.sourceProjectId,
        "Branch",
        1024,
        ArtifactType.BRANCH
      );

      const result = await move(
        row,
        [documentId, branchId],
        ProjectHierarchyPlacement.End,
        { status: DocumentStatus.Approved }
      );
      expect(result.ok).toBe(false);
      const state = await placementState(row);
      expect(siblingsFor(state, row.sourceProjectId, null)).toEqual([
        documentId,
        branchId,
      ]);
      expect(siblingsFor(state, row.destinationProjectId, null)).toEqual([]);
      const document = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: documentId },
          select: { status: true },
        })
      );
      expect(document?.status).toBe(DocumentStatus.Draft);
    });

    it("rejects a stale field revision before moving any selected member", async () => {
      const row = await tenant();
      const firstId = await artifact(row, row.sourceProjectId, "First", 0);
      const secondId = await artifact(row, row.sourceProjectId, "Second", 1024);
      const actor = { userId: row.userId, authMethod: "session" as const };
      const source = await projectHierarchyCompatibilityService.getRevision(
        row.sourceProjectId,
        row.organizationId,
        actor
      );
      const destination =
        await projectHierarchyCompatibilityService.getRevision(
          row.destinationProjectId,
          row.organizationId,
          actor
        );
      if (!(source && destination)) {
        throw new Error("Expected both hierarchy revisions");
      }
      await withDb((db) =>
        db.artifact.update({
          where: { id: secondId },
          data: { status: DocumentStatus.Approved },
        })
      );

      const result = await projectHierarchyCompatibilityService.transact(
        row.sourceProjectId,
        row.organizationId,
        actor,
        {
          operation: ProjectHierarchyOperation.Move,
          artifactIds: [firstId, secondId],
          targetProjectId: row.destinationProjectId,
          placement: ProjectHierarchyPlacement.End,
          expectedRevisions: [source, destination],
          idempotencyKey: crypto.randomUUID(),
          source: ProjectHierarchySource.Api,
        }
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected stale-version refusal");
      }
      expect(result.error.status).toBe(Status.Conflict);
      const state = await placementState(row);
      expect(siblingsFor(state, row.sourceProjectId, null)).toEqual([
        firstId,
        secondId,
      ]);
      expect(siblingsFor(state, row.destinationProjectId, null)).toEqual([]);
    });
  }
);
