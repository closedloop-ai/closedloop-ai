import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { ActivityFeedActorKind } from "@repo/api/src/types/artifact-activity-feed";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { tagService } from "@/app/tags/service";
import type { AuthContext } from "@/lib/auth/with-auth";

let authContext: AuthContext;
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: { params: Promise<unknown> }) =>
      handler(authContext, request, context.params),
}));

import { GET } from "./route";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();
const pushedAt = new Date("2026-07-01T00:00:00.000Z");

afterEach(async () => {
  vi.restoreAllMocks();
  await organizations.cleanup();
});

describeIfDb("Branch activity from a committed tag mutation", () => {
  it("serves one actor-attributed receipt on an eligible Branch and none for retries", async () => {
    const organizationId = await organizations.create();
    const user = await createTestUser(organizationId);
    authContext = {
      user,
      clerkUserId: user.clerkId,
      clerkOrgId: "test-org",
      authMethod: "session",
    };
    const { branchId, sessionId, tagId } = await withDb(async (db) => {
      const branch = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.BRANCH,
          name: "activity-feed-branch",
          status: BranchStatus.Open,
        },
        select: { id: true },
      });
      await db.branchDetail.create({
        data: {
          artifactId: branch.id,
          organizationId,
          repositoryFullName: "acme/activity-feed-branch",
          branchName: "activity-feed-branch",
          firstPushedAt: pushedAt,
          pushSource: BranchPushSource.Session,
        },
        select: { artifactId: true },
      });
      await db.publicRepository.create({
        data: {
          organizationId,
          ...persistedGitHubRepositoryAuthority({
            githubRepoId: `repo-${branch.id}`,
            fullName: "acme/activity-feed-branch",
          }),
          owner: "acme",
          name: "activity-feed-branch",
          htmlUrl: "https://github.com/acme/activity-feed-branch",
        },
        select: { id: true },
      });
      const session = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: "activity-feed-session",
          status: SESSION_STATUS.ACTIVE,
        },
        select: { id: true },
      });
      const computeTarget = await db.computeTarget.create({
        data: {
          organizationId,
          userId: user.id,
          machineName: "activity-feed-machine",
          platform: "darwin",
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: session.id,
          computeTargetId: computeTarget.id,
          externalSessionId: "activity-feed-session",
          sessionStartedAt: pushedAt,
          sessionUpdatedAt: pushedAt,
          lastActivityAt: pushedAt,
        },
        select: { artifactId: true },
      });
      await db.artifactLink.create({
        data: {
          organizationId,
          sourceId: session.id,
          targetId: branch.id,
          linkType: LinkType.RelatesTo,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        },
        select: { id: true },
      });
      const tag = await db.tag.create({
        data: {
          organizationId,
          createdById: user.id,
          name: "activity-feed-tag",
          color: TagColor.Red,
        },
        select: { id: true },
      });
      return { branchId: branch.id, sessionId: session.id, tagId: tag.id };
    });

    const actor = { userId: user.id, authMethod: "session" } as const;
    await tagService.applyTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );
    await tagService.applyTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );

    const stored = await withDb((db) =>
      db.artifactActivityEvent.findMany({
        where: { organizationId, artifactId: branchId },
        select: { action: true, actorId: true, after: true },
      })
    );
    expect(stored).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        actorId: user.id,
        after: {
          field: ArtifactFieldEditField.Tag,
          value: tagId,
          valueClassification: ArtifactFieldEditValueClassification.Reference,
          result: ArtifactFieldEditReceiptResult.Committed,
        },
      },
    ]);

    const response = await GET(
      new NextRequest(`http://localhost/branches/${branchId}/activity`),
      { params: Promise.resolve({ id: branchId }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toEqual([
      expect.objectContaining({
        action: ArtifactActivityAction.FieldChange,
        actor: { kind: ActivityFeedActorKind.Human, id: user.id },
        after: {
          field: ArtifactFieldEditField.Tag,
          value: tagId,
          valueClassification: ArtifactFieldEditValueClassification.Reference,
          result: ArtifactFieldEditReceiptResult.Committed,
        },
      }),
    ]);

    const futureActor = await withDb((db) =>
      db.artifactActivityEvent.create({
        data: {
          organizationId,
          artifactId: branchId,
          action: ArtifactActivityAction.FieldChange,
          actorType: "future_actor_type",
          actorId: null,
        },
        select: { id: true },
      })
    );
    const skewedPage = await GET(
      new NextRequest(`http://localhost/branches/${branchId}/activity?limit=1`),
      { params: Promise.resolve({ id: branchId }) }
    );
    expect(skewedPage.status).toBe(200);
    expect((await skewedPage.json()).data).toEqual({
      items: [
        expect.objectContaining({
          actor: { kind: ActivityFeedActorKind.Human, id: user.id },
        }),
      ],
      nextCursor: null,
    });
    await withDb((db) =>
      db.artifactActivityEvent.delete({ where: { id: futureActor.id } })
    );

    const receiptFailure = Object.assign(new Error("receipt collision"), {
      code: "P2002",
      meta: { target: ["id"] },
    });
    const failedRemove = vi
      .spyOn(artifactActivityService, "recordActivityEvent")
      .mockRejectedValueOnce(receiptFailure);
    await expect(
      tagService.removeTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
    ).rejects.toBe(receiptFailure);
    failedRemove.mockRestore();
    expect(await branchTagCounts(organizationId, branchId, tagId)).toEqual({
      relations: 1,
      receipts: 1,
    });

    await tagService.removeTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );
    await tagService.removeTag(
      tagId,
      TagEntityType.Artifact,
      branchId,
      organizationId,
      actor
    );
    expect(await branchTagCounts(organizationId, branchId, tagId)).toEqual({
      relations: 0,
      receipts: 2,
    });
    const afterRemove = await withDb((db) =>
      db.artifactActivityEvent.findMany({
        where: { organizationId, artifactId: branchId },
        select: { before: true, after: true },
      })
    );
    expect(afterRemove).toContainEqual({
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
    });

    const failedAdd = vi
      .spyOn(artifactActivityService, "recordActivityEvent")
      .mockRejectedValueOnce(receiptFailure);
    await expect(
      tagService.applyTag(
        tagId,
        TagEntityType.Artifact,
        branchId,
        organizationId,
        actor
      )
    ).rejects.toBe(receiptFailure);
    failedAdd.mockRestore();
    expect(await branchTagCounts(organizationId, branchId, tagId)).toEqual({
      relations: 0,
      receipts: 2,
    });

    const ownerAuthContext = authContext;
    authContext = {
      ...authContext,
      user: { ...user, organizationId: "00000000-0000-7000-8000-000000000001" },
    };
    const foreignResponse = await GET(
      new NextRequest(`http://localhost/branches/${branchId}/activity`),
      { params: Promise.resolve({ id: branchId }) }
    );
    expect(foreignResponse.status).toBe(404);

    authContext = ownerAuthContext;
    expect((await readBranchActivity(sessionId)).status).toBe(404);

    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: branchId },
        data: { firstPushedAt: null, pushSource: null },
        select: { artifactId: true },
      })
    );
    expect((await readBranchActivity(branchId)).status).toBe(404);

    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: branchId },
        data: {
          firstPushedAt: pushedAt,
          pushSource: BranchPushSource.Session,
          branchName: "main",
        },
        select: { artifactId: true },
      })
    );
    expect((await readBranchActivity(branchId)).status).toBe(404);

    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: branchId },
        data: { branchName: "activity-feed-branch", deletedAt: new Date() },
        select: { artifactId: true },
      })
    );
    // ISS-11589 (operator ruling, Cosimo Corrigan, 2026-10-09): deletion decides
    // only whether a branch is active, so a deleted branch is still served.
    expect((await readBranchActivity(branchId)).status).toBe(200);
  });
});

function readBranchActivity(id: string) {
  return GET(new NextRequest(`http://localhost/branches/${id}/activity`), {
    params: Promise.resolve({ id }),
  });
}

function branchTagCounts(
  organizationId: string,
  branchId: string,
  tagId: string
) {
  return withDb(async (db) => ({
    relations: await db.tagArtifact.count({
      where: { artifactId: branchId, tagId },
    }),
    receipts: await db.artifactActivityEvent.count({
      where: { organizationId, artifactId: branchId },
    }),
  }));
}
