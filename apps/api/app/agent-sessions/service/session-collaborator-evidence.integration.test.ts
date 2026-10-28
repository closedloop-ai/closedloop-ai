import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { readSessionCollaboratorEvidence } from "./session-collaborator-evidence";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 Session collaborator evidence",
  () => {
    afterEach(() => tracker.cleanup());

    it("reads current owner and account-resolved edits from authorized Sessions", async () => {
      const organizationId = await tracker.create();
      const foreignOrganizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const editor = await createTestUser(organizationId);
      const nonEditor = await createTestUser(organizationId);
      const unrelatedActor = await createTestUser(organizationId);
      const foreignUser = await createTestUser(foreignOrganizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "collaborator-session",
        metadataActivityCoverageStartedAt: new Date(),
      });
      const foreignSessionId = await createTestSessionDetail({
        organizationId: foreignOrganizationId,
        userId: foreignUser.id,
        label: "foreign-collaborator-session",
      });
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: [
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.User,
              actorId: unrelatedActor.id,
              action: ArtifactActivityAction.MonitoredActivityRetained,
              after: {
                field: SessionMetadataActivityField.Name,
                value: "retained activity",
              },
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.System,
              actorId: unrelatedActor.id,
              action: ArtifactActivityAction.StatusChange,
              after: SESSION_STATUS.INACTIVE,
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.User,
              actorId: editor.id,
              action: ArtifactActivityAction.FieldChange,
              after: {
                field: SessionMetadataActivityField.Priority,
                value: Priority.High,
              },
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.Agent,
              actorId: nonEditor.id,
              action: ArtifactActivityAction.FieldChange,
              after: {
                field: SessionMetadataActivityField.Tag,
                value: "tag-1",
              },
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.System,
              actorId: null,
              action: ArtifactActivityAction.StatusChange,
              after: SESSION_STATUS.INACTIVE,
            },
            {
              organizationId,
              artifactId: sessionId,
              actorType: ArtifactActivityActorType.User,
              actorId: nonEditor.id,
              action: ArtifactActivityAction.FieldChange,
              after: { field: "dueDate", value: "2026-10-01" },
            },
            {
              organizationId: foreignOrganizationId,
              artifactId: foreignSessionId,
              actorType: ArtifactActivityActorType.User,
              actorId: foreignUser.id,
              action: ArtifactActivityAction.StatusChange,
              after: SESSION_STATUS.INACTIVE,
            },
          ],
        })
      );

      const evidence = await withDb((db) =>
        readSessionCollaboratorEvidence(db, organizationId, [
          sessionId,
          foreignSessionId,
        ])
      );

      expect([...evidence.keys()]).toEqual([sessionId]);
      expect(evidence.get(sessionId)).toEqual({
        ownerId: owner.id,
        editorIds: [editor.id, nonEditor.id].sort(),
        editorAvailability: BranchIdentityAvailability.Complete,
      });
    });

    it("counts an owner reassignment under the assignee field and under the legacy owner field", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const reassigner = await createTestUser(organizationId);
      const legacyReassigner = await createTestUser(organizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "owner-reassignment-evidence",
        metadataActivityCoverageStartedAt: new Date(),
      });
      const assignment = (actorId: string, field: string) => ({
        organizationId,
        artifactId: sessionId,
        actorType: ArtifactActivityActorType.User,
        actorId,
        action: ArtifactActivityAction.Assignment,
        before: { field, value: null },
        after: { field, value: owner.id },
      });
      await withDb((db) =>
        db.artifactActivityEvent.createMany({
          data: [
            // ISS-12251: what an owner write records now.
            assignment(reassigner.id, SessionMetadataActivityField.AssigneeId),
            // A receipt stored before ISS-12251.
            assignment(
              legacyReassigner.id,
              SessionMetadataActivityField.OwnerUserId
            ),
          ],
        })
      );

      const evidence = await withDb((db) =>
        readSessionCollaboratorEvidence(db, organizationId, [sessionId])
      );

      expect(evidence.get(sessionId)?.editorIds).toEqual(
        [reassigner.id, legacyReassigner.id].sort()
      );
    });

    it("names the session's creator as its owner-source person, not its recorder or its Owner (ISS-12251 D-4)", async () => {
      const organizationId = await tracker.create();
      const [creator, recorder, assignee] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: recorder.id,
        label: "creator-recorder-owner",
        metadataActivityCoverageStartedAt: new Date(),
      });
      await withDb((db) =>
        db.artifact.update({
          where: { id: sessionId },
          data: { createdById: creator.id, assigneeId: assignee.id },
          select: { id: true },
        })
      );

      const evidence = await withDb((db) =>
        readSessionCollaboratorEvidence(db, organizationId, [sessionId])
      );

      expect(evidence.get(sessionId)?.ownerId).toBe(creator.id);
    });

    it("keeps unresolved historical human actors incomplete rather than inventing a person", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "unresolved-session-editor",
        metadataActivityCoverageStartedAt: new Date(),
      });
      await withDb((db) =>
        db.artifactActivityEvent.create({
          data: {
            organizationId,
            artifactId: sessionId,
            actorType: ArtifactActivityActorType.User,
            actorId: "missing-user",
            action: ArtifactActivityAction.StatusChange,
            before: SESSION_STATUS.ACTIVE,
            after: SESSION_STATUS.INACTIVE,
          },
        })
      );

      const evidence = await withDb((db) =>
        readSessionCollaboratorEvidence(db, organizationId, [sessionId])
      );

      expect(evidence.get(sessionId)).toEqual({
        ownerId: owner.id,
        editorIds: [],
        editorAvailability: BranchIdentityAvailability.Incomplete,
      });
    });

    it("retains a known legacy editor while leaving earlier history incomplete", async () => {
      const organizationId = await tracker.create();
      const owner = await createTestUser(organizationId);
      const editor = await createTestUser(organizationId);
      const sessionId = await createTestSessionDetail({
        organizationId,
        userId: owner.id,
        label: "legacy-editor-history",
      });
      await withDb((db) =>
        db.artifactActivityEvent.create({
          data: {
            organizationId,
            artifactId: sessionId,
            actorType: ArtifactActivityActorType.User,
            actorId: editor.id,
            action: ArtifactActivityAction.FieldChange,
            after: {
              field: SessionMetadataActivityField.Priority,
              value: Priority.High,
            },
          },
          select: { id: true },
        })
      );

      const evidence = await withDb((db) =>
        readSessionCollaboratorEvidence(db, organizationId, [sessionId])
      );

      expect(evidence.get(sessionId)).toEqual({
        ownerId: owner.id,
        editorIds: [editor.id],
        editorAvailability: BranchIdentityAvailability.Incomplete,
      });
    });
  }
);
