/**
 * ISS-11767: Branch detail reads stored PR comments and their lane proof as
 * separate statements, so they must share one snapshot. A reconcile that
 * commits a new comment plus complete proof after the identity read has begun
 * must be invisible to the rest of that read, never half-seen.
 */
import { BranchPushSource } from "@repo/api/src/types/artifact";
import {
  BranchCollaboratorSource,
  type BranchCollaborators,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  seedCompleteProof,
  seedProvenScope,
  seedStoredGitHubComments,
} from "@/__tests__/support/branches/pull-request-comment-proof.test-fixtures";
import { GITHUB_TEST_REPOSITORY } from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "../branch-read-service";

const identityReadBarrier = vi.hoisted(() => {
  let active: {
    markReached: () => void;
    released: Promise<void>;
  } | null = null;
  return {
    arm(): { reached: Promise<void>; release: () => void } {
      let markReached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      active = { markReached, released };
      return { reached, release };
    },
    async pauseOnce(): Promise<void> {
      const state = active;
      if (!state) {
        return;
      }
      active = null;
      state.markReached();
      await state.released;
    },
  };
});

// The identity read's first statement; pausing after it leaves the snapshot
// pinned and the comment and proof reads still to run.
vi.mock("./session-usage-window", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-usage-window")>();
  return {
    ...actual,
    getSessionUsageByBranch: async (
      ...args: Parameters<typeof actual.getSessionUsageByBranch>
    ) => {
      const usage = await actual.getSessionUsageByBranch(...args);
      await identityReadBarrier.pauseOnce();
      return usage;
    },
  };
});

const tracker = createCommittedTestOrganizationTracker();
const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("Branch detail identity snapshot", () => {
  afterEach(() => tracker.cleanup());

  it("does not see a comment and complete proof committed after the identity read began", async () => {
    const scope = await seedProvenScope(await tracker.create());
    const owner = await createTestUser(scope.organizationId);
    const commenter = await createTestUser(scope.organizationId);
    await withDb(async (db) => {
      await db.branchDetail.update({
        where: { artifactId: scope.branchArtifactId },
        data: {
          firstPushedAt: new Date("2026-07-03T09:13:00.000Z"),
          pushSource: BranchPushSource.Session,
        },
        select: { artifactId: true },
      });
      await db.publicRepository.create({
        data: {
          organizationId: scope.organizationId,
          ...persistedGitHubRepositoryAuthority({
            githubRepoId: "detail-identity-snapshot",
            fullName: GITHUB_TEST_REPOSITORY,
          }),
          owner: "acme",
          name: "web",
          htmlUrl: `https://github.com/${GITHUB_TEST_REPOSITORY}`,
        },
        select: { id: true },
      });
    });
    await linkValidSessionToBranch({
      organizationId: scope.organizationId,
      userId: owner.id,
      branchArtifactId: scope.branchArtifactId,
      label: "detail-identity-snapshot",
    });
    const readDetail = () =>
      branchReadService.getBranchDetail(
        scope.organizationId,
        scope.branchArtifactId
      );

    const barrier = identityReadBarrier.arm();
    const pinnedRead = readDetail();
    try {
      const boundary = await Promise.race([
        barrier.reached.then(() => "reached" as const),
        pinnedRead.then(() => "finished" as const),
      ]);
      if (boundary === "finished") {
        throw new Error("Detail read finished before the identity barrier");
      }
      await seedStoredGitHubComments(scope, commenter.id, 1);
      await seedCompleteProof(scope);
    } finally {
      barrier.release();
    }

    expect(
      pullRequestCommentState((await pinnedRead)?.collaborators, commenter.id)
    ).toEqual({
      availability: BranchIdentityAvailability.Incomplete,
      hasCommenter: false,
    });
    // The commit landed: a read that starts after it sees both halves.
    expect(
      pullRequestCommentState((await readDetail())?.collaborators, commenter.id)
    ).toEqual({
      availability: BranchIdentityAvailability.Complete,
      hasCommenter: true,
    });
  });
});

function pullRequestCommentState(
  collaborators: BranchCollaborators | undefined,
  commenterId: string
) {
  return {
    availability:
      collaborators?.sources[BranchCollaboratorSource.PullRequestComments],
    hasCommenter:
      collaborators?.people.some((person) => person.userId === commenterId) ??
      false,
  };
}
