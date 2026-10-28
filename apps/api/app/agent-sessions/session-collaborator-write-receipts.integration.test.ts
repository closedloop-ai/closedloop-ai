import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  CollaboratorArtifactType,
  normalizeArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { AgentSessionPatchField } from "@repo/api/src/types/artifact-row-field-edit";
import { Priority } from "@repo/api/src/types/common";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TAG_COLORS, TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { GET as getCollaborators } from "@/app/artifacts/collaborators/route";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";

const auth = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
  authMethod: "session",
  isAdmin: true,
  scheduled: [] as Promise<unknown>[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(
        {
          user: auth.user,
          authMethod: auth.authMethod,
          clerkOrgId: "fixture-org",
          clerkUserId: "fixture-user",
        },
        request,
        context?.params
      ),
}));
vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: vi.fn(async () => ({ isAdmin: auth.isAdmin })),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    auth.scheduled.push(work);
  },
}));
vi.mock(
  "@/app/documents/single-priority-side-effects",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    emitSinglePrioritySideEffects: vi.fn(),
  })
);
vi.mock("./bulk-assign-side-effects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitBulkAssignSideEffects: vi.fn(),
}));
vi.mock("@/app/tags/batch-tag-side-effects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitBatchTagSideEffects: vi.fn(),
}));

import { POST as applyBatchTag } from "@/app/entity-tags/batch/route";
import { POST as applyBatchTagV2 } from "@/app/entity-tags/batch/v2/route";
import { POST as applyTag, DELETE as deleteTag } from "@/app/entity-tags/route";
import { PATCH } from "./[id]/route";
import { POST as bulkAssign } from "./bulk-assign/route";
import { POST as bulkAssignV2 } from "./bulk-assign/v2/route";
import { AgentSessionBulkAssignField } from "./write-contract";

const tracker = createCommittedTestOrganizationTracker();
const ORIGINAL_NAME = "Original Session title";
const RENAMED_NAME = "Renamed Session title";
const COVERAGE_STARTED_AT = new Date("2026-09-30T00:00:00.000Z");

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-10992 actual Session writers and receipts",
  () => {
    afterEach(async () => {
      await Promise.all(auth.scheduled.splice(0));
      vi.restoreAllMocks();
      auth.authMethod = "session";
      auth.isAdmin = true;
      await tracker.cleanup();
    });

    it("qualifies the account that committed each of the six fields and suppresses duplicate saves", async () => {
      const fixture = await seedFixture();
      const fields = [
        {
          field: AgentSessionPatchField.Status,
          body: { status: SESSION_STATUS.INACTIVE },
          action: ArtifactActivityAction.StatusChange,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.INACTIVE,
        },
        {
          field: SessionMetadataActivityField.ProjectId,
          body: { projectId: fixture.projectId },
          action: ArtifactActivityAction.FieldChange,
          before: {
            field: ArtifactFieldEditField.ProjectId,
            value: null,
            valueClassification: ArtifactFieldEditValueClassification.Absent,
          },
          after: {
            field: ArtifactFieldEditField.ProjectId,
            value: fixture.projectId,
            valueClassification: ArtifactFieldEditValueClassification.Reference,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
        {
          field: SessionMetadataActivityField.AssigneeId,
          body: { ownerUserId: fixture.nextOwner.id },
          action: ArtifactActivityAction.Assignment,
          before: {
            field: ArtifactFieldEditField.AssigneeId,
            value: fixture.owner.id,
            valueClassification: ArtifactFieldEditValueClassification.Reference,
          },
          after: {
            field: ArtifactFieldEditField.AssigneeId,
            value: fixture.nextOwner.id,
            valueClassification: ArtifactFieldEditValueClassification.Reference,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
        {
          field: SessionMetadataActivityField.Priority,
          body: { priority: Priority.High },
          action: ArtifactActivityAction.FieldChange,
          before: {
            field: ArtifactFieldEditField.Priority,
            value: null,
            valueClassification: ArtifactFieldEditValueClassification.Absent,
          },
          after: {
            field: ArtifactFieldEditField.Priority,
            value: Priority.High,
            valueClassification:
              ArtifactFieldEditValueClassification.Enumerated,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
        {
          field: SessionMetadataActivityField.Name,
          body: { name: RENAMED_NAME },
          action: ArtifactActivityAction.FieldChange,
          before: {
            field: ArtifactFieldEditField.Name,
            value: ORIGINAL_NAME,
            valueClassification: ArtifactFieldEditValueClassification.Content,
          },
          after: {
            field: ArtifactFieldEditField.Name,
            value: RENAMED_NAME,
            valueClassification: ArtifactFieldEditValueClassification.Content,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
      ];
      const editors: string[] = [];
      for (const input of fields) {
        const editor = await createTestUser(fixture.organizationId);
        editors.push(editor.id);
        auth.user = { id: editor.id, organizationId: fixture.organizationId };
        auth.authMethod = "api_key";
        expect(await readCollaboratorIds(fixture.sessionId)).not.toContain(
          editor.id
        );
        expect((await patch(fixture.sessionId, input.body)).status).toBe(200);
        expect((await patch(fixture.sessionId, input.body)).status).toBe(200);
        expect(await readCollaboratorIds(fixture.sessionId)).toContain(
          editor.id
        );
        const receipts = await readReceipts(
          fixture.organizationId,
          fixture.sessionId
        );
        expect(receipts.filter((event) => event.actorId === editor.id)).toEqual(
          [
            {
              action: input.action,
              actorType: ArtifactActivityActorType.Agent,
              actorId: editor.id,
              before: input.before,
              after: input.after,
            },
          ]
        );
      }
      const tagEditor = await createTestUser(fixture.organizationId);
      auth.user = { id: tagEditor.id, organizationId: fixture.organizationId };
      auth.authMethod = "session";
      expect(await readCollaboratorIds(fixture.sessionId)).not.toContain(
        tagEditor.id
      );
      const tagId = await createTag(fixture.organizationId, tagEditor.id);
      const tagBody = {
        tagId,
        entityType: TagEntityType.Artifact,
        entityId: fixture.sessionId,
      };
      expect((await postTag(tagBody)).status).toBe(200);
      expect((await postTag(tagBody)).status).toBe(200);
      expect(await readCollaboratorIds(fixture.sessionId)).toContain(
        tagEditor.id
      );
      const deleteUrl = new URL("https://api.example.test/entity-tags");
      for (const [key, value] of Object.entries(tagBody)) {
        deleteUrl.searchParams.set(key, value);
      }
      expect(
        (
          await deleteTag(new NextRequest(deleteUrl, { method: "DELETE" }), {
            params: Promise.resolve({}),
          })
        ).status
      ).toBe(200);
      expect(
        (
          await deleteTag(new NextRequest(deleteUrl, { method: "DELETE" }), {
            params: Promise.resolve({}),
          })
        ).status
      ).toBe(200);
      const receipts = await readReceipts(
        fixture.organizationId,
        fixture.sessionId
      );
      expect(receipts).toHaveLength(7);
      expect(
        receipts.filter((event) => event.actorId === tagEditor.id)
      ).toEqual([
        {
          action: ArtifactActivityAction.FieldChange,
          actorType: ArtifactActivityActorType.User,
          actorId: tagEditor.id,
          before: {
            field: ArtifactFieldEditField.Tag,
            value: null,
            valueClassification: ArtifactFieldEditValueClassification.Absent,
          },
          after: {
            field: ArtifactFieldEditField.Tag,
            value: tagId,
            valueClassification: ArtifactFieldEditValueClassification.Reference,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
        {
          action: ArtifactActivityAction.FieldChange,
          actorType: ArtifactActivityActorType.User,
          actorId: tagEditor.id,
          before: {
            field: ArtifactFieldEditField.Tag,
            value: tagId,
            valueClassification: ArtifactFieldEditValueClassification.Reference,
          },
          after: {
            field: ArtifactFieldEditField.Tag,
            value: null,
            valueClassification: ArtifactFieldEditValueClassification.Absent,
            result: ArtifactFieldEditReceiptResult.Committed,
          },
        },
      ]);
      // The collaborator evidence's owner source is the session's Created by
      // (`artifacts.created_by_id`, ISS-12251 D-4), which a reassignment does
      // not move.
      expect(new Set(await readCollaboratorIds(fixture.sessionId))).toEqual(
        new Set([fixture.owner.id, ...editors, tagEditor.id])
      );
    });

    it("does not count UUID spelling differences as metadata edits", async () => {
      const fixture = await seedFixture();
      auth.user = {
        id: fixture.nextOwner.id,
        organizationId: fixture.organizationId,
      };
      await withDb((db) =>
        db.artifact.updateMany({
          where: {
            id: fixture.sessionId,
            organizationId: fixture.organizationId,
          },
          data: { projectId: fixture.projectId },
        })
      );
      const before = await readState(fixture.organizationId, fixture.sessionId);
      const response = await patch(fixture.sessionId, {
        projectId: fixture.projectId.toUpperCase(),
        ownerUserId: fixture.owner.id.toUpperCase(),
      });
      expect(response.status).toBe(200);
      expect(
        await readState(fixture.organizationId, fixture.sessionId)
      ).toEqual(before);
      expect(
        await readReceipts(fixture.organizationId, fixture.sessionId)
      ).toEqual([]);
      const result = await artifactCollaboratorsService.readBatch(
        fixture.organizationId,
        {
          artifactType: CollaboratorArtifactType.Session,
          artifactIds: [fixture.sessionId],
        }
      );
      expect(
        result.results[0]?.collaborators.people.map((person) => person.userId)
      ).toEqual([fixture.owner.id]);
    });

    it.each([
      AgentSessionPatchField.Status,
      SessionMetadataActivityField.ProjectId,
      SessionMetadataActivityField.AssigneeId,
      SessionMetadataActivityField.Priority,
      SessionMetadataActivityField.Name,
    ])("rolls the real %s write back if its receipt fails", async (field) => {
      const fixture = await seedFixture();
      auth.user = {
        id: fixture.owner.id,
        organizationId: fixture.organizationId,
      };
      const bodies = {
        [AgentSessionPatchField.Status]: {
          status: SESSION_STATUS.INACTIVE,
        },
        [SessionMetadataActivityField.ProjectId]: {
          projectId: fixture.projectId,
        },
        [SessionMetadataActivityField.AssigneeId]: {
          ownerUserId: fixture.nextOwner.id,
        },
        [SessionMetadataActivityField.Priority]: { priority: Priority.High },
        [SessionMetadataActivityField.Name]: { name: RENAMED_NAME },
      };
      const receiptMethod =
        field === SessionMetadataActivityField.Priority
          ? "recordActivityEvents"
          : "recordActivityEvent";
      vi.spyOn(artifactActivityService, receiptMethod).mockRejectedValueOnce(
        new Error("receipt unavailable")
      );
      expect((await patch(fixture.sessionId, bodies[field])).status).toBe(500);
      expect(
        await readState(fixture.organizationId, fixture.sessionId)
      ).toEqual({
        status: SESSION_STATUS.ACTIVE,
        priority: null,
        projectId: null,
        assigneeId: fixture.owner.id,
        session: { nameOverride: null },
      });
      expect(
        await readReceipts(fixture.organizationId, fixture.sessionId)
      ).toEqual([]);
    });

    it("rolls back native tag insertion when its receipt fails", async () => {
      const fixture = await seedFixture();
      auth.user = {
        id: fixture.owner.id,
        organizationId: fixture.organizationId,
      };
      const tagId = await createTag(fixture.organizationId, fixture.owner.id);
      vi.spyOn(
        artifactActivityService,
        "recordActivityEvent"
      ).mockRejectedValueOnce(new Error("receipt unavailable"));
      const response = await postTag({
        tagId,
        entityType: TagEntityType.Artifact,
        entityId: fixture.sessionId,
      });
      expect(response.status).toBe(500);
      expect(
        await withDb((db) =>
          db.tagArtifact.count({
            where: { tagId, artifactId: fixture.sessionId },
          })
        )
      ).toBe(0);
      expect(
        await readReceipts(fixture.organizationId, fixture.sessionId)
      ).toEqual([]);
    });

    it("rejects a stale or foreign write and records only the committed status retry", async () => {
      const fixture = await seedFixture();
      auth.user = {
        id: fixture.owner.id,
        organizationId: fixture.organizationId,
      };
      expect(
        (
          await patch(fixture.sessionId, {
            status: SESSION_STATUS.INACTIVE,
            expectedStatus: SESSION_STATUS.ERROR,
          })
        ).status
      ).toBe(409);
      expect(
        await readReceipts(fixture.organizationId, fixture.sessionId)
      ).toEqual([]);
      expect(
        (
          await patch(fixture.sessionId, {
            status: SESSION_STATUS.INACTIVE,
            expectedStatus: SESSION_STATUS.ACTIVE,
          })
        ).status
      ).toBe(200);
      expect(
        (
          await patch(fixture.sessionId, {
            status: SESSION_STATUS.INACTIVE,
            expectedStatus: SESSION_STATUS.ACTIVE,
          })
        ).status
      ).toBe(200);
      const foreignOrganizationId = await tracker.create();
      const foreign = await createTestUser(foreignOrganizationId);
      auth.user = { id: foreign.id, organizationId: foreignOrganizationId };
      expect(
        (await patch(fixture.sessionId, { status: SESSION_STATUS.ERROR }))
          .status
      ).toBe(404);
      expect(
        await readReceipts(fixture.organizationId, fixture.sessionId)
      ).toEqual([
        {
          action: ArtifactActivityAction.StatusChange,
          actorType: ArtifactActivityActorType.User,
          actorId: fixture.owner.id,
          before: SESSION_STATUS.ACTIVE,
          after: SESSION_STATUS.INACTIVE,
        },
      ]);
    });

    it.each([bulkAssign, bulkAssignV2])(
      "records only committed bulk project and owner transitions across both route versions",
      async (route) => {
        const fixture = await seedFixture();
        const secondId = await createOwnedSession(fixture, {
          label: "bulk-writer-receipts",
          metadataActivityCoverageStartedAt: COVERAGE_STARTED_AT,
        });
        const editor = await createTestUser(fixture.organizationId);
        auth.user = { id: editor.id, organizationId: fixture.organizationId };
        auth.authMethod = "api_key";
        const sessionIds = [fixture.sessionId, secondId];
        for (const assignment of [
          {
            field: AgentSessionBulkAssignField.Project,
            value: fixture.projectId,
            activityField: SessionMetadataActivityField.ProjectId,
            action: ArtifactActivityAction.FieldChange,
          },
          {
            field: AgentSessionBulkAssignField.Owner,
            value: fixture.nextOwner.id,
            activityField: SessionMetadataActivityField.AssigneeId,
            action: ArtifactActivityAction.Assignment,
          },
        ]) {
          const body = {
            sessionIds,
            field: assignment.field,
            value: assignment.value,
          };
          expect((await postBatch(route, body)).status).toBe(200);
          expect((await postBatch(route, body)).status).toBe(200);
          for (const id of sessionIds) {
            const receipts = await readReceipts(fixture.organizationId, id);
            expect(
              receipts.filter((event) => event.action === assignment.action)
            ).toEqual([
              expect.objectContaining({
                actorType: ArtifactActivityActorType.Agent,
                actorId: editor.id,
                after: expect.objectContaining({
                  field: assignment.activityField,
                  value: assignment.value,
                }),
              }),
            ]);
          }
        }
        const result = await artifactCollaboratorsService.readBatch(
          fixture.organizationId,
          {
            artifactType: CollaboratorArtifactType.Session,
            artifactIds: sessionIds,
          }
        );
        expect(result.results).toHaveLength(2);
        for (const item of result.results) {
          // Owner-source evidence is the session's Created by; see the first case.
          expect(
            new Set(item.collaborators.people.map((person) => person.userId))
          ).toEqual(new Set([fixture.owner.id, editor.id]));
          expect(
            await readReceipts(fixture.organizationId, item.artifactId)
          ).toHaveLength(2);
        }
      }
    );

    it.each([bulkAssign, bulkAssignV2])(
      "rolls every bulk assignment back when its batched receipt fails",
      async (route) => {
        const fixture = await seedFixture();
        const secondId = await createOwnedSession(fixture, {
          label: "bulk-rollback",
        });
        auth.user = {
          id: fixture.owner.id,
          organizationId: fixture.organizationId,
        };
        vi.spyOn(
          artifactActivityService,
          "recordActivityEvents"
        ).mockRejectedValueOnce(new Error("receipt unavailable"));
        expect(
          (
            await postBatch(route, {
              sessionIds: [fixture.sessionId, secondId],
              field: AgentSessionBulkAssignField.Owner,
              value: fixture.nextOwner.id,
            })
          ).status
        ).toBe(500);
        for (const id of [fixture.sessionId, secondId]) {
          expect((await readState(fixture.organizationId, id)).assigneeId).toBe(
            fixture.owner.id
          );
          expect(await readReceipts(fixture.organizationId, id)).toEqual([]);
        }
      }
    );

    it.each([applyBatchTag, applyBatchTagV2])(
      "records batch tags only for new memberships and rolls the batch back on receipt failure",
      async (route) => {
        const fixture = await seedFixture();
        const secondId = await createTestSessionDetail({
          organizationId: fixture.organizationId,
          userId: fixture.owner.id,
          label: "batch-tag-receipts",
        });
        auth.user = {
          id: fixture.owner.id,
          organizationId: fixture.organizationId,
        };
        const tagId = await createTag(fixture.organizationId, fixture.owner.id);
        expect(
          (
            await postTag({
              tagId,
              entityType: TagEntityType.Artifact,
              entityId: fixture.sessionId,
            })
          ).status
        ).toBe(200);
        const body = {
          tagId,
          entityType: TagEntityType.Artifact,
          entityIds: [fixture.sessionId, secondId],
        };
        vi.spyOn(
          artifactActivityService,
          "recordActivityEvents"
        ).mockRejectedValueOnce(new Error("receipt unavailable"));
        expect((await postBatch(route, body)).status).toBe(500);
        expect(
          await withDb((db) =>
            db.tagArtifact.findMany({
              where: { tagId, artifactId: { in: body.entityIds } },
              select: { artifactId: true },
            })
          )
        ).toEqual([{ artifactId: fixture.sessionId }]);
        expect(await readReceipts(fixture.organizationId, secondId)).toEqual(
          []
        );
        expect((await postBatch(route, body)).status).toBe(200);
        expect((await postBatch(route, body)).status).toBe(200);
        for (const id of body.entityIds) {
          expect(await readReceipts(fixture.organizationId, id)).toEqual([
            expect.objectContaining({
              actorType: ArtifactActivityActorType.User,
              actorId: fixture.owner.id,
              action: ArtifactActivityAction.FieldChange,
              after: expect.objectContaining({
                field: SessionMetadataActivityField.Tag,
                value: tagId,
              }),
            }),
          ]);
        }
      }
    );
  }
);

async function seedFixture() {
  const organizationId = await tracker.create();
  const owner = await createTestUser(organizationId);
  const nextOwner = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, owner.id);
  const sessionId = await createTestSessionDetail({
    organizationId,
    userId: owner.id,
    label: "writer-receipts",
    metadataActivityCoverageStartedAt: COVERAGE_STARTED_AT,
  });
  await withDb((db) =>
    db.artifact.updateMany({
      where: { id: sessionId, organizationId },
      data: {
        name: ORIGINAL_NAME,
        status: SESSION_STATUS.ACTIVE,
        priority: null,
        projectId: null,
        // The Owner every synced session carries (ISS-12251 D-1).
        assigneeId: owner.id,
      },
    })
  );
  return { organizationId, owner, nextOwner, projectId, sessionId };
}

/** A second session of the fixture's owner, assigned to them as ingest does. */
async function createOwnedSession(
  fixture: { organizationId: string; owner: { id: string } },
  params: { label: string; metadataActivityCoverageStartedAt?: Date }
) {
  const id = await createTestSessionDetail({
    organizationId: fixture.organizationId,
    userId: fixture.owner.id,
    ...params,
  });
  await withDb((db) =>
    db.artifact.updateMany({
      where: { id, organizationId: fixture.organizationId },
      data: { assigneeId: fixture.owner.id },
    })
  );
  return id;
}

function patch(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`https://api.example.test/agent-sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

function readReceipts(organizationId: string, artifactId: string) {
  return withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: { organizationId, artifactId },
      select: {
        action: true,
        actorType: true,
        actorId: true,
        before: true,
        after: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  );
}

function readState(organizationId: string, id: string) {
  return withDb((db) =>
    db.artifact.findFirstOrThrow({
      where: { id, organizationId },
      select: {
        status: true,
        priority: true,
        projectId: true,
        assigneeId: true,
        session: { select: { nameOverride: true } },
      },
    })
  );
}

async function createTag(organizationId: string, createdById: string) {
  const tag = await withDb((db) =>
    db.tag.create({
      data: {
        organizationId,
        createdById,
        name: "collaborator-tag",
        color: TAG_COLORS[0],
      },
      select: { id: true },
    })
  );
  return tag.id;
}

function postTag(body: unknown) {
  return applyTag(
    new NextRequest("https://api.example.test/entity-tags", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

function postBatch(
  route: (
    request: NextRequest,
    context: { params: Promise<Record<string, string>> }
  ) => Promise<Response>,
  body: unknown
) {
  return route(
    new NextRequest("https://api.example.test/batch", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

/** Actual bounded GET after real PATCH/tag writes, with a fresh non-owner actor. */
async function readCollaboratorIds(sessionId: string) {
  const url = new URL("https://api.example.test/artifacts/collaborators");
  url.searchParams.set("artifactType", CollaboratorArtifactType.Session);
  url.searchParams.append("artifactIds", sessionId);
  const response = await getCollaborators(new NextRequest(url), {
    params: Promise.resolve({}),
  });
  if (response.status !== 200) {
    throw new Error(`Collaborators GET returned HTTP ${response.status}`);
  }
  const body = z
    .object({ success: z.literal(true), data: z.unknown() })
    .parse(await response.json());
  const batch = normalizeArtifactCollaboratorBatchResponse(
    body.data,
    CollaboratorArtifactType.Session
  );
  return (
    batch.results[0]?.collaborators.people.map((person) => person.userId) ?? []
  );
}
