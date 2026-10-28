import { randomUUID } from "node:crypto";
import { BranchStatus } from "@repo/api/src/types/branch";
import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_PUSHED_AT,
  HAS_DATABASE,
  readAssignee,
  seedBranch,
  seedCommit,
  seedGitHubConnection,
  seedPullRequestDetail,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  BranchOwnerLoginSeedError,
  seedBranchOwnersForLogin,
} from "./branch-owner-seed";

/**
 * ISS-12463 / PLN-2192 T-1.2: a connected login seeds the org's unassigned
 * branches whose commits or PRs it authored.
 */
describe.skipIf(!HAS_DATABASE)("seedBranchOwnersForLogin (ISS-12463)", () => {
  it("seeds the branches whose commits or PRs the login authored, and no other", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [connector, someone] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      await seedGitHubConnection({
        organizationId,
        userId: connector.id,
        login: "connector",
      });
      await seedGitHubConnection({
        organizationId,
        userId: someone.id,
        login: "someone",
      });
      const committed = await seedBranch(organizationId, "by-commit", {
        firstPushedAt: null,
      });
      await seedCommit({
        organizationId,
        branchId: committed,
        sha: "a".repeat(40),
        authorLogin: "connector",
        committedAt: FIRST_PUSHED_AT,
      });
      const pullRequested = await seedBranch(organizationId, "by-pr", {
        firstPushedAt: null,
      });
      await seedPullRequestDetail(
        organizationId,
        pullRequested,
        "by-pr",
        "connector"
      );
      const unrelated = await seedBranch(organizationId, "by-someone", {
        firstPushedAt: null,
      });
      await seedCommit({
        organizationId,
        branchId: unrelated,
        sha: "b".repeat(40),
        authorLogin: "someone",
        committedAt: FIRST_PUSHED_AT,
      });

      expect(await seedBranchOwnersForLogin(organizationId, "connector")).toBe(
        2
      );
      expect(await readAssignee(committed)).toBe(connector.id);
      expect(await readAssignee(pullRequested)).toBe(connector.id);
      expect(await readAssignee(unrelated)).toBeNull();
    });
  });

  it("seeds every branch past one page in a single call", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const connector = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: connector.id,
        login: "prolific",
      });
      const branchIds = await seedCommittedBranches(
        organizationId,
        "prolific",
        SEED_FOR_LOGIN_PAGE_SIZE + 1
      );

      expect(await seedBranchOwnersForLogin(organizationId, "prolific")).toBe(
        SEED_FOR_LOGIN_PAGE_SIZE + 1
      );
      expect(await unassignedCount(branchIds)).toBe(0);
    });
  });

  it("a failed page rejects with what the pages before it committed", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const connector = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: connector.id,
        login: "interrupted",
      });
      const branchIds = await seedCommittedBranches(
        organizationId,
        "interrupted",
        SEED_FOR_LOGIN_PAGE_SIZE + 1
      );
      const realTx = withDb.tx;
      vi.spyOn(withDb, "tx")
        .mockImplementationOnce(realTx)
        .mockRejectedValueOnce(new Error("page failed"));

      const failure = await seedBranchOwnersForLogin(
        organizationId,
        "interrupted"
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BranchOwnerLoginSeedError);
      expect(failure).toMatchObject({
        message: "page failed",
        pagesCommitted: 1,
        stamped: SEED_FOR_LOGIN_PAGE_SIZE,
      });
      expect(await unassignedCount(branchIds)).toBe(1);
    });
  });
});

/**
 * Two real transactions, so the fixture must be committed. A seed that waited on
 * the held row would block until the holder released, which happens only after
 * the seed returns: the seed's own transaction timeout then fails the case
 * instead of hanging it.
 */
describe.skipIf(!HAS_DATABASE)(
  "seedBranchOwnersForLogin row locks (ISS-12463)",
  () => {
    const organizations = createCommittedTestOrganizationTracker();

    afterEach(async () => {
      await organizations.cleanup();
    });

    it("skips a branch row another transaction holds, and seeds it once released", async () => {
      const organizationId = await organizations.create();
      const connector = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: connector.id,
        login: "held",
      });
      const branchId = await seedBranch(organizationId, "held", {
        firstPushedAt: null,
      });
      await seedPullRequestDetail(organizationId, branchId, "held", "held");

      const holder = await holdArtifactRows([branchId]);
      try {
        expect(await seedBranchOwnersForLogin(organizationId, "held")).toBe(0);
      } finally {
        await holder.release();
      }
      expect(await readAssignee(branchId)).toBeNull();

      expect(await seedBranchOwnersForLogin(organizationId, "held")).toBe(1);
      expect(await readAssignee(branchId)).toBe(connector.id);
    });

    it("pages past a full page of held branch rows to seed the next one", async () => {
      const organizationId = await organizations.create();
      const connector = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: connector.id,
        login: "crowded",
      });
      const branchIds = (
        await seedCommittedBranches(
          organizationId,
          "crowded",
          SEED_FOR_LOGIN_PAGE_SIZE + 1
        )
      ).sort();
      const free = branchIds.at(-1) ?? "";

      const holder = await holdArtifactRows(
        branchIds.slice(0, SEED_FOR_LOGIN_PAGE_SIZE)
      );
      try {
        expect(await seedBranchOwnersForLogin(organizationId, "crowded")).toBe(
          1
        );
      } finally {
        await holder.release();
      }
      expect(await readAssignee(free)).toBe(connector.id);
      expect(await unassignedCount(branchIds)).toBe(SEED_FOR_LOGIN_PAGE_SIZE);
    });
  }
);

/**
 * Holds `ids` under `FOR UPDATE` in its own transaction until `release`, which
 * resolves once that transaction has ended.
 */
async function holdArtifactRows(
  ids: readonly string[]
): Promise<{ release: () => Promise<void> }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const holder = withDb.tx(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM artifacts WHERE id = ANY(${[...ids]}::uuid[]) FOR UPDATE`
      );
      signalLocked();
      await released;
    },
    { timeout: LOCK_TEST_TX_TIMEOUT_MS }
  );
  await Promise.race([locked, holder]);
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

/** `count` unassigned branches, each carrying one commit `login` authored. */
async function seedCommittedBranches(
  organizationId: string,
  login: string,
  count: number
): Promise<string[]> {
  const branchIds = Array.from({ length: count }, () => randomUUID());
  await withDb(async (db) => {
    await db.artifact.createMany({
      data: branchIds.map((id, index) => ({
        id,
        organizationId,
        type: ArtifactType.BRANCH,
        name: `capped-${index}`,
        status: BranchStatus.Open,
      })),
    });
    await db.branchDetail.createMany({
      data: branchIds.map((artifactId, index) => ({
        artifactId,
        organizationId,
        repositoryFullName: "acme/capped",
        branchName: `capped-${index}`,
      })),
    });
    await db.commitDetail.createMany({
      data: branchIds.map((branchArtifactId, index) => ({
        organizationId,
        branchArtifactId,
        repositoryFullName: "acme/capped",
        sha: index.toString(16).padStart(40, "0"),
        authorLogin: login,
        committedAt: FIRST_PUSHED_AT,
        source: CommitProvenanceSource.PushWebhook,
      })),
    });
  });
  return branchIds;
}

function unassignedCount(branchIds: readonly string[]): Promise<number> {
  return withDb((db) =>
    db.artifact.count({
      where: { id: { in: [...branchIds] }, assigneeId: null },
    })
  );
}

const SEED_FOR_LOGIN_PAGE_SIZE = 500;
const LOCK_TEST_TX_TIMEOUT_MS = 10_000;
