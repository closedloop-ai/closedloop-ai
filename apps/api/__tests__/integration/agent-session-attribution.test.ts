import { randomUUID } from "node:crypto";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  GitHubInstallationStatus,
  GitHubPRState,
  LinkType,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("agent-session attribution integration", () => {
  it("splits multi-branch sessions and excludes stale or cross-org PR evidence", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedAttributionFixture();

      const usage = await agentSessionsService.getUsageSummary({
        organizationId: fixture.organizationId,
        filters: {},
      });
      const branchOne = usage.byBranch?.find(
        (row) => row.branchArtifactId === fixture.branchOneArtifactId
      );
      const branchTwo = usage.byBranch?.find(
        (row) => row.branchArtifactId === fixture.branchTwoArtifactId
      );
      const branchThree = usage.byBranch?.find(
        (row) => row.branchArtifactId === fixture.branchThreeArtifactId
      );

      expect(usage.byUser).toEqual([
        expect.objectContaining({
          estimatedCost: 4,
          inputTokens: 400,
          userId: fixture.userId,
        }),
      ]);
      expect(branchOne).toEqual(
        expect.objectContaining({
          estimatedCost: 1.333_333,
          inputTokens: 133,
          sessionCount: 1,
        })
      );
      expect(branchTwo).toEqual(
        expect.objectContaining({
          estimatedCost: 1.333_333,
          inputTokens: 133,
          sessionCount: 1,
        })
      );
      expect(branchThree).toEqual(
        expect.objectContaining({
          estimatedCost: 1.333_333,
          inputTokens: 133,
          sessionCount: 1,
        })
      );
      expect(
        usage.byBranch?.some(
          (row) => row.branchArtifactId === fixture.crossOrgBranchArtifactId
        )
      ).toBe(false);
      expect(usage.byPr).toEqual([
        expect.objectContaining({
          branchArtifactId: fixture.branchOneArtifactId,
          estimatedCost: 1.333_333,
          inputTokens: 133,
          prNumber: 101,
        }),
      ]);

      const artifactUsage = await agentSessionsService.getArtifactSessionUsage(
        fixture.organizationId,
        fixture.branchOneArtifactId
      );

      expect(artifactUsage).toEqual({
        artifactId: fixture.branchOneArtifactId,
        artifactSlug: null,
        byModel: [
          {
            cacheReadTokens: 13,
            cacheWriteTokens: 7,
            estimatedCostUsd: 1.333_333,
            inputTokens: 133,
            model: "gpt-5.5",
            outputTokens: 67,
          },
        ],
        cacheReadTokens: 13,
        cacheWriteTokens: 7,
        estimatedCostUsd: 1.333_333,
        inputTokens: 133,
        outputTokens: 67,
        sessionCount: 1,
      });
    });
  });

  // FEA-3119 (PRD-525 P3, DoD #7/#8): the branch cost/usage numerator must
  // include implementation + code-review + VQA + rework sessions from EVERY
  // contributor who touched the branch id (first push → merge/production), with
  // NO session dropped and NONE double-counted. Attribution keys on the
  // branch-id write-evidence link (linkKind = session_pr), not on the session's
  // semantic role, so a review/VQA/rework session that references the branch's
  // PR is attributed exactly like the first implementation session. This proves
  // the invariant end-to-end against a real DB (the where predicate is applied,
  // not mocked).
  it("rolls up every attributed session across roles and contributors with no drop or double-count", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedMultiSessionBranchFixture();

      const usage = await agentSessionsService.getUsageSummary({
        organizationId: fixture.organizationId,
        filters: {},
      });
      const branchRow = usage.byBranch?.find(
        (row) => row.branchArtifactId === fixture.branchArtifactId
      );

      // Invariant #1 + #2: the branch total equals the sum over EVERY attributed
      // session (implementation + review + VQA + rework, both contributors), so
      // none is dropped and none is double-counted. Each session links to this
      // single branch only, so its whole cost/usage attributes here (denominator
      // 1). Four sessions of 1.000000 / 100 input each ⇒ 4 / 400.
      expect(branchRow).toEqual(
        expect.objectContaining({
          branchArtifactId: fixture.branchArtifactId,
          estimatedCost: 4,
          inputTokens: 400,
          outputTokens: 200,
          cacheReadTokens: 40,
          cacheWriteTokens: 20,
          // sessionCount counts every distinct attributed session, not just the
          // first implementation one.
          sessionCount: 4,
        })
      );

      // Invariant #3: attribution follows the branch-id write-evidence link. The
      // artifact-level rollup (getArtifactSessionUsage) resolves the same four
      // sessions via that link and must agree with the by-branch lens.
      const artifactUsage = await agentSessionsService.getArtifactSessionUsage(
        fixture.organizationId,
        fixture.branchArtifactId
      );
      expect(artifactUsage).toEqual(
        expect.objectContaining({
          artifactId: fixture.branchArtifactId,
          sessionCount: 4,
          estimatedCostUsd: 4,
          inputTokens: 400,
          outputTokens: 200,
          cacheReadTokens: 40,
          cacheWriteTokens: 20,
        })
      );

      // Invariant #4: the display predicate (the Branches list's push/PR
      // visibility gate) does NOT alter the attribution predicate. Every
      // contributor's spend is present in the rollup regardless of who pushed;
      // the per-user lens over the same corpus sums to the same total and names
      // both contributors.
      const totalByUser = (usage.byUser ?? []).reduce(
        (sum, row) => sum + row.estimatedCost,
        0
      );
      expect(totalByUser).toBe(4);
      expect((usage.byUser ?? []).map((row) => row.userId).sort()).toEqual(
        [fixture.contributorOneId, fixture.contributorTwoId].sort()
      );
    });
  });
});

/**
 * FEA-3119 fixture: one branch with a current, verified PR, touched by four
 * sessions — implementation and VQA by contributor one, code-review and rework
 * by contributor two. Each session references the branch's PR (a session_pr
 * write-evidence link), mirroring how the desktop sync attributes any session
 * that touched the branch id regardless of its role. Per-session usage is a
 * flat 1.000000 / 100-input so the expected rollup is an exact, drop/double-
 * count-sensitive sum (4 / 400).
 */
async function seedMultiSessionBranchFixture() {
  const organizationId = await createTestOrganization();
  const contributorOne = await createTestUser(organizationId);
  const contributorTwo = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, contributorOne.id);
  const repository = await createRepository(organizationId, "owner/rollup");
  const branchArtifactId = await createBranchWithCurrentPr({
    branchName: "feature/rollup",
    organizationId,
    projectId,
    repositoryFullName: "owner/rollup",
    repositoryId: repository.id,
    prNumber: 301,
    prState: GitHubPRState.MERGED,
    verified: true,
  });

  const roleContributors: {
    role: string;
    userId: string;
    relationType: SessionPrRelationType;
  }[] = [
    {
      role: "implementation",
      userId: contributorOne.id,
      relationType: SessionPrRelationType.Created,
    },
    {
      role: "code-review",
      userId: contributorTwo.id,
      relationType: SessionPrRelationType.Referenced,
    },
    {
      role: "vqa",
      userId: contributorOne.id,
      relationType: SessionPrRelationType.Referenced,
    },
    {
      role: "rework",
      userId: contributorTwo.id,
      relationType: SessionPrRelationType.Created,
    },
  ];

  for (const entry of roleContributors) {
    const computeTargetId = await createComputeTarget(
      organizationId,
      entry.userId
    );
    const sessionArtifactId = await createSession({
      cacheReadTokens: 10n,
      cacheWriteTokens: 5n,
      computeTargetId,
      // Flat per-session usage so the four-session sum is exact.
      estimatedCost: "1.000000",
      inputTokens: 100n,
      organizationId,
      outputTokens: 50n,
      projectId,
      userId: entry.userId,
    });
    await createSessionPrLink({
      organizationId,
      relationTypes: [entry.relationType],
      sessionArtifactId,
      targetArtifactId: branchArtifactId,
    });
  }

  return {
    branchArtifactId,
    contributorOneId: contributorOne.id,
    contributorTwoId: contributorTwo.id,
    organizationId,
  };
}

async function seedAttributionFixture() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const repository = await createRepository(organizationId, "owner/repo");
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  const branchOneArtifactId = await createBranchWithCurrentPr({
    branchName: "feature/a",
    organizationId,
    projectId,
    repositoryFullName: "owner/repo",
    repositoryId: repository.id,
    prNumber: 101,
    prState: GitHubPRState.MERGED,
    verified: true,
  });
  const branchTwoArtifactId = await createBranchWithCurrentPr({
    branchName: "feature/b",
    organizationId,
    projectId,
    repositoryFullName: "owner/repo",
    repositoryId: repository.id,
    prNumber: 102,
    prState: GitHubPRState.MERGED,
    verified: false,
  });
  const branchThreeArtifactId = await createBranchWithCurrentPr({
    branchName: "feature/c",
    organizationId,
    projectId,
    repositoryFullName: "owner/repo",
    repositoryId: repository.id,
    prNumber: 103,
    prState: GitHubPRState.MERGED,
    verified: false,
  });
  const crossOrgId = await createTestOrganization();
  const crossOrgUser = await createTestUser(crossOrgId);
  const crossOrgProjectId = await createTestProject(
    crossOrgId,
    crossOrgUser.id
  );
  const crossOrgRepository = await createRepository(crossOrgId, "owner/other");
  const crossOrgBranchArtifactId = await createBranchWithCurrentPr({
    branchName: "feature/cross-org",
    organizationId: crossOrgId,
    projectId: crossOrgProjectId,
    repositoryFullName: "owner/other",
    repositoryId: crossOrgRepository.id,
    prNumber: 201,
    prState: GitHubPRState.MERGED,
    verified: true,
  });
  const sessionArtifactId = await createSession({
    computeTargetId,
    organizationId,
    projectId,
    userId: user.id,
  });

  await createSessionPrLink({
    organizationId,
    relationTypes: [
      SessionPrRelationType.Created,
      SessionPrRelationType.Referenced,
    ],
    sessionArtifactId,
    targetArtifactId: branchOneArtifactId,
  });
  await createSessionPrLink({
    organizationId,
    relationTypes: [SessionPrRelationType.Referenced],
    sessionArtifactId,
    targetArtifactId: branchTwoArtifactId,
  });
  await createSessionPrLink({
    organizationId,
    relationTypes: [SessionPrRelationType.Referenced],
    sessionArtifactId,
    targetArtifactId: branchThreeArtifactId,
  });
  await createSessionPrLink({
    organizationId,
    relationTypes: [SessionPrRelationType.Created],
    sessionArtifactId,
    targetArtifactId: crossOrgBranchArtifactId,
  });

  return {
    branchOneArtifactId,
    branchThreeArtifactId,
    branchTwoArtifactId,
    crossOrgBranchArtifactId,
    organizationId,
    userId: user.id,
  };
}

async function createRepository(organizationId: string, fullName: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        accountId: `account-${suffix}`,
        accountLogin: "owner",
        accountType: "Organization",
        installationId: `installation-${suffix}`,
        organizationId,
        senderId: `sender-${suffix}`,
        senderLogin: "sender",
        status: GitHubInstallationStatus.ACTIVE,
      },
    })
  );
  return withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        fullName,
        githubRepoId: `repo-${suffix}`,
        installationId: installation.id,
        name: fullName.split("/").at(-1) ?? "repo",
        owner: fullName.split("/")[0] ?? "owner",
        private: false,
      },
    })
  );
}

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: `machine-${organizationId.slice(0, 8)}`,
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function createBranchWithCurrentPr(input: {
  branchName: string;
  organizationId: string;
  projectId: string;
  repositoryFullName: string;
  repositoryId: string;
  prNumber: number;
  prState: GitHubPRState;
  verified: boolean;
}) {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        branch: {
          create: {
            branchName: input.branchName,
            organizationId: input.organizationId,
            repositoryFullName: input.repositoryFullName,
            repositoryId: input.repositoryId,
          },
        },
        name: input.branchName,
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: input.prState,
        type: ArtifactType.BRANCH,
      },
      select: { id: true },
    })
  );
  const pr = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: input.organizationId,
        branchArtifactId: artifact.id,
        githubId: `${input.repositoryId}-${input.prNumber}`,
        isCurrent: true,
        lastVerifiedAt: input.verified
          ? new Date("2026-06-01T00:00:00.000Z")
          : null,
        number: input.prNumber,
        prState: input.prState,
        repositoryId: input.repositoryId,
        title: `PR ${input.prNumber}`,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.branchDetail.update({
      data: { currentPullRequestDetailId: pr.id },
      where: { artifactId: artifact.id },
    })
  );
  return artifact.id;
}

async function createSession(input: {
  computeTargetId: string;
  organizationId: string;
  projectId: string;
  userId: string;
  // Per-session usage overrides (FEA-3119). Default to the original single-
  // session fixture values so existing expectations stay unchanged.
  estimatedCost?: string;
  inputTokens?: bigint;
  outputTokens?: bigint;
  cacheReadTokens?: bigint;
  cacheWriteTokens?: bigint;
}) {
  const estimatedCost = input.estimatedCost ?? "4.000000";
  const inputTokens = input.inputTokens ?? 400n;
  const outputTokens = input.outputTokens ?? 200n;
  const cacheReadTokens = input.cacheReadTokens ?? 40n;
  const cacheWriteTokens = input.cacheWriteTokens ?? 20n;
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "Shared session",
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: SESSION_STATUS.COMPLETED,
        type: ArtifactType.SESSION,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        cacheReadTokens,
        cacheWriteTokens,
        computeTargetId: input.computeTargetId,
        estimatedCost,
        externalSessionId: `session-${artifact.id}`,
        harness: "codex",
        inputTokens,
        model: "gpt-5.5",
        outputTokens,
        sessionStartedAt: new Date("2026-06-01T12:00:00.000Z"),
        sessionUpdatedAt: new Date("2026-06-01T12:05:00.000Z"),
        userId: input.userId,
      },
    })
  );
  await withDb((db) =>
    db.agentSessionTokenUsage.create({
      data: {
        agentSessionId: artifact.id,
        cacheReadTokens,
        cacheWriteTokens,
        estimatedCost,
        inputTokens,
        model: "gpt-5.5",
        outputTokens,
      },
    })
  );
  return artifact.id;
}

async function createSessionPrLink(input: {
  organizationId: string;
  relationTypes: SessionPrRelationType[];
  sessionArtifactId: string;
  targetArtifactId: string;
}) {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        linkType: LinkType.RELATES_TO,
        metadata: {
          confidence: 1,
          linkKind: SessionArtifactLinkKind.SessionPr,
          relationTypes: input.relationTypes,
        },
        organizationId: input.organizationId,
        sourceId: input.sessionArtifactId,
        targetId: input.targetArtifactId,
      },
    })
  );
}
