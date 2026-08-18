/**
 * FEA-3820 real-boundary coverage: desktop branch-link sync persists the
 * participation scalar, then the cloud branch read projects that scalar while
 * keeping successful reviewed participation in the Branch detail spend total.
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
} from "@repo/api/src/types/session-artifact-link";
import { ThreadSource, ThreadStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchReadService } from "@/app/branches/branch-read-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const observedAt = "2026-07-03T09:13:00.000Z";

describeIfDb("branch participation real boundary (FEA-3820)", () => {
  it("persists reviewed participation and reconciles its branch spend", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const commenter = await createTestUser(organizationId);
      const computeTarget = await createComputeTarget(organizationId, user.id);
      const repositoryFullName = "closedloop-ai/symphony-alpha";
      const branchName = "codex/fea-3820-review-boundary";

      await withDb((db) =>
        db.publicRepository.create({
          data: {
            organizationId,
            ...persistedGitHubRepositoryAuthority({
              githubRepoId: "repo-symphony-alpha",
              fullName: repositoryFullName,
            }),
            owner: "closedloop-ai",
            name: "symphony-alpha",
            htmlUrl: `https://github.com/${repositoryFullName}`,
          },
        })
      );

      await agentSessionsService.upsertSessions(
        {
          organizationId,
          userId: user.id,
          computeTargetId: computeTarget.id,
        },
        {
          schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
          batchId: randomUUID(),
          syncMode: AgentSessionSyncMode.Incremental,
          sessionCount: 2,
          sessions: [
            buildReviewedBranchSession(repositoryFullName, branchName),
            // FEA-4225: the Branches surface only includes session-DISCOVERED
            // branches, and a reviewed-only link is not a valid linked session
            // (it never enters `sessionIds`). Seed a second session that actually
            // WROTE the branch so the branch is eligible; the FEA-3820 contract
            // under test is then that the reviewed session projects and its
            // successful review spend reconciles alongside the wrote session.
            buildWroteBranchSession(repositoryFullName, branchName),
          ],
        }
      );

      const branch = await withDb((db) =>
        db.branchDetail.findFirstOrThrow({
          where: {
            organizationId,
            repositoryFullName: normalizeRepoFullName(repositoryFullName),
            branchName,
          },
          select: { artifactId: true },
        })
      );
      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: branch.artifactId },
          data: {
            firstPushedAt: new Date(observedAt),
            pushSource: BranchPushSource.Session,
          },
        })
      );
      await withDb((db) =>
        db.gitHubUserConnection.create({
          data: {
            organizationId,
            userId: user.id,
            githubUserId: "branch-owner-github-id",
            login: "branch-owner",
            normalizedLogin: "branch-owner",
            accessTokenEncrypted: "integration-test-token",
          },
        })
      );

      const reviewedLink = await withDb((db) =>
        db.artifactLink.findFirstOrThrow({
          where: {
            organizationId,
            targetId: branch.artifactId,
            branchParticipation: BranchParticipationKind.Reviewed,
          },
          select: {
            branchParticipation: true,
            branchParticipationMethod: true,
          },
        })
      );
      expect(reviewedLink).toMatchObject({
        branchParticipation: BranchParticipationKind.Reviewed,
        branchParticipationMethod: ArtifactRefMethod.PrReviewFeedbackCommand,
      });
      // Stamp `session_branch` link-kind on every link so both are branch links.
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: {
            organizationId,
            targetId: branch.artifactId,
          },
          data: {
            metadata: {
              linkKind: "session_branch",
              branchLinked: true,
            },
          },
        })
      );
      const linkedSessions = await withDb((db) =>
        db.artifactLink.findMany({
          where: { organizationId, targetId: branch.artifactId },
          select: { sourceId: true, branchParticipation: true },
        })
      );
      const reviewedSessionId = linkedSessions.find(
        (link) => link.branchParticipation === BranchParticipationKind.Reviewed
      )?.sourceId;
      if (!reviewedSessionId) {
        throw new Error("Missing reviewed Session identity fixture");
      }
      await withDb((db) =>
        db.commentThread.create({
          data: {
            organizationId,
            source: ThreadSource.NATIVE,
            artifactId: branch.artifactId,
            status: ThreadStatus.OPEN,
            createdById: user.id,
            comments: {
              create: {
                authorId: user.id,
                body: commentBody("Branch comment"),
                plainText: "Branch comment",
              },
            },
          },
        })
      );
      await withDb((db) =>
        db.commentThread.create({
          data: {
            organizationId,
            source: ThreadSource.NATIVE,
            artifactId: reviewedSessionId,
            status: ThreadStatus.OPEN,
            createdById: commenter.id,
            comments: {
              create: {
                authorId: commenter.id,
                body: commentBody("Session comment"),
                plainText: "Session comment",
              },
            },
          },
        })
      );

      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branch.artifactId
      );

      // Two sessions now touch the branch: the reviewer and the author. The
      // branch is eligible (FEA-4225) because of the wrote session; the FEA-3820
      // FEA-3991 contract includes the reviewed session and its successful
      // review spend in the same detail total as the phase attribution.
      expect(detail?.sessions).toHaveLength(2);
      const reviewedSession = detail?.sessions.find(
        (session) => session.participation === BranchParticipationKind.Reviewed
      );
      expect(reviewedSession).toMatchObject({
        participation: BranchParticipationKind.Reviewed,
        estimatedCostUsd: 1.25,
      });
      // The wrote session contributes 2.5 and the successful reviewed session
      // contributes 1.25, so the Branch header reconciles to their 3.75 total.
      expect(detail?.estimatedCostUsd).toBe(3.75);
      expect(detail?.attributedCostUsd).toBe(3.75);
      expect(detail?.ownerIdentity).toEqual({
        availability: BranchIdentityAvailability.Complete,
        person: expect.objectContaining({
          provider: BranchPersonProvider.GitHub,
          id: "branch-owner-github-id",
          userId: user.id,
          login: "branch-owner",
        }),
      });
      expect(detail?.collaborators).toMatchObject({
        availability: BranchIdentityAvailability.Complete,
        people: expect.arrayContaining([
          expect.objectContaining({ userId: user.id }),
          expect.objectContaining({ userId: commenter.id }),
        ]),
        sources: {
          [BranchCollaboratorSource.PullRequestComments]:
            BranchIdentityAvailability.Complete,
          [BranchCollaboratorSource.BranchComments]:
            BranchIdentityAvailability.Complete,
          [BranchCollaboratorSource.SessionComments]:
            BranchIdentityAvailability.Complete,
        },
      });
    });
  });
});

function buildWroteBranchSession(
  repositoryFullName: string,
  branchName: string
): SyncedAgentSession {
  return {
    externalSessionId: "branch-participation-write-session",
    name: "Branch write session",
    status: "completed",
    harness: "codex",
    cwd: "/tmp/worktree",
    model: "gpt-5.5",
    startedAt: observedAt,
    updatedAt: observedAt,
    endedAt: observedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        estimatedCostUsd: 2.5,
      },
    ],
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName,
        branchName,
        method: BRANCH_PUSH_METHOD_VALUES[0],
        relation: ArtifactRefRelation.Created,
        observedAt,
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.BranchWrite,
            observedAt,
            evidenceId: "desktop-artifact-link:write-boundary",
          },
        ],
      },
    ],
  };
}

function commentBody(text: string) {
  return {
    content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
    type: "doc",
  };
}

function createComputeTarget(organizationId: string, userId: string) {
  return withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: "branch-participation-boundary",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
}

function buildReviewedBranchSession(
  repositoryFullName: string,
  branchName: string
): SyncedAgentSession {
  return {
    externalSessionId: "branch-participation-review-session",
    name: "Branch review session",
    status: "completed",
    harness: "codex",
    cwd: "/tmp/worktree",
    model: "gpt-5.5",
    startedAt: observedAt,
    updatedAt: observedAt,
    endedAt: observedAt,
    agents: [],
    events: [],
    tokenUsageByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCostUsd: 1.25,
      },
    ],
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName,
        branchName,
        method: ArtifactRefMethod.PrReviewFeedbackCommand,
        relation: ArtifactRefRelation.Workspace,
        observedAt,
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.ReviewFeedback,
            observedAt,
            evidenceId: "desktop-artifact-link:review-boundary",
          },
        ],
      },
    ],
  };
}
