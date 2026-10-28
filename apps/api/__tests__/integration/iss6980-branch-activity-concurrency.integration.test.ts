import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  ArtifactType,
  GitHubCommentThreadKind,
  GitHubInstallationStatus,
  ThreadSource,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryIdentitySource } from "@/app/agent-sessions/service/artifact-links/authority-source-queries";
import { persistSessionPrArtifactLinks } from "@/app/agent-sessions/service/artifact-links/pr-links";
import {
  persistSessionPullRequestDetails,
  resolveSessionPrDetailMap,
} from "@/app/agent-sessions/service/artifact-links/pull-request-details";
import { acquireSessionPullRequestProviderLocks } from "@/app/agent-sessions/service/artifact-links/session-pull-request-provider-locks";
import {
  BranchActivityPersistStatus,
  persistBranchActivityAtomInTransaction,
} from "@/app/branches/branch-activity-evidence";
import { persistBranchActivityAtomsInTransaction } from "@/app/branches/branch-activity-evidence-batch";
import { relinkPullRequestBranchInTransaction } from "@/app/branches/pull-request-branch-relink";
import { reconcilePullRequestProviderIdentityInTransaction } from "@/app/branches/pull-request-provider-identity";
import { pullRequestProviderLockKey } from "@/app/branches/pull-request-provider-lock";
import { createTestOrganization, createTestUser } from "../utils/db-helpers";

const hasDatabase = Boolean(keys().DATABASE_URL);
const createdOrganizationIds: string[] = [];

describe.skipIf(!hasDatabase)("ISS-6980 real Postgres barriers", () => {
  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.splice(0)) {
      await withDb(async (db) => {
        await db.artifact.deleteMany({ where: { organizationId } });
        await db.gitHubInstallation.deleteMany({ where: { organizationId } });
        await db.user.deleteMany({ where: { organizationId } });
        await db.organization.delete({ where: { id: organizationId } });
      });
    }
  });

  it("serializes the production Session-edge writer against relink", async () => {
    const organizationId = await trackedOrganization();
    const repository = await seedRepository(organizationId);
    const sourceBranchArtifactId = await seedBranch(organizationId, {
      branchName: `feature/source-${randomUUID()}`,
      repositoryId: repository.id,
    });
    const targetBranchArtifactId = await seedBranch(organizationId, {
      branchName: `feature/target-${randomUUID()}`,
      repositoryId: repository.id,
    });
    const sessionArtifactId = (
      await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.SESSION,
            name: "ISS-6980 edge race",
            status: "inactive",
          },
          select: { id: true },
        })
      )
    ).id;
    const pullRequest = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          branchArtifactId: sourceBranchArtifactId,
          organizationId,
          repositoryId: repository.id,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          githubId: "github-pr-edge-race",
          number: 6982,
          isCurrent: true,
          lastVerifiedAt: new Date("2026-08-17T20:00:00.000Z"),
        },
        select: { id: true },
      })
    );
    const prRefs = [
      {
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 6982,
        relationType: SessionPrRelationType.Created,
        branchLifecycleEvents: [],
      },
    ];
    const persistEdges = async (
      tx: Parameters<typeof persistSessionPrArtifactLinks>[0]
    ) => {
      await acquireSessionPullRequestProviderLocks(tx, {
        organizationId,
        prRefs,
      });
      const details = await resolveSessionPrDetailMap(
        tx,
        organizationId,
        prRefs,
        new Map()
      );
      return persistSessionPrArtifactLinks(
        tx,
        organizationId,
        sessionArtifactId,
        prRefs,
        details
      );
    };
    await withDb.tx(persistEdges);
    const start = deferred<void>();
    const ordinaryWriter = withDb.tx(async (tx) => {
      await start.promise;
      return persistEdges(tx);
    });
    const relink = withDb.tx(async (tx) => {
      await start.promise;
      return relinkPullRequestBranchInTransaction(tx, {
        organizationId,
        pullRequestDetailId: pullRequest.id,
        branchArtifactId: targetBranchArtifactId,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 6982,
      });
    });
    start.resolve();
    await Promise.all([ordinaryWriter, relink]);

    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          sourceId: sessionArtifactId,
          linkType: LinkType.RelatesTo,
        },
        select: { targetId: true, metadata: true },
      })
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      targetId: targetBranchArtifactId,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 6982,
      },
    });
  }, 20_000);

  it("converges concurrent exact replay and preserves monotonic scalar evidence", async () => {
    const organizationId = await trackedOrganization();
    const branchArtifactId = await seedBranch(organizationId);
    const receivedAt = new Date("2026-08-17T12:00:00.000Z");
    const start = deferred<void>();
    const bothReady = deferred<void>();
    let readyCount = 0;
    const persist = () =>
      withDb.tx(async (tx) => {
        readyCount += 1;
        if (readyCount === 2) {
          bothReady.resolve();
        }
        await start.promise;
        return persistBranchActivityAtomsInTransaction(tx, {
          organizationId,
          receivedAt,
          records: [
            {
              branchArtifactId,
              atom: branchAtom("exact-replay", "2026-08-16T10:00:00.000Z"),
            },
          ],
        });
      });
    const first = persist();
    const second = persist();
    await bothReady.promise;
    start.resolve();

    const statuses = (await Promise.all([first, second]))
      .flat()
      .map((result) => result.status)
      .sort();
    expect(statuses).toEqual(
      [
        BranchActivityPersistStatus.Inserted,
        BranchActivityPersistStatus.Replayed,
      ].sort()
    );
    await withDb((db) =>
      db.branchDetail.update({
        where: { artifactId: branchArtifactId },
        data: { lastActivityAt: new Date("2026-08-18T10:00:00.000Z") },
        select: { artifactId: true },
      })
    );
    await withDb.tx((tx) =>
      persistBranchActivityAtomsInTransaction(tx, {
        organizationId,
        receivedAt,
        records: [
          {
            branchArtifactId,
            atom: branchAtom("delayed", "2026-08-15T10:00:00.000Z"),
          },
        ],
      })
    );
    await expect(lastActivityAt(branchArtifactId)).resolves.toEqual(
      new Date("2026-08-18T10:00:00.000Z")
    );

    const poisonedAt = new Date("2026-09-20T10:00:00.000Z");
    await withDb(async (db) => {
      await db.branchActivityAtom.create({
        data: {
          version: BranchActivityAtomVersion.V1,
          organizationId,
          branchArtifactId,
          source: BranchActivitySource.GitHead,
          sourceEventId: "future-poison",
          occurredAt: poisonedAt,
          attributionKind: BranchActivityAttributionKind.Branch,
          completeness: BranchActivityEvidenceCompleteness.Complete,
          createdAt: receivedAt,
        },
        select: { id: true },
      });
      await db.branchDetail.update({
        where: { artifactId: branchArtifactId },
        data: { lastActivityAt: poisonedAt },
        select: { artifactId: true },
      });
    });
    await withDb.tx((tx) =>
      persistBranchActivityAtomsInTransaction(tx, {
        organizationId,
        receivedAt,
        records: [
          {
            branchArtifactId,
            atom: branchAtom("repair", "2026-08-17T10:00:00.000Z"),
          },
        ],
      })
    );
    await expect(lastActivityAt(branchArtifactId)).resolves.toEqual(
      new Date("2026-08-17T10:00:00.000Z")
    );
  }, 20_000);

  it("keeps a newer scalar when persistence waits behind the Branch row lock", async () => {
    const organizationId = await trackedOrganization();
    const branchArtifactId = await seedBranch(organizationId);
    const locked = deferred<void>();
    const release = deferred<void>();
    const newerScalar = new Date("2026-08-18T10:00:00.000Z");
    const blocker = withDb.tx(async (tx) => {
      await tx.$queryRaw`
        SELECT artifact_id
        FROM branch_detail
        WHERE organization_id = ${organizationId}::uuid
          AND artifact_id = ${branchArtifactId}::uuid
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
      await tx.branchDetail.update({
        where: { artifactId: branchArtifactId },
        data: { lastActivityAt: newerScalar },
        select: { artifactId: true },
      });
    });
    await locked.promise;
    const writer = withDb.tx((tx) =>
      persistBranchActivityAtomsInTransaction(tx, {
        organizationId,
        receivedAt: new Date("2026-08-17T12:00:00.000Z"),
        records: [
          {
            branchArtifactId,
            atom: branchAtom("blocked-older", "2026-08-17T09:00:00.000Z"),
          },
        ],
      })
    );
    release.resolve();
    await Promise.all([blocker, writer]);

    await expect(lastActivityAt(branchArtifactId)).resolves.toEqual(
      newerScalar
    );
  }, 20_000);

  it("does not deadlock distinct-atom writers queued behind the Branch row lock (ISS-10331)", async () => {
    const organizationId = await trackedOrganization();
    const branchArtifactId = await seedBranch(organizationId);
    // Resolves with the holder's backend pid, which scopes the barrier below.
    const locked = deferred<number>();
    const release = deferred<void>();
    // Models a concurrent check_run delivery: its `branch_detail` updateMany
    // holds FOR NO KEY UPDATE, which admits the atom insert's FK KEY SHARE.
    const holder = withDb.tx(async (tx) => {
      const [session] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `;
      await tx.$queryRaw`
        SELECT artifact_id
        FROM branch_detail
        WHERE organization_id = ${organizationId}::uuid
          AND artifact_id = ${branchArtifactId}::uuid
        FOR NO KEY UPDATE
      `;
      locked.resolve(session.pid);
      await release.promise;
    });
    const holderPid = await locked.promise;
    const write = (sourceEventId: string, occurredAt: string) =>
      withDb.tx((tx) =>
        persistBranchActivityAtomInTransaction(tx, {
          organizationId,
          branchArtifactId,
          atom: branchAtom(sourceEventId, occurredAt),
          receivedAt: new Date("2026-08-17T12:00:00.000Z"),
        })
      );
    const writers = Promise.allSettled([
      write("iss-10331-first", "2026-08-17T09:00:00.000Z"),
      write("iss-10331-second", "2026-08-17T10:00:00.000Z"),
    ]);
    try {
      await waitForAggregateRecomputeLockWaiters(holderPid, 2);
    } finally {
      // Released even if the barrier throws: an open holder would otherwise
      // keep the Branch row locked until its transaction times out, masking
      // the real failure behind cleanup noise.
      release.resolve();
      await Promise.allSettled([holder]);
    }

    const results = await writers;
    expect(results).toEqual([
      {
        status: "fulfilled",
        value: { status: BranchActivityPersistStatus.Inserted },
      },
      {
        status: "fulfilled",
        value: { status: BranchActivityPersistStatus.Inserted },
      },
    ]);
    await expect(lastActivityAt(branchArtifactId)).resolves.toEqual(
      new Date("2026-08-17T10:00:00.000Z")
    );
  }, 20_000);

  it("serializes Desktop and App provider writers through one production lock", async () => {
    const organizationId = await trackedOrganization();
    const repository = await seedRepository(organizationId);
    const branchName = `feature/provider-race-${randomUUID()}`;
    const branchArtifactId = await seedBranch(organizationId, {
      branchName,
      repositoryId: repository.id,
    });
    const legacy = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          branchArtifactId,
          organizationId,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          number: 6981,
        },
        select: { id: true },
      })
    );
    const locked = deferred<void>();
    const release = deferred<void>();
    const blocker = withDb.tx(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM pull_request_detail
        WHERE id = ${legacy.id}::uuid
          AND organization_id = ${organizationId}::uuid
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const authority = new Map([
      [
        "closedloop-ai/closedloop-ai",
        {
          repositoryId: repository.id,
          providerRepositoryId: "provider-repository-6981",
          identitySources: new Set([RepositoryIdentitySource.Installation]),
          authorities: [
            {
              repository: {
                provider: VcsProviderKind.GitHub,
                providerRepositoryId: "provider-repository-6981",
                fullName: "closedloop-ai/closedloop-ai",
              },
              evidence: {
                availability: RepositoryDefaultAvailability.Available,
                completeness: RepositoryDefaultCompleteness.Complete,
                defaultBranch: "main",
              },
              provenance: {
                source: RepositoryDefaultSource.RepositoryRest,
                mechanism: GitHubFetchMechanism.Rest,
                trigger: GitHubFetchTrigger.UserAction,
                credentialType: GitHubFetchCredentialType.UserOAuth,
                observationKey: "iss6980-provider-race",
                observedAt: "2026-08-17T20:00:00.000Z",
              },
            },
          ],
        },
      ],
    ]);
    const desktop = withDb.tx((tx) =>
      persistSessionPullRequestDetails(
        tx,
        organizationId,
        null,
        randomUUID(),
        [
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 6981,
            branchName,
            method: ArtifactRefMethod.McpToolCall,
            relation: ArtifactRefRelation.Reviewed,
            observedAt: "2026-08-17T20:00:00.000Z",
            state: GitHubPRState.Open,
          },
        ],
        authority,
        { shouldUpdatePullRequestLinks: true }
      ).then((lane) => lane.details)
    );
    await waitForProviderLock({
      organizationId,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      number: 6981,
    });
    const app = withDb.tx((tx) =>
      reconcilePullRequestProviderIdentityInTransaction(tx, {
        organizationId,
        repositoryId: repository.id,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        githubId: "github-pr-6981",
        number: 6981,
      })
    );
    release.resolve();
    await Promise.all([blocker, desktop, app]);

    const rows = await withDb((db) =>
      db.pullRequestDetail.findMany({
        where: { organizationId, number: 6981 },
        select: { id: true, repositoryId: true, githubId: true },
      })
    );
    expect(rows).toEqual([
      {
        id: legacy.id,
        repositoryId: repository.id,
        githubId: "github-pr-6981",
      },
    ]);
  }, 20_000);

  it("converges provider identity without losing old-Branch comments", async () => {
    const organizationId = await trackedOrganization();
    const user = await createTestUser(organizationId);
    const repository = await seedRepository(organizationId);
    const sourceBranchArtifactId = await seedBranch(organizationId);
    const targetBranchArtifactId = await seedBranch(organizationId);
    const legacyPullRequest = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          branchArtifactId: sourceBranchArtifactId,
          organizationId,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          number: 6980,
        },
        select: { id: true },
      })
    );
    const providerPullRequest = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          branchArtifactId: targetBranchArtifactId,
          organizationId,
          repositoryId: repository.id,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          githubId: "github-pr-6980",
          number: 6980,
        },
        select: { id: true },
      })
    );
    const sessionArtifactId = (
      await withDb((db) =>
        db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.SESSION,
            name: "ISS-6980 duplicate edge",
            status: "inactive",
          },
          select: { id: true },
        })
      )
    ).id;
    await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId,
          sourceId: sessionArtifactId,
          targetId: sourceBranchArtifactId,
          linkType: LinkType.RelatesTo,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            linkKinds: [SessionArtifactLinkKind.SessionPr],
            relationTypes: [SessionPrRelationType.Reviewed],
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 6980,
          },
        },
        select: { id: true },
      })
    );
    const thread = await withDb((db) =>
      db.commentThread.create({
        data: {
          organizationId,
          source: ThreadSource.GITHUB,
          artifactId: sourceBranchArtifactId,
          comments: {
            create: {
              authorId: user.id,
              body: { type: "text", value: "ISS-6980 preserved comment" },
              bodyFormat: CommentBodyFormat.Markdown,
              plainText: "ISS-6980 preserved comment",
            },
          },
        },
        include: { comments: { select: { id: true } } },
      })
    );
    const comment = thread.comments[0];
    if (!comment) {
      throw new Error("ISS-6980 comment fixture was not created");
    }
    await withDb(async (db) => {
      await db.gitHubCommentThreadProjection.create({
        data: {
          threadId: thread.id,
          branchArtifactId: sourceBranchArtifactId,
          pullRequestDetailId: legacyPullRequest.id,
          threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
          rootCommentId: "root-6980",
          reviewThreadId: "review-thread-6980",
        },
        select: { threadId: true },
      });
      await db.gitHubCommentProjection.create({
        data: {
          commentId: comment.id,
          threadId: thread.id,
          githubCommentId: "comment-6980",
        },
        select: { commentId: true },
      });
    });

    await expect(
      withDb.tx((tx) =>
        reconcilePullRequestProviderIdentityInTransaction(tx, {
          organizationId,
          repositoryId: repository.id,
          repositoryFullName: "ClosedLoop-AI/ClosedLoop-AI.git",
          githubId: "github-pr-6980",
          number: 6980,
        })
      )
    ).resolves.toBe(providerPullRequest.id);

    const [pullRequests, persistedProjection, persistedSessionLinks] =
      await withDb((db) =>
        Promise.all([
          db.pullRequestDetail.findMany({
            where: { organizationId, number: 6980 },
            select: { id: true },
          }),
          db.gitHubCommentThreadProjection.findUnique({
            where: { threadId: thread.id },
            include: {
              commentProjections: true,
              thread: { include: { comments: true } },
            },
          }),
          db.artifactLink.findMany({
            where: {
              organizationId,
              sourceId: sessionArtifactId,
              linkType: LinkType.RelatesTo,
            },
            select: { targetId: true, metadata: true },
          }),
        ])
      );
    expect(pullRequests).toEqual([{ id: providerPullRequest.id }]);
    expect(persistedProjection).toMatchObject({
      branchArtifactId: targetBranchArtifactId,
      pullRequestDetailId: providerPullRequest.id,
      threadId: thread.id,
      thread: {
        artifactId: targetBranchArtifactId,
        comments: [
          expect.objectContaining({
            id: comment.id,
            plainText: "ISS-6980 preserved comment",
          }),
        ],
      },
      commentProjections: [
        expect.objectContaining({
          commentId: comment.id,
          githubCommentId: "comment-6980",
        }),
      ],
    });
    expect(persistedSessionLinks).toEqual([
      expect.objectContaining({ targetId: targetBranchArtifactId }),
    ]);
  }, 20_000);
});

function branchAtom(sourceEventId: string, occurredAt: string) {
  return {
    version: BranchActivityAtomVersion.V1,
    source: BranchActivitySource.GitHead,
    sourceEventId,
    occurredAt,
    attribution: { kind: BranchActivityAttributionKind.Branch },
    completeness: BranchActivityEvidenceCompleteness.Complete,
  } as const;
}

async function trackedOrganization(): Promise<string> {
  const organizationId = await createTestOrganization();
  createdOrganizationIds.push(organizationId);
  return organizationId;
}

async function seedBranch(
  organizationId: string,
  options: { branchName?: string; repositoryId?: string } = {}
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: "ISS-6980 concurrency",
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            repositoryId: options.repositoryId,
            repositoryFullName: "closedloop-ai/closedloop-ai",
            branchName: options.branchName ?? `iss-6980-${randomUUID()}`,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function seedRepository(organizationId: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const installation = await withDb((db) =>
    db.gitHubInstallation.create({
      data: {
        accountId: `account-${suffix}`,
        accountLogin: "closedloop-ai",
        accountType: "Organization",
        installationId: `installation-${suffix}`,
        organizationId,
        senderId: `sender-${suffix}`,
        senderLogin: "sender",
        status: GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    })
  );
  return withDb((db) =>
    db.gitHubInstallationRepository.create({
      data: {
        fullName: "closedloop-ai/closedloop-ai",
        githubRepoId: `repository-${suffix}`,
        installationId: installation.id,
        name: "closedloop-ai",
        owner: "closedloop-ai",
        private: true,
      },
      select: { id: true },
    })
  );
}

function lastActivityAt(branchArtifactId: string): Promise<Date | null> {
  return withDb(
    async (db) =>
      (
        await db.branchDetail.findUniqueOrThrow({
          where: { artifactId: branchArtifactId },
          select: { lastActivityAt: true },
        })
      ).lastActivityAt
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForProviderLock(identity: {
  organizationId: string;
  repositoryFullName: string;
  number: number;
}): Promise<void> {
  const key = pullRequestProviderLockKey(identity);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const acquired = await withDb.tx(async (tx) => {
      const [row] = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${key}, 0::bigint)) AS acquired
      `;
      if (row?.acquired) {
        await tx.$executeRaw`SELECT pg_advisory_unlock(hashtextextended(${key}, 0::bigint))`;
      }
      return row?.acquired ?? false;
    });
    if (!acquired) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("provider writer did not acquire the production lock");
}

// Scoped to sessions this case's own holder is blocking, not to every
// recompute waiting anywhere in the database. `test:integration` passes
// `--no-file-parallelism`, so a sibling suite cannot race this one in CI — but
// a datname-only count is satisfied by ANY recompute waiting on a lock in the
// same database, which is the ordinary case on a shared local dev database.
// Blocking-pid scoping does not depend on that lane flag staying set.
async function waitForAggregateRecomputeLockWaiters(
  holderPid: number,
  expected: number
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await withDb(
      (db) => db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%locked_branches%'
          AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
      `
    );
    if ((row?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("aggregate recompute writers never queued on the Branch row");
}
