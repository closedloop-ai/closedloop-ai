import { randomUUID } from "node:crypto";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { computeNextRetryAt } from "@/app/cron/reconcile-pull-requests/repo-reconciler";
import { GitHubRepoSyncTier } from "@/lib/github/github-repo-sync-state";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

async function seedSyncState(
  organizationId: string,
  overrides: {
    tier?: string;
    consecutiveFailureCount?: number;
    nextRetryAt?: Date | null;
    lastSweptAt?: Date | null;
  } = {}
) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  const fullName = `org/repo-${suffix}`;
  return await withDb((db) =>
    db.gitHubRepoSyncState.create({
      data: {
        organizationId,
        repositoryFullName: fullName,
        tier: overrides.tier ?? GitHubRepoSyncTier.Installed,
        consecutiveFailureCount: overrides.consecutiveFailureCount ?? 0,
        nextRetryAt: overrides.nextRetryAt ?? null,
        lastSweptAt: overrides.lastSweptAt ?? null,
      },
    })
  );
}

async function queryDueRepos(organizationId: string, now: Date) {
  return await withDb((db) =>
    db.gitHubRepoSyncState.findMany({
      where: {
        organizationId,
        tier: { not: GitHubRepoSyncTier.Unsyncable },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
          { consecutiveFailureCount: 0 },
        ],
      },
      orderBy: [{ lastSweptAt: { sort: "asc", nulls: "first" } }],
      select: {
        repositoryFullName: true,
        consecutiveFailureCount: true,
        nextRetryAt: true,
      },
    })
  );
}

describe.skipIf(!hasDatabase)(
  "nextRetryAt backoff — database integration",
  () => {
    it("excludes a failed repo before its backoff window elapses", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");
        const retryAt = computeNextRetryAt(1, now);

        await seedSyncState(orgId, {
          consecutiveFailureCount: 1,
          nextRetryAt: retryAt,
        });

        const beforeDeadline = new Date(retryAt.getTime() - 1);
        const due = await queryDueRepos(orgId, beforeDeadline);
        expect(due).toHaveLength(0);
      });
    });

    it("includes the repo once the backoff window elapses", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");
        const retryAt = computeNextRetryAt(1, now);

        await seedSyncState(orgId, {
          consecutiveFailureCount: 1,
          nextRetryAt: retryAt,
        });

        const atDeadline = retryAt;
        const due = await queryDueRepos(orgId, atDeadline);
        expect(due).toHaveLength(1);
      });
    });

    it("clears the backoff when failures are reset to zero", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");
        const retryAt = computeNextRetryAt(3, now);

        const row = await seedSyncState(orgId, {
          consecutiveFailureCount: 3,
          nextRetryAt: retryAt,
        });

        await withDb((db) =>
          db.gitHubRepoSyncState.update({
            where: { id: row.id },
            data: { consecutiveFailureCount: 0, nextRetryAt: null },
          })
        );

        const due = await queryDueRepos(orgId, now);
        expect(due).toHaveLength(1);
        expect(due[0]?.consecutiveFailureCount).toBe(0);
        expect(due[0]?.nextRetryAt).toBeNull();
      });
    });

    it("version-skew: consecutiveFailureCount=0 with stale nextRetryAt is still eligible", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");
        const futureRetryAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        await seedSyncState(orgId, {
          consecutiveFailureCount: 0,
          nextRetryAt: futureRetryAt,
        });

        const due = await queryDueRepos(orgId, now);
        expect(due).toHaveLength(1);
        expect(due[0]?.consecutiveFailureCount).toBe(0);
      });
    });

    it("optimistic concurrency: a late failure write is a no-op if a concurrent success already cleared failures", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");

        const row = await seedSyncState(orgId, {
          consecutiveFailureCount: 2,
          nextRetryAt: computeNextRetryAt(2, now),
        });

        await withDb((db) =>
          db.gitHubRepoSyncState.update({
            where: { id: row.id },
            data: { consecutiveFailureCount: 0, nextRetryAt: null },
          })
        );

        const lateFailureResult = await withDb((db) =>
          db.gitHubRepoSyncState.updateMany({
            where: {
              organizationId: orgId,
              repositoryFullName: row.repositoryFullName,
              consecutiveFailureCount: 2,
            },
            data: {
              consecutiveFailureCount: 3,
              nextRetryAt: computeNextRetryAt(3, now),
            },
          })
        );

        expect(lateFailureResult.count).toBe(0);

        const final = await withDb((db) =>
          db.gitHubRepoSyncState.findUnique({
            where: { id: row.id },
            select: { consecutiveFailureCount: true, nextRetryAt: true },
          })
        );
        expect(final?.consecutiveFailureCount).toBe(0);
        expect(final?.nextRetryAt).toBeNull();
      });
    });

    it("unsyncable repos are never selected regardless of nextRetryAt", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const now = new Date("2026-08-14T12:00:00.000Z");

        await seedSyncState(orgId, {
          tier: GitHubRepoSyncTier.Unsyncable,
          consecutiveFailureCount: 0,
          nextRetryAt: null,
        });

        const due = await queryDueRepos(orgId, now);
        expect(due).toHaveLength(0);
      });
    });
  }
);
