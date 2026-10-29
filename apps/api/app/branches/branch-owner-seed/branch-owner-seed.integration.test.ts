import { ArtifactType } from "@repo/api/src/types/artifact";
import { Prisma, withDb } from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  GIT_PUSH_METHOD,
  HAS_DATABASE,
  LATER_PUSHED_AT,
  readAssignee,
  seedBranch,
  seedCommit,
  seedEvidenceLink,
  seedGitHubConnection,
  seedPullRequestDetail,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { GITHUB_SHADOW_CLERK_PREFIX } from "@/app/comments/github-shadow-identity";
import { seedBranchOwners } from "./branch-owner-seed";
import { branchOwnerChainLateralSql } from "./branch-owner-seed-sql";

/**
 * ISS-12463 / PLN-2192 T-3.1: the branch assignee is seeded once from the
 * inferred Owner chain, set-if-NULL, to a non-shadow user of the branch's org.
 */
describe.skipIf(!HAS_DATABASE)("seedBranchOwners (ISS-12463)", () => {
  it("seeds the pusher, the earliest commit author and the PR creator, one rung per branch", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [pusher, committer, prAuthor] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const pushed = await seedBranch(organizationId, "rung-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await pushLink(organizationId, pushed, pusher.id, "rung-push");
      const committed = await seedBranch(organizationId, "rung-commit", {
        firstPushedAt: null,
      });
      await seedGitHubConnection({
        organizationId,
        userId: committer.id,
        login: "committer",
      });
      await seedCommit({
        organizationId,
        branchId: committed,
        sha: "c".repeat(40),
        authorLogin: "committer",
        committedAt: FIRST_PUSHED_AT,
      });
      const pullRequested = await seedBranch(organizationId, "rung-pr", {
        firstPushedAt: null,
      });
      await seedGitHubConnection({
        organizationId,
        userId: prAuthor.id,
        login: "pr-author",
      });
      await seedPullRequestDetail(
        organizationId,
        pullRequested,
        "rung-pr",
        "pr-author"
      );

      const stamped = await seed(organizationId, [
        pushed,
        committed,
        pullRequested,
      ]);

      expect(stamped).toBe(3);
      expect(await readAssignee(pushed)).toBe(pusher.id);
      expect(await readAssignee(committed)).toBe(committer.id);
      expect(await readAssignee(pullRequested)).toBe(prAuthor.id);
    });
  });

  it("never overwrites an existing assignee", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [pusher, assignee] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const branchId = await seedBranch(organizationId, "assigned", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await pushLink(organizationId, branchId, pusher.id, "assigned");
      await setAssignee(branchId, assignee.id);

      expect(await seed(organizationId, [branchId])).toBe(0);
      expect(await readAssignee(branchId)).toBe(assignee.id);
    });
  });

  it("keeps a PR-creator stamp when an earlier push arrives later", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const [pusher, prAuthor] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const branchId = await seedBranch(organizationId, "frozen", {
        firstPushedAt: null,
      });
      await seedGitHubConnection({
        organizationId,
        userId: prAuthor.id,
        login: "pr-author",
      });
      await seedPullRequestDetail(
        organizationId,
        branchId,
        "frozen",
        "pr-author"
      );
      await seed(organizationId, [branchId]);
      expect(await readAssignee(branchId)).toBe(prAuthor.id);

      await pushLink(organizationId, branchId, pusher.id, "frozen");
      // The chain now names the pusher; the stamp does not follow it.
      expect(await readOwnerKey(organizationId, branchId)).toBe(
        closedloopKey(pusher.id)
      );

      expect(await seed(organizationId, [branchId])).toBe(0);
      expect(await readAssignee(branchId)).toBe(prAuthor.id);
    });
  });

  it("does not seed a connection whose user belongs to another organization", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const outsider = await createTestUser(otherOrganizationId);
      const branchId = await seedBranch(organizationId, "outsider", {
        firstPushedAt: null,
      });
      await seedGitHubConnection({
        organizationId,
        userId: outsider.id,
        login: "outsider",
      });
      await seedCommit({
        organizationId,
        branchId,
        sha: "d".repeat(40),
        authorLogin: "outsider",
        committedAt: FIRST_PUSHED_AT,
      });
      expect(await readOwnerKey(organizationId, branchId)).toBe(
        closedloopKey(outsider.id)
      );

      expect(await seed(organizationId, [branchId])).toBe(0);
      expect(await readAssignee(branchId)).toBeNull();
    });
  });

  it("does not seed a GitHub shadow user", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const shadow = await createTestUser(organizationId, {
        clerkId: `${GITHUB_SHADOW_CLERK_PREFIX}${organizationId}:4242`,
      });
      const branchId = await seedBranch(organizationId, "shadow", {
        firstPushedAt: null,
      });
      await seedGitHubConnection({
        organizationId,
        userId: shadow.id,
        login: "shadow",
      });
      await seedPullRequestDetail(organizationId, branchId, "shadow", "shadow");
      expect(await readOwnerKey(organizationId, branchId)).toBe(
        closedloopKey(shadow.id)
      );

      expect(await seed(organizationId, [branchId])).toBe(0);
      expect(await readAssignee(branchId)).toBeNull();
    });
  });

  it("does not seed a commit author with no connection in this organization", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      // A connection for a different login, so only the exact-login match
      // keeps the author unresolved.
      const bystander = await createTestUser(organizationId);
      await seedGitHubConnection({
        organizationId,
        userId: bystander.id,
        login: "bystander",
      });
      const branchId = await seedBranch(organizationId, "unconnected", {
        firstPushedAt: null,
      });
      await seedCommit({
        organizationId,
        branchId,
        sha: "e".repeat(40),
        authorLogin: "unconnected",
        committedAt: FIRST_PUSHED_AT,
      });

      expect(await readOwnerKey(organizationId, branchId)).toBeNull();
      expect(await seed(organizationId, [branchId])).toBe(0);
      expect(await readAssignee(branchId)).toBeNull();
    });
  });

  it("leaves updated_at alone and writes no activity receipt", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const pusher = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "quiet", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await pushLink(organizationId, branchId, pusher.id, "quiet");
      const before = await readUpdatedAt(branchId);

      await seed(organizationId, [branchId]);

      expect(await readAssignee(branchId)).toBe(pusher.id);
      expect(await readUpdatedAt(branchId)).toEqual(before);
      expect(
        await withDb((db) =>
          db.artifactActivityEvent.count({ where: { artifactId: branchId } })
        )
      ).toBe(0);
    });
  });

  it("stamps each branch with its own owner, and only branches in its own org", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const otherOrganizationId = await createTestOrganization();
      const [first, second] = await Promise.all([
        createTestUser(organizationId),
        createTestUser(organizationId),
      ]);
      const otherPusher = await createTestUser(otherOrganizationId);
      const firstBranch = await seedBranch(organizationId, "first", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      const secondBranch = await seedBranch(organizationId, "second", {
        firstPushedAt: LATER_PUSHED_AT,
      });
      const unattributed = await seedBranch(organizationId, "nobody", {
        firstPushedAt: null,
      });
      const otherBranch = await seedBranch(otherOrganizationId, "theirs", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await pushLink(organizationId, firstBranch, first.id, "first");
      await pushLink(organizationId, secondBranch, second.id, "second", {
        observedAt: LATER_PUSHED_AT,
      });
      await pushLink(otherOrganizationId, otherBranch, otherPusher.id, "x");

      const stamped = await seed(organizationId, [
        secondBranch,
        firstBranch,
        unattributed,
        otherBranch,
        firstBranch,
      ]);

      expect(stamped).toBe(2);
      expect(await readAssignee(firstBranch)).toBe(first.id);
      expect(await readAssignee(secondBranch)).toBe(second.id);
      expect(await readAssignee(unattributed)).toBeNull();
      expect(await readAssignee(otherBranch)).toBeNull();
    });
  });
});

/**
 * Two real transactions, so the fixture must be committed. The seed runs under a
 * lock_timeout shorter than Prisma's interactive-transaction timeout: a seed
 * that waits on the held row fails with a lock timeout instead of hanging.
 */
describe.skipIf(!HAS_DATABASE)("seedBranchOwners row locks (ISS-12463)", () => {
  const organizations = createCommittedTestOrganizationTracker();

  afterEach(async () => {
    await organizations.cleanup();
  });

  it("skips a branch row another transaction holds, and seeds it once released", async () => {
    const organizationId = await organizations.create();
    const pusher = await createTestUser(organizationId);
    const branchId = await seedBranch(organizationId, "held", {
      firstPushedAt: FIRST_PUSHED_AT,
    });
    await pushLink(organizationId, branchId, pusher.id, "held");

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
          Prisma.sql`SELECT id FROM artifacts WHERE id = ${branchId}::uuid FOR UPDATE`
        );
        signalLocked();
        await released;
      },
      { timeout: LOCK_TEST_TX_TIMEOUT_MS }
    );
    try {
      await locked;
      const stamped = await withDb.tx(
        async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SET LOCAL lock_timeout = ${Prisma.raw(`'${SEED_LOCK_TIMEOUT_MS}ms'`)}`
          );
          return seedBranchOwners(tx, organizationId, [branchId]);
        },
        { timeout: LOCK_TEST_TX_TIMEOUT_MS }
      );
      expect(stamped).toBe(0);
    } finally {
      release();
      await holder;
    }
    expect(await readAssignee(branchId)).toBeNull();

    expect(await seed(organizationId, [branchId])).toBe(1);
    expect(await readAssignee(branchId)).toBe(pusher.id);
  });
});

function seed(
  organizationId: string,
  branchIds: readonly string[]
): Promise<number> {
  return withDb.tx((tx) => seedBranchOwners(tx, organizationId, branchIds));
}

async function pushLink(
  organizationId: string,
  branchId: string,
  userId: string,
  label: string,
  options: { observedAt?: Date } = {}
): Promise<void> {
  await seedEvidenceLink({
    organizationId,
    branchId,
    userId,
    label,
    method: GIT_PUSH_METHOD,
    observedAt: options.observedAt ?? FIRST_PUSHED_AT,
  });
}

async function setAssignee(branchId: string, userId: string): Promise<void> {
  await withDb((db) =>
    db.artifact.update({
      where: { id: branchId },
      data: { assigneeId: userId },
      select: { id: true },
    })
  );
}

async function readUpdatedAt(branchId: string): Promise<Date> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: branchId },
      select: { updatedAt: true },
    })
  );
  return row.updatedAt;
}

async function readOwnerKey(
  organizationId: string,
  branchId: string
): Promise<string | null> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ ownerKey: string | null }[]>(Prisma.sql`
      SELECT branch_owner_chain.owner_key AS "ownerKey"
      FROM artifacts a
      JOIN branch_detail b ON b.artifact_id = a.id
      ${branchOwnerChainLateralSql()}
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.id = ${branchId}::uuid
        AND a.type = ${ArtifactType.Branch}::"ArtifactType"
    `)
  );
  return rows[0]?.ownerKey ?? null;
}

const SEED_LOCK_TIMEOUT_MS = 2000;
const LOCK_TEST_TX_TIMEOUT_MS = 10_000;
