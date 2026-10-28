import { randomUUID } from "node:crypto";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionChunk,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";

const tracker = createCommittedTestOrganizationTracker();
const EXTERNAL_SESSION_ID = "iss10992-metadata-seed";
const SEEDED_NAME = "Seeded session title";

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 collector metadata receipts",
  () => {
    afterEach(async () => {
      vi.restoreAllMocks();
      await tracker.cleanup();
    });

    it("records exactly one System receipt per committed name and priority seed", async () => {
      const fixture = await createFixture();
      const payload = {
        ...baseSession(),
        nameOverride: SEEDED_NAME,
        priority: Priority.High,
      };

      await ingestChunk(fixture.context, randomUUID(), payload);
      await ingestChunk(fixture.context, randomUUID(), payload);

      const state = await readState(fixture.artifactId);
      expect(state.session?.metadataActivityCoverageStartedAt).toBeInstanceOf(
        Date
      );
      expect(state.priority).toBe(Priority.High);
      expect(state.session?.nameOverride).toBe(SEEDED_NAME);
      expect(state.activityEvents).toHaveLength(2);
      expect(state.activityEvents).toEqual(
        expect.arrayContaining([
          systemSeed(SessionMetadataActivityField.Name, SEEDED_NAME),
          systemSeed(SessionMetadataActivityField.Priority, Priority.High),
        ])
      );
    });

    it.each([
      [
        SessionMetadataActivityField.Name,
        { nameOverride: SEEDED_NAME },
        SEEDED_NAME,
      ],
      [
        SessionMetadataActivityField.Priority,
        { priority: Priority.High },
        Priority.High,
      ],
    ])(
      "rolls back a %s seed when its receipt fails",
      async (field, patch, value) => {
        const fixture = await createFixture();
        const receipt = vi
          .spyOn(artifactActivityService, "recordActivityEvent")
          .mockRejectedValueOnce(new Error("receipt unavailable"));

        await expect(
          ingestChunk(fixture.context, randomUUID(), {
            ...baseSession(),
            ...patch,
          })
        ).rejects.toThrow("receipt unavailable");

        const state = await readState(fixture.artifactId);
        expect(state.priority).toBeNull();
        expect(state.session?.nameOverride).toBeNull();
        expect(state.activityEvents).toEqual([]);
        const expectedField = receiptField(field);
        const expectedClassification =
          field === SessionMetadataActivityField.Name
            ? ArtifactFieldEditValueClassification.Content
            : ArtifactFieldEditValueClassification.Enumerated;
        expect(receipt).toHaveBeenCalledWith(
          expect.objectContaining({
            after: {
              field: expectedField,
              value,
              valueClassification: expectedClassification,
              result: ArtifactFieldEditReceiptResult.Committed,
            },
          }),
          expect.anything()
        );
      }
    );

    // ISS-10995 (operator ruling 2026-10-12): ingest fills the project once and
    // never re-files it, so a later lineage change records no reparent receipt.
    it("records project attachment once and never re-files on a later sync", async () => {
      const fixture = await createFixture();
      const first = await createProjectSource(fixture.context);
      const second = await createProjectSource(fixture.context);
      const firstPayload = {
        ...baseSession(),
        attribution: { sourceArtifactId: first.artifactId },
      };
      const secondPayload = {
        ...baseSession(),
        attribution: { sourceArtifactId: second.artifactId },
      };

      await ingestChunk(fixture.context, randomUUID(), firstPayload);
      await ingestChunk(fixture.context, randomUUID(), secondPayload);
      await ingestChunk(fixture.context, randomUUID(), secondPayload);

      const state = await readState(fixture.artifactId);
      expect(state.projectId).toBe(first.projectId);
      expect(state.activityEvents).toEqual([
        systemSeed(SessionMetadataActivityField.ProjectId, first.projectId),
      ]);
    });

    it("rolls back a collector project change when its receipt fails", async () => {
      const fixture = await createFixture();
      const source = await createProjectSource(fixture.context);
      vi.spyOn(
        artifactActivityService,
        "recordActivityEvent"
      ).mockRejectedValueOnce(new Error("receipt unavailable"));

      await expect(
        ingestChunk(fixture.context, randomUUID(), {
          ...baseSession(),
          attribution: { sourceArtifactId: source.artifactId },
        })
      ).rejects.toThrow("receipt unavailable");

      const state = await readState(fixture.artifactId);
      expect(state.projectId).toBeNull();
      expect(state.activityEvents).toEqual([]);
    });

    it("records a collector status transition once without attributing the System receipt to a person", async () => {
      const fixture = await createFixture();
      const payload = {
        ...baseSession(),
        status: SESSION_STATUS.ERROR,
        updatedAt: "2026-06-10T12:00:00.000Z",
      };
      await ingestChunk(fixture.context, randomUUID(), payload);
      await ingestChunk(fixture.context, randomUUID(), payload);
      const state = await readState(fixture.artifactId);
      expect(state.status).toBe(SESSION_STATUS.ERROR);
      expect(state.activityEvents).toEqual([
        {
          action: ArtifactActivityAction.StatusChange,
          actorType: ArtifactActivityActorType.System,
          actorId: null,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.ERROR,
        },
      ]);
      const result = await artifactCollaboratorsService.readBatch(
        fixture.context.organizationId,
        {
          artifactType: CollaboratorArtifactType.Session,
          artifactIds: [fixture.artifactId],
        }
      );
      expect(
        result.results[0]?.collaborators.people.map((person) => person.userId)
      ).toEqual([fixture.context.userId]);
    });

    it("rolls back a collector status transition when its receipt fails", async () => {
      const fixture = await createFixture();
      vi.spyOn(
        artifactActivityService,
        "recordActivityEvent"
      ).mockRejectedValueOnce(new Error("receipt unavailable"));
      await expect(
        ingestChunk(fixture.context, randomUUID(), {
          ...baseSession(),
          status: SESSION_STATUS.ERROR,
          updatedAt: "2026-06-10T12:00:00.000Z",
        })
      ).rejects.toThrow("receipt unavailable");
      const state = await readState(fixture.artifactId);
      expect(state.status).toBe(SESSION_STATUS.ACTIVE);
      expect(state.activityEvents).toEqual([]);
    });
  }
);

function baseSession() {
  return buildSessionChunk({
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Collector title",
    eventIds: ["evt-0"],
  });
}

async function createFixture() {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    "iss10992-metadata"
  );
  const context = { organizationId, userId: user.id, computeTargetId };
  await ingestChunk(context, randomUUID(), baseSession());
  const session = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      },
      select: { artifactId: true },
    })
  );
  return { context, artifactId: session.artifactId };
}

function readState(artifactId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: {
        status: true,
        priority: true,
        projectId: true,
        session: {
          select: {
            nameOverride: true,
            metadataActivityCoverageStartedAt: true,
          },
        },
        activityEvents: {
          where: {
            action: {
              in: [
                ArtifactActivityAction.FieldChange,
                ArtifactActivityAction.StatusChange,
              ],
            },
          },
          select: {
            action: true,
            actorType: true,
            actorId: true,
            before: true,
            after: true,
          },
        },
      },
    })
  );
}

function systemSeed(field: SessionMetadataActivityField, after: string) {
  const receipt = receiptField(field);
  let afterClassification: ArtifactFieldEditValueClassification =
    ArtifactFieldEditValueClassification.Reference;
  if (field === SessionMetadataActivityField.Name) {
    afterClassification = ArtifactFieldEditValueClassification.Content;
  } else if (field === SessionMetadataActivityField.Priority) {
    afterClassification = ArtifactFieldEditValueClassification.Enumerated;
  }
  return {
    action: ArtifactActivityAction.FieldChange,
    actorType: ArtifactActivityActorType.System,
    actorId: null,
    before: {
      field: receipt,
      value: null,
      valueClassification: ArtifactFieldEditValueClassification.Absent,
    },
    after: {
      field: receipt,
      value: after,
      valueClassification: afterClassification,
      result: ArtifactFieldEditReceiptResult.Committed,
    },
  };
}

function receiptField(
  field: SessionMetadataActivityField
): ArtifactFieldEditField {
  return SESSION_METADATA_RECEIPT_FIELD[field];
}

const SESSION_METADATA_RECEIPT_FIELD = {
  [SessionMetadataActivityField.Name]: ArtifactFieldEditField.Name,
  [SessionMetadataActivityField.Priority]: ArtifactFieldEditField.Priority,
  [SessionMetadataActivityField.ProjectId]: ArtifactFieldEditField.ProjectId,
  [SessionMetadataActivityField.AssigneeId]: ArtifactFieldEditField.AssigneeId,
  [SessionMetadataActivityField.OwnerUserId]: ArtifactFieldEditField.AssigneeId,
  [SessionMetadataActivityField.Tag]: ArtifactFieldEditField.Tag,
} as const satisfies Readonly<
  Record<SessionMetadataActivityField, ArtifactFieldEditField>
>;

async function createProjectSource(context: {
  organizationId: string;
  userId: string;
}) {
  const projectId = await createTestProject(
    context.organizationId,
    context.userId,
    { name: `project-${randomUUID()}` }
  );
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: context.organizationId,
        projectId,
        type: ArtifactType.Document,
        name: "project source",
        status: DocumentStatus.Draft,
        createdById: context.userId,
      },
      select: { id: true },
    })
  );
  return { projectId, artifactId: artifact.id };
}
