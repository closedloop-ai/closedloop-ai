import { randomUUID } from "node:crypto";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type GitHubReadModelPullRequest,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  type GitHubSinglePullRequestResult,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { getUserTokenOctokit } from "@repo/github/user-token-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestLifecycleActivityPersistenceError } from "@/app/branches/pull-request-lifecycle-activity";
import { githubBackfillProjectionWriter } from "@/app/integrations/github/backfill-projection-writer";
import {
  GitHubServerSyncReason,
  GitHubServerSyncStatus,
} from "@/app/integrations/github/sync-service";
import { installPullRequestLifecycleAtomInsertBarrier } from "../support/integrations/github/pr-lifecycle-atom-barrier";
import {
  backfillInput,
  deleteFixture,
  MERGED_AT as mergedAt,
  mockProviderSuccess,
  OPENED_AT as openedAt,
  providerSuccess,
  refreshTombstoned,
  seedWriterFixture,
  type WriterFixture,
  wireClerkGitHubToken,
} from "../support/integrations/github/pr-lifecycle-writer.test-fixtures";

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

vi.mock("@repo/github/user-token-auth", () => ({
  getUserTokenOctokit: vi.fn(),
}));

// The user lane reads its token from Clerk (PLN-1742 M5 tail), so the suite
// stands up a Clerk that serves one — without it every write under test denies
// with `no_credential` before reaching the writer it is meant to exercise.
vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(),
}));

const hasDatabase = Boolean(keys().DATABASE_URL);
const firstClosedAt = "2026-08-11T13:00:00.000Z";
const secondClosedAt = "2026-08-12T13:00:00.000Z";
const conflictingOpenedAt = new Date("2026-08-09T12:00:00.000Z");

describe.skipIf(!hasDatabase)(
  "ISS-6421 non-webhook PR lifecycle writers (real Postgres)",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      wireClerkGitHubToken();
      vi.mocked(getUserTokenOctokit).mockReturnValue({
        rest: {
          users: {
            getAuthenticated: vi
              .fn()
              .mockResolvedValue({ data: { id: 4242, login: "iss-6421" } }),
          },
        },
      } as never);
    });

    it("creates and replays atoms through the actual backfill writer", async () => {
      const fixture = await seedWriterFixture("backfill-happy");
      try {
        const input = backfillInput(fixture);

        await githubBackfillProjectionWriter.write(input);
        const first = await readWriterState(fixture);
        await githubBackfillProjectionWriter.write(input);
        const replay = await readWriterState(fixture);

        expect(first.atoms).toEqual([
          expect.objectContaining({
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.PullRequestLifecycle,
            sourceEventId: `${first.pullRequest.id}:merged`,
            occurredAt: new Date(mergedAt),
            attributionKind: BranchActivityAttributionKind.PullRequest,
            pullRequestDetailId: first.pullRequest.id,
            completeness: BranchActivityEvidenceCompleteness.Complete,
          }),
          expect.objectContaining({
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.PullRequestLifecycle,
            sourceEventId: `${first.pullRequest.id}:opened`,
            occurredAt: new Date(openedAt),
            attributionKind: BranchActivityAttributionKind.PullRequest,
            pullRequestDetailId: first.pullRequest.id,
            completeness: BranchActivityEvidenceCompleteness.Complete,
          }),
        ]);
        expect(first.branch.lastActivityAt).toEqual(new Date(mergedAt));
        expect(replay.atoms).toEqual(first.atoms);
        expect(replay.branch.lastActivityAt).toEqual(
          first.branch.lastActivityAt
        );
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("retains both close occurrences through the actual backfill writer", async () => {
      const fixture = await seedWriterFixture("backfill-reopened", {
        createPullRequest: true,
      });
      try {
        await githubBackfillProjectionWriter.write(
          backfillInput(fixture, closedPullRequest(firstClosedAt))
        );
        await githubBackfillProjectionWriter.write(
          backfillInput(fixture, reopenedPullRequest())
        );
        await githubBackfillProjectionWriter.write(
          backfillInput(fixture, closedPullRequest(secondClosedAt))
        );

        const state = await readWriterState(fixture);
        expect(closeOccurrences(state)).toEqual(
          closeOccurrenceExpectations(state, [firstClosedAt, secondClosedAt])
        );
        expect(state.branch.lastActivityAt).toEqual(new Date(secondClosedAt));
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("predicts missing lifecycle atoms and Last-active before applying them", async () => {
      const fixture = await seedWriterFixture("backfill-dry-run-lifecycle", {
        createPullRequest: true,
      });
      try {
        const input = backfillInput(fixture);
        await githubBackfillProjectionWriter.write(input);
        await withDb(async (db) => {
          await db.branchActivityAtom.deleteMany({
            where: { branchArtifactId: fixture.branchArtifactId },
          });
          await db.branchDetail.update({
            where: { artifactId: fixture.branchArtifactId },
            data: { lastActivityAt: null },
            select: { artifactId: true },
          });
        });

        const prediction = await githubBackfillProjectionWriter.diff(input);
        expect(prediction).toMatchObject({
          branchProjectionChangeCount: 0,
          pullRequestProjectionChangeCount: 0,
          lifecycleAtomProjectionChangeCount: 2,
          branchLastActivityProjectionChangeCount: 1,
        });
        expect((await readWriterState(fixture)).atoms).toEqual([]);

        const applied = await githubBackfillProjectionWriter.write(input);
        expect(applied).toMatchObject({
          lifecycleAtomProjectionChangeCount: 2,
          branchLastActivityProjectionChangeCount: 1,
        });
        const state = await readWriterState(fixture);
        expect(state.atoms).toHaveLength(2);
        expect(state.branch.lastActivityAt).toEqual(new Date(mergedAt));
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rolls back every backfill projection write on atom conflict", async () => {
      const fixture = await seedWriterFixture("backfill-conflict", {
        createPullRequest: true,
      });
      try {
        await seedConflictingOpenedAtom(fixture);
        const before = await readWriterState(fixture);

        await expect(
          githubBackfillProjectionWriter.write(backfillInput(fixture))
        ).rejects.toBeInstanceOf(PullRequestLifecycleActivityPersistenceError);

        expect(await readWriterState(fixture)).toEqual(before);
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("creates and replays atoms through the actual tombstoned writer", async () => {
      const fixture = await seedWriterFixture("tombstone-happy", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      try {
        mockProviderSuccess(fixture);

        await expect(refreshTombstoned(fixture, 0)).resolves.toEqual({
          status: GitHubServerSyncStatus.Refreshed,
          reason: GitHubSyncResultReason.Success,
        });
        const first = await readWriterState(fixture);
        await expect(refreshTombstoned(fixture, 31_000)).resolves.toEqual({
          status: GitHubServerSyncStatus.Refreshed,
          reason: GitHubSyncResultReason.Success,
        });
        const replay = await readWriterState(fixture);

        expect(first.atoms).toEqual([
          expect.objectContaining({
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.PullRequestLifecycle,
            sourceEventId: `${first.pullRequest.id}:merged`,
            occurredAt: new Date(mergedAt),
            attributionKind: BranchActivityAttributionKind.PullRequest,
            pullRequestDetailId: first.pullRequest.id,
            completeness: BranchActivityEvidenceCompleteness.Complete,
          }),
          expect.objectContaining({
            version: BranchActivityAtomVersion.V1,
            source: BranchActivitySource.PullRequestLifecycle,
            sourceEventId: `${first.pullRequest.id}:opened`,
            occurredAt: new Date(openedAt),
            attributionKind: BranchActivityAttributionKind.PullRequest,
            pullRequestDetailId: first.pullRequest.id,
            completeness: BranchActivityEvidenceCompleteness.Complete,
          }),
        ]);
        expect(first.branch.lastActivityAt).toEqual(new Date(mergedAt));
        expect(replay.atoms).toEqual(first.atoms);
        expect(replay.branch.lastActivityAt).toEqual(
          first.branch.lastActivityAt
        );
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("retains both close occurrences through the actual tombstoned writer", async () => {
      const fixture = await seedWriterFixture("tombstone-reopened", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      try {
        mockProviderSuccess(fixture, closedProviderPullRequest(firstClosedAt));
        await expect(refreshTombstoned(fixture, 0)).resolves.toMatchObject({
          status: GitHubServerSyncStatus.Refreshed,
        });
        mockProviderSuccess(fixture, reopenedProviderPullRequest());
        await expect(refreshTombstoned(fixture, 31_000)).resolves.toMatchObject(
          {
            status: GitHubServerSyncStatus.Refreshed,
          }
        );
        mockProviderSuccess(fixture, closedProviderPullRequest(secondClosedAt));
        await expect(refreshTombstoned(fixture, 62_000)).resolves.toMatchObject(
          {
            status: GitHubServerSyncStatus.Refreshed,
          }
        );

        const state = await readWriterState(fixture);
        expect(closeOccurrences(state)).toEqual(
          closeOccurrenceExpectations(state, [firstClosedAt, secondClosedAt])
        );
        expect(state.branch.lastActivityAt).toEqual(new Date(secondClosedAt));
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rejects an older provider response after a newer refresh settles", async () => {
      const fixture = await seedWriterFixture("tombstone-refresh-order", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const olderProvider = deferredProviderResult();
      try {
        vi.mocked(getSinglePullRequestWithProviderResult)
          .mockImplementationOnce(() => olderProvider.promise)
          .mockResolvedValueOnce(
            providerSuccess(fixture, {
              title: "Newest provider title",
              headSha: "newest-provider-head",
            })
          );
        const olderRefresh = refreshTombstoned(fixture, 0);
        await vi.waitFor(() =>
          expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledTimes(
            1
          )
        );

        await expect(refreshTombstoned(fixture, 31_000)).resolves.toMatchObject(
          {
            status: GitHubServerSyncStatus.Refreshed,
          }
        );
        olderProvider.resolve(
          providerSuccess(fixture, {
            title: "Older provider title",
            headSha: "older-provider-head",
          })
        );
        await expect(olderRefresh).resolves.toEqual({
          status: GitHubServerSyncStatus.Failed,
          reason: GitHubServerSyncReason.GuardedWriteFailed,
        });

        const state = await readWriterState(fixture);
        expect(state.pullRequest.title).toBe("Newest provider title");
        expect(state.pullRequest.lastVerifiedAt).toEqual(
          new Date("2026-08-12T01:00:31.000Z")
        );
        expect(state.branch.headSha).toBe("newest-provider-head");
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rolls back every tombstoned settlement write on atom conflict", async () => {
      const fixture = await seedWriterFixture("tombstone-conflict", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      try {
        await seedConflictingOpenedAtom(fixture);
        mockProviderSuccess(fixture);
        const before = await readWriterState(fixture);

        await expect(refreshTombstoned(fixture, 0)).resolves.toEqual({
          status: GitHubServerSyncStatus.Failed,
          reason: GitHubServerSyncReason.GuardedWriteFailed,
        });

        expect(await readWriterState(fixture)).toEqual(before);
      } finally {
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rolls back tombstoned settlement when an incompatible atom wins after the pre-read", async () => {
      const fixture = await seedWriterFixture("tombstone-concurrent-conflict", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const lock = await installPullRequestLifecycleAtomInsertBarrier(
        fixture.branchArtifactId
      );
      try {
        mockProviderSuccess(fixture);
        const refresh = refreshTombstoned(fixture, 0);
        await lock.waitUntilBlocked();
        await lock.insertConflictingOpenedAtom(fixture, conflictingOpenedAt);
        const afterCompetingMutation = await readWriterState(fixture);
        await lock.release();

        await expect(refresh).resolves.toEqual({
          status: GitHubServerSyncStatus.Failed,
          reason: GitHubServerSyncReason.GuardedWriteFailed,
        });
        expect(await readWriterState(fixture)).toEqual(afterCompetingMutation);
      } finally {
        await lock.dispose();
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rolls back tombstoned settlement when the current PR switches concurrently", async () => {
      const fixture = await seedWriterFixture("tombstone-pr-switch", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const replacementPullRequestId =
        await seedReplacementPullRequest(fixture);
      const lock = await installPullRequestLifecycleAtomInsertBarrier(
        fixture.branchArtifactId
      );
      try {
        mockProviderSuccess(fixture);
        const refresh = refreshTombstoned(fixture, 0);
        await lock.waitUntilBlocked();
        await withDb((db) =>
          db.branchDetail.update({
            where: { artifactId: fixture.branchArtifactId },
            data: { currentPullRequestDetailId: replacementPullRequestId },
          })
        );
        const afterCompetingMutation = await readWriterState(fixture);
        await lock.release();

        await expect(refresh).resolves.toEqual({
          status: GitHubServerSyncStatus.Failed,
          reason: GitHubServerSyncReason.GuardedWriteFailed,
        });
        expect(await readWriterState(fixture)).toEqual(afterCompetingMutation);
      } finally {
        await lock.dispose();
        await deleteFixture(fixture.organizationId);
      }
    });

    it("rolls back preceding settlement writes when the final Branch guard is lost", async () => {
      const fixture = await seedWriterFixture("tombstone-lost-guard", {
        createPullRequest: true,
        tombstoned: true,
        withSyncAuthority: true,
      });
      const lock = await installPullRequestLifecycleAtomInsertBarrier(
        fixture.branchArtifactId
      );
      try {
        mockProviderSuccess(fixture);
        const refresh = refreshTombstoned(fixture, 0);
        await lock.waitUntilBlocked();
        await withDb((db) =>
          db.gitHubInstallationRepository.update({
            where: { id: fixture.repositoryId },
            data: { removedAt: null },
          })
        );
        const afterCompetingMutation = await readWriterState(fixture);
        await lock.release();

        await expect(refresh).resolves.toEqual({
          status: GitHubServerSyncStatus.Failed,
          reason: GitHubServerSyncReason.GuardedWriteFailed,
        });
        expect(await readWriterState(fixture)).toEqual(afterCompetingMutation);
      } finally {
        await lock.dispose();
        await deleteFixture(fixture.organizationId);
      }
    });
  }
);

function closedPullRequest(
  closedAt: string
): Partial<GitHubReadModelPullRequest> {
  return {
    state: GitHubPRState.Closed,
    closedAt,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: closedAt,
  };
}

function reopenedPullRequest(): Partial<GitHubReadModelPullRequest> {
  return {
    state: GitHubPRState.Open,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

function closedProviderPullRequest(
  closedAt: string
): Partial<GitHubSinglePullRequestResult> {
  return {
    state: GitHubPRState.Closed,
    closedAt,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

function reopenedProviderPullRequest(): Partial<GitHubSinglePullRequestResult> {
  return {
    state: GitHubPRState.Open,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
  };
}

function deferredProviderResult() {
  let resolve!: (value: ReturnType<typeof providerSuccess>) => void;
  const promise = new Promise<ReturnType<typeof providerSuccess>>(
    (resolvePromise) => {
      resolve = resolvePromise;
    }
  );
  return { promise, resolve };
}

async function seedConflictingOpenedAtom(
  fixture: WriterFixture
): Promise<void> {
  if (!fixture.pullRequestId) {
    throw new Error("Conflict fixture requires a pull request");
  }
  await withDb((db) =>
    db.branchActivityAtom.create({
      data: {
        version: BranchActivityAtomVersion.V1,
        organizationId: fixture.organizationId,
        branchArtifactId: fixture.branchArtifactId,
        source: BranchActivitySource.PullRequestLifecycle,
        sourceEventId: `${fixture.pullRequestId}:opened`,
        occurredAt: conflictingOpenedAt,
        attributionKind: BranchActivityAttributionKind.PullRequest,
        pullRequestDetailId: fixture.pullRequestId,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    })
  );
}

function seedReplacementPullRequest(fixture: WriterFixture): Promise<string> {
  return withDb(async (db) => {
    const replacement = await db.pullRequestDetail.create({
      data: {
        organizationId: fixture.organizationId,
        branchArtifactId: fixture.branchArtifactId,
        repositoryId: fixture.repositoryId,
        repositoryFullName: fixture.repositoryFullName,
        githubId: `iss-6421-replacement-${randomUUID()}`,
        number: fixture.pullRequestNumber + 1,
        title: "Replacement PR",
        prState: GitHubPRState.Open,
        isCurrent: false,
      },
      select: { id: true },
    });
    return replacement.id;
  });
}

function readWriterState(fixture: WriterFixture) {
  return withDb(async (db) => {
    const branch = await db.branchDetail.findUniqueOrThrow({
      where: { artifactId: fixture.branchArtifactId },
      select: {
        baseBranch: true,
        baseBranchSource: true,
        headSha: true,
        headShaObservedAt: true,
        lastActivityAt: true,
        currentPullRequestDetailId: true,
        fetchCredentialType: true,
        fetchCredentialOwnerId: true,
        fetchMechanism: true,
        fetchTrigger: true,
        fetchObservedAt: true,
        fetchResultReason: true,
      },
    });
    const pullRequest = await db.pullRequestDetail.findUniqueOrThrow({
      where: {
        repositoryId_number: {
          repositoryId: fixture.repositoryId,
          number: fixture.pullRequestNumber,
        },
      },
      select: {
        id: true,
        title: true,
        prState: true,
        githubCreatedAt: true,
        closedAt: true,
        mergedAt: true,
        mergeCommitSha: true,
        lastVerifiedAt: true,
        headRefName: true,
        headRefOid: true,
        headRepositoryGithubId: true,
        headRepositoryFullName: true,
        headRepositoryDefaultBranchName: true,
        headRepositoryDefaultBranchObservationKey: true,
        headRepositoryDefaultBranchObservedAt: true,
        fetchCredentialType: true,
        fetchCredentialOwnerId: true,
        fetchMechanism: true,
        fetchTrigger: true,
        fetchObservedAt: true,
        fetchResultReason: true,
      },
    });
    const atoms = await db.branchActivityAtom.findMany({
      where: { branchArtifactId: fixture.branchArtifactId },
      orderBy: { sourceEventId: "asc" },
      select: {
        version: true,
        source: true,
        sourceEventId: true,
        occurredAt: true,
        attributionKind: true,
        pullRequestDetailId: true,
        completeness: true,
      },
    });
    return { branch, pullRequest, atoms };
  });
}

function closeOccurrences(state: Awaited<ReturnType<typeof readWriterState>>) {
  return state.atoms.filter(({ sourceEventId }) =>
    sourceEventId.includes(":closed:")
  );
}

function closeOccurrenceExpectations(
  state: Awaited<ReturnType<typeof readWriterState>>,
  occurrenceDates: readonly string[]
) {
  return occurrenceDates.map((occurredAt) => ({
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.PullRequestLifecycle,
    sourceEventId: `${state.pullRequest.id}:closed:${occurredAt}`,
    occurredAt: new Date(occurredAt),
    attributionKind: BranchActivityAttributionKind.PullRequest,
    pullRequestDetailId: state.pullRequest.id,
    completeness: BranchActivityEvidenceCompleteness.Complete,
  }));
}
