/**
 * ISS-11608 against a real Postgres.
 *
 * `advisory_xact_lock_text_keys_in_order` is what lets the PR provider locks go
 * out in one statement without reordering them, so its contract is proven
 * through `pg_locks` rather than timing: a waiter stopped part-way through the
 * array shows exactly which keys it holds, which it waits on, and which it has
 * not reached.
 *
 * The ingest x relink cases drive the production writers in both orders and
 * assert which key the waiter is queued on. On one PR the shared PR provider
 * lock serializes them. On two PRs of one Session no provider key is shared, so
 * the waiter queues on the Session-link key: with the per-edge locks gone, that
 * key alone serializes the two Session-edge writers, and both orders still
 * converge with no deadlock.
 */
import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { sessionPrRefsFromMetadata } from "@repo/api/src/types/session-pr-link-metadata";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  ArtifactType,
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import { persistSessionPrArtifactLinks } from "@/app/agent-sessions/service/artifact-links/pr-links";
import { resolveSessionPrDetailMap } from "@/app/agent-sessions/service/artifact-links/pull-request-details";
import { SessionPrLinkWriteMode } from "@/app/agent-sessions/service/artifact-links/session-pr-link-merge";
import { acquireSessionPullRequestProviderLocks } from "@/app/agent-sessions/service/artifact-links/session-pull-request-provider-locks";
import { relinkPullRequestBranchInTransaction } from "@/app/branches/pull-request-branch-relink";
import { pullRequestProviderLockKey } from "@/app/branches/pull-request-provider-lock";
import { createTestOrganization } from "../utils/db-helpers";

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";
const RELINKED_PULL_REQUEST_NUMBER = 11_608;
const SIBLING_PULL_REQUEST_NUMBER = 11_609;
const NULL_KEY_ERROR = /NULL key/;
const createdOrganizationIds: string[] = [];

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-11608 ordered advisory-lock function",
  () => {
    it("acquires keys sequentially in array order, without re-sorting", async () => {
      const prefix = `iss-11608:order:${randomUUID()}`;
      // Deliberately unsorted: a function that re-sorted would take `second`
      // (the `a` key) first and block holding nothing.
      const [first, second, third] = ["b", "a", "c"].map(
        (suffix) => `${prefix}:${suffix}`
      );
      const held = deferred<void>();
      const release = deferred<void>();
      const holder = withDb.tx(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${second}, 0::bigint))`;
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const waiterPid = deferred<number>();
      const waiter = withDb.tx(async (tx) => {
        waiterPid.resolve(await backendPid(tx));
        await tx.$executeRaw`SELECT advisory_xact_lock_text_keys_in_order(${[first, second, third]}::text[])`;
      });
      try {
        const pid = await waiterPid.promise;
        await waitUntilWaitingOnLock(pid);

        await expect(
          advisoryLockStates(pid, [first, second, third])
        ).resolves.toEqual([
          { key: first, granted: true },
          { key: second, granted: false },
          { key: third, granted: null },
        ]);
      } finally {
        release.resolve();
        await Promise.allSettled([holder, waiter]);
      }
      await expect(Promise.all([holder, waiter])).resolves.toBeDefined();
    }, 20_000);

    it("holds the same lock slot as the single-key form", async () => {
      const key = `iss-11608:slot:${randomUUID()}`;
      const held = deferred<void>();
      const release = deferred<void>();
      const holder = withDb.tx(async (tx) => {
        await tx.$executeRaw`SELECT advisory_xact_lock_text_keys_in_order(${[key]}::text[])`;
        held.resolve();
        await release.promise;
      });
      try {
        await held.promise;
        await expect(trySingleKeyLock(key)).resolves.toBe(false);
      } finally {
        release.resolve();
        await holder;
      }
      await expect(trySingleKeyLock(key)).resolves.toBe(true);
    }, 20_000);

    it("refuses a NULL key instead of silently locking nothing", async () => {
      const key = `iss-11608:null:${randomUUID()}`;
      await expect(
        withDb.tx(async (tx) => {
          await tx.$executeRaw`SELECT advisory_xact_lock_text_keys_in_order(ARRAY[${key}, NULL]::text[])`;
        })
      ).rejects.toThrow(NULL_KEY_ERROR);
    }, 20_000);
  }
);

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-11608 ingest x GitHub relink on one Session",
  () => {
    afterEach(async () => {
      for (const organizationId of createdOrganizationIds.splice(0)) {
        await withDb(async (db) => {
          await db.artifact.deleteMany({ where: { organizationId } });
          await db.gitHubInstallation.deleteMany({ where: { organizationId } });
          await db.organization.delete({ where: { id: organizationId } });
        });
      }
    });

    it("on one PR, queues the relink on the PR provider lock behind the ingest and converges", async () => {
      const fixture = await seedRelinkFixture();
      const waiterLock = await runInterleaved(
        (tx) => fixture.ingestBothPrs(tx),
        (tx) => fixture.relink(tx),
        fixture.relinkedPrLockKey
      );
      expect(waiterLock).toEqual([
        { key: fixture.relinkedPrLockKey, granted: false },
      ]);
      await expect(fixture.links()).resolves.toEqual(fixture.expectedLinks);
    }, 20_000);

    it("on one PR, queues the ingest on the PR provider lock behind the relink and converges", async () => {
      const fixture = await seedRelinkFixture();
      const waiterLock = await runInterleaved(
        (tx) => fixture.relink(tx),
        (tx) => fixture.ingestBothPrs(tx),
        fixture.relinkedPrLockKey
      );
      expect(waiterLock).toEqual([
        { key: fixture.relinkedPrLockKey, granted: false },
      ]);
      await expect(fixture.links()).resolves.toEqual(fixture.expectedLinks);
    }, 20_000);

    it("on two PRs, queues the relink on the Session-link lock behind the ingest and converges", async () => {
      const fixture = await seedRelinkFixture();
      const waiterLock = await runInterleaved(
        (tx) => fixture.ingestSiblingPr(tx),
        (tx) => fixture.relink(tx),
        fixture.sessionLinkLockKey
      );
      expect(waiterLock).toEqual([
        { key: fixture.sessionLinkLockKey, granted: false },
      ]);
      await expect(fixture.links()).resolves.toEqual(fixture.expectedLinks);
    }, 20_000);

    it("on two PRs, queues the ingest on the Session-link lock behind the relink and converges", async () => {
      const fixture = await seedRelinkFixture();
      const waiterLock = await runInterleaved(
        (tx) => fixture.relink(tx),
        (tx) => fixture.ingestSiblingPr(tx),
        fixture.sessionLinkLockKey
      );
      expect(waiterLock).toEqual([
        { key: fixture.sessionLinkLockKey, granted: false },
      ]);
      await expect(fixture.links()).resolves.toEqual(fixture.expectedLinks);
    }, 20_000);
  }
);

/**
 * Run `holderWork` to completion inside a transaction that stays open, start
 * `waiterWork` in a second transaction, and release the first only once the
 * second is observed queued on a lock. Returns the waiter's state on
 * `waiterLockKey` at that moment. Both must commit: a `40P01` rejects one of
 * them.
 */
async function runInterleaved(
  holderWork: (tx: TransactionClient) => Promise<unknown>,
  waiterWork: (tx: TransactionClient) => Promise<unknown>,
  waiterLockKey: string
): Promise<{ key: string; granted: boolean | null }[]> {
  const held = deferred<void>();
  const release = deferred<void>();
  const holder = withDb.tx(async (tx) => {
    await holderWork(tx);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const waiterPid = deferred<number>();
  const waiter = withDb.tx(async (tx) => {
    waiterPid.resolve(await backendPid(tx));
    await waiterWork(tx);
  });
  let waiterLock: { key: string; granted: boolean | null }[];
  try {
    const pid = await waiterPid.promise;
    await waitUntilWaitingOnLock(pid);
    waiterLock = await advisoryLockStates(pid, [waiterLockKey]);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, waiter]);
  }
  await Promise.all([holder, waiter]);
  return waiterLock;
}

async function seedRelinkFixture() {
  const organizationId = await createTestOrganization();
  createdOrganizationIds.push(organizationId);
  const repository = await seedRepository(organizationId);
  const sourceBranchArtifactId = await seedBranch(
    organizationId,
    repository.id,
    "source"
  );
  const targetBranchArtifactId = await seedBranch(
    organizationId,
    repository.id,
    "target"
  );
  const sessionArtifactId = (
    await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: "ISS-11608 ingest x relink",
          status: SESSION_STATUS.INACTIVE,
        },
        select: { id: true },
      })
    )
  ).id;
  const relinkedPullRequestId = await seedPullRequest(
    organizationId,
    repository.id,
    sourceBranchArtifactId,
    RELINKED_PULL_REQUEST_NUMBER
  );
  await seedPullRequest(
    organizationId,
    repository.id,
    sourceBranchArtifactId,
    SIBLING_PULL_REQUEST_NUMBER
  );
  const prRef = (prNumber: number) => ({
    repositoryFullName: REPOSITORY_FULL_NAME,
    prNumber,
    relationType: SessionPrRelationType.Created,
    branchLifecycleEvents: [],
  });
  const relinkedPrRef = prRef(RELINKED_PULL_REQUEST_NUMBER);
  const siblingPrRef = prRef(SIBLING_PULL_REQUEST_NUMBER);
  const ingest = async (
    tx: TransactionClient,
    prRefs: ReturnType<typeof prRef>[],
    mode: SessionPrLinkWriteMode
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
    await persistSessionPrArtifactLinks(
      tx,
      organizationId,
      sessionArtifactId,
      prRefs,
      details,
      mode
    );
  };
  // Both PRs' locks, the relinked one included.
  const ingestBothPrs = (tx: TransactionClient) =>
    ingest(tx, [relinkedPrRef, siblingPrRef], SessionPrLinkWriteMode.Replace);
  // A continuation slice naming only the sibling PR: it shares no provider key
  // with the relink, and Merge does not retract the relinked PR's contribution.
  const ingestSiblingPr = (tx: TransactionClient) =>
    ingest(tx, [siblingPrRef], SessionPrLinkWriteMode.Merge);
  const relink = (tx: TransactionClient) =>
    relinkPullRequestBranchInTransaction(tx, {
      organizationId,
      pullRequestDetailId: relinkedPullRequestId,
      branchArtifactId: targetBranchArtifactId,
      repositoryFullName: REPOSITORY_FULL_NAME,
      pullRequestNumber: RELINKED_PULL_REQUEST_NUMBER,
    });
  // An existing Session->source edge carrying both PRs, so the relink has a
  // contribution to move whichever side commits first.
  await withDb.tx(ingestBothPrs);
  return {
    ingestBothPrs,
    ingestSiblingPr,
    relink,
    relinkedPrLockKey: pullRequestProviderLockKey({
      organizationId,
      repositoryFullName: REPOSITORY_FULL_NAME,
      number: RELINKED_PULL_REQUEST_NUMBER,
    }),
    // Written out rather than derived: it must stay the string pods on the old
    // per-edge code still take.
    sessionLinkLockKey: `iss-6980:session-artifact-links:${organizationId}:${sessionArtifactId}`,
    links: async () => {
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
      return new Map(
        links.map((link) => [
          link.targetId,
          sessionPrRefsFromMetadata(link.metadata)
            .map((ref) => ref.prNumber)
            .sort(),
        ])
      );
    },
    expectedLinks: new Map([
      [sourceBranchArtifactId, [SIBLING_PULL_REQUEST_NUMBER]],
      [targetBranchArtifactId, [RELINKED_PULL_REQUEST_NUMBER]],
    ]),
  };
}

async function seedPullRequest(
  organizationId: string,
  repositoryId: string,
  branchArtifactId: string,
  number: number
): Promise<string> {
  const pullRequest = await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        branchArtifactId,
        organizationId,
        repositoryId,
        repositoryFullName: REPOSITORY_FULL_NAME,
        githubId: `iss-11608-${randomUUID()}`,
        number,
        isCurrent: true,
        lastVerifiedAt: new Date("2026-10-01T12:00:00.000Z"),
      },
      select: { id: true },
    })
  );
  return pullRequest.id;
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
        fullName: REPOSITORY_FULL_NAME,
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

async function seedBranch(
  organizationId: string,
  repositoryId: string,
  label: string
): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `ISS-11608 ${label}`,
        status: GitHubPRState.Open,
        branch: {
          create: {
            organizationId,
            repositoryId,
            repositoryFullName: REPOSITORY_FULL_NAME,
            branchName: `feature/${label}-${randomUUID()}`,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function backendPid(tx: TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  if (!row) {
    throw new Error("pg_backend_pid returned no row");
  }
  return row.pid;
}

/** Whether `pid` holds, waits on, or has not requested each key's lock. */
function advisoryLockStates(
  pid: number,
  lockKeys: string[]
): Promise<{ key: string; granted: boolean | null }[]> {
  return withDb(
    (db) => db.$queryRaw<{ key: string; granted: boolean | null }[]>`
      SELECT requested.key, held.granted
      FROM unnest(${lockKeys}::text[]) WITH ORDINALITY AS requested(key, position)
      LEFT JOIN pg_locks AS held
        ON held.locktype = 'advisory'
        AND held.pid = ${pid}::int
        AND held.objsubid = 1
        AND ((held.classid::bigint << 32) | held.objid::bigint)
          = hashtextextended(requested.key, 0)
      ORDER BY requested.position
    `
  );
}

async function waitUntilWaitingOnLock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await withDb(
      (db) => db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE pid = ${pid}::int AND locktype = 'advisory' AND NOT granted
      `
    );
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${pid} never queued on an advisory lock`);
}

function trySingleKeyLock(key: string): Promise<boolean> {
  return withDb.tx(async (tx) => {
    const [row] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0::bigint)) AS acquired
    `;
    return row?.acquired ?? false;
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
