/**
 * ISS-6579 real-Postgres proof for the bulk repo sync-tier upsert.
 *
 * `reconcileOrgRepoSyncStates` replaced a per-repo Prisma `upsert` fanned out at
 * concurrency 5 with one chunked set-based `INSERT ... ON CONFLICT`, so a
 * large org stays a bounded number of round trips on a path that runs from
 * `waitUntil` (GitHub connect, installation_repositories webhook) and from the
 * bootstrap cron's 240s deadline.
 *
 * The mocked unit suite proves the statement was BUILT — it stubs `Prisma.sql`,
 * so a renamed column or a wrong conflict target would keep it green while
 * production raised `42703`/`42P10` into the best-effort catch that hides it.
 * This drives the real statement against a REAL Postgres and asserts the STORED
 * row: the insert defaults, the conflict update, and above all the "touch only
 * tier + lastTierEvaluatedAt" contract — the watermark, cursor, sweep time,
 * failure count, retry time, and deferral the reconciler owns must survive.
 *
 * Skipped without a DATABASE_URL; runs in CI's api-integration-tests tier.
 */
import { randomUUID } from "node:crypto";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
  reconcileOrgRepoSyncStates,
} from "../../lib/github/github-repo-sync-state";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// Unique per run so parallel/leftover data can never collide.
const ORG_ID = randomUUID();
const INSTALLATION_ID = randomUUID();
const OWNER = `iss6579-${randomUUID().slice(0, 8)}`;
const COVERED_REPO = `${OWNER}/covered`;
const STALE_REPO = `${OWNER}/stale`;
/**
 * A branch artifact + PR projection for `STALE_REPO` (whitlockk). Without it,
 * tombstoning the installation repo also removes it from the CANDIDATE set, so
 * the pass writes no row for it at all and the "conflict arm" assertions below
 * would only be proving that nothing happened. The projection keeps it a
 * candidate while its tier-1 coverage disappears, which is the demotion the
 * `ON CONFLICT DO UPDATE` arm exists to apply.
 */
const BRANCH_ARTIFACT_ID = randomUUID();

/** Reconciler-owned state that the tier write must not disturb. */
const SWEEP_STATE = {
  watermark: new Date("2026-08-01T00:00:00.000Z"),
  cursor: "cursor-page-2",
  lastSweptAt: new Date("2026-08-02T00:00:00.000Z"),
  consecutiveFailureCount: 3,
  nextRetryAt: new Date("2026-08-03T00:00:00.000Z"),
  deferredReason: GitHubRepoSyncDeferralReason.Budget,
};

const NOW = new Date("2026-08-19T12:00:00.000Z");

describe.skipIf(!hasDatabase)(
  "ISS-6579 repo sync-tier bulk upsert (real Postgres)",
  () => {
    beforeAll(async () => {
      await withDb(async (db) => {
        await db.organization.create({
          data: {
            id: ORG_ID,
            clerkId: `clerk_${ORG_ID}`,
            name: "ISS-6579 Repo Sync Tier Org",
            slug: `iss6579-${ORG_ID}`,
          },
          select: { id: true },
        });
        await db.gitHubInstallation.create({
          data: {
            id: INSTALLATION_ID,
            organizationId: ORG_ID,
            installationId: `iss6579-${randomUUID()}`,
            accountId: "acct-1",
            accountLogin: OWNER,
            accountType: "Organization",
            senderLogin: "sender",
            senderId: "sender-1",
            status: GitHubInstallationStatus.ACTIVE,
          },
          select: { id: true },
        });
        await db.gitHubInstallationRepository.createMany({
          data: [COVERED_REPO, STALE_REPO].map((fullName, index) => ({
            installationId: INSTALLATION_ID,
            githubRepoId: `iss6579-repo-${index}`,
            fullName,
            name: fullName.split("/")[1] ?? fullName,
            owner: OWNER,
            private: false,
          })),
        });
        await db.artifact.create({
          data: {
            id: BRANCH_ARTIFACT_ID,
            organizationId: ORG_ID,
            type: "BRANCH",
            name: "iss6579-branch",
            slug: `iss6579-branch-${BRANCH_ARTIFACT_ID.slice(0, 8)}`,
            status: "active",
          },
          select: { id: true },
        });
        await db.pullRequestDetail.create({
          data: {
            branchArtifactId: BRANCH_ARTIFACT_ID,
            organizationId: ORG_ID,
            repositoryFullName: STALE_REPO,
            number: 1,
          },
          select: { id: true },
        });
      });
    });

    // Each test drives the reconciler from the SAME starting state, so neither
    // depends on the other having run (nor on the order Vitest picks): no tier
    // rows, and both installation repos live.
    beforeEach(async () => {
      await withDb(async (db) => {
        await db.gitHubRepoSyncState.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.gitHubInstallationRepository.updateMany({
          where: { installationId: INSTALLATION_ID },
          data: { removedAt: null },
        });
      });
    });

    afterAll(async () => {
      await withDb(async (db) => {
        await db.gitHubRepoSyncState.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.pullRequestDetail.deleteMany({
          where: { organizationId: ORG_ID },
        });
        await db.artifact.deleteMany({ where: { organizationId: ORG_ID } });
        await db.gitHubInstallationRepository.deleteMany({
          where: { installationId: INSTALLATION_ID },
        });
        await db.gitHubInstallation.deleteMany({
          where: { id: INSTALLATION_ID },
        });
        await db.organization.deleteMany({ where: { id: ORG_ID } });
      });
    });

    const findStates = () =>
      withDb((db) =>
        db.gitHubRepoSyncState.findMany({
          where: { organizationId: ORG_ID },
          orderBy: { repositoryFullName: "asc" },
        })
      );

    it("inserts new tier rows and, on re-run, updates only tier + lastTierEvaluatedAt", async () => {
      // 1. INSERT: both installation repos materialize through the set-based
      //    statement, at tier-1 because an ACTIVE installation covers them.
      const inserted = await reconcileOrgRepoSyncStates(ORG_ID, { now: NOW });
      expect(inserted).toEqual({
        repoCount: 2,
        failedRepoCount: 0,
        settled: true,
      });

      const afterInsert = await findStates();
      expect(afterInsert.map((row) => row.repositoryFullName)).toEqual([
        COVERED_REPO,
        STALE_REPO,
      ]);
      for (const row of afterInsert) {
        expect(row.tier).toBe(GitHubRepoSyncTier.Installed);
        expect(row.lastTierEvaluatedAt).toEqual(NOW);
        // Columns the statement omits must fall to their DB defaults rather
        // than to NULL — `created_at` and `consecutive_failure_count` have
        // defaults, `updated_at` does not and is supplied as a BOUND `now`.
        expect(row.consecutiveFailureCount).toBe(0);
        expect(row.createdAt).toBeInstanceOf(Date);
        expect(row.updatedAt).toEqual(NOW);
        expect(row.watermark).toBeNull();
      }

      // 2. The reconciler advances its own state on one repo, and the
      //    installation stops covering it (tombstoned). Its PR projection keeps
      //    it a CANDIDATE, so the next pass must run the conflict arm on it —
      //    demoting the tier while leaving every sweep field intact. Without
      //    the projection it would simply drop out of the candidate set and the
      //    assertions below would prove nothing about the conflict arm.
      await withDb(async (db) => {
        await db.gitHubRepoSyncState.update({
          where: {
            organizationId_repositoryFullName: {
              organizationId: ORG_ID,
              repositoryFullName: STALE_REPO,
            },
          },
          data: SWEEP_STATE,
          select: { id: true },
        });
        await db.gitHubInstallationRepository.updateMany({
          where: { installationId: INSTALLATION_ID, fullName: STALE_REPO },
          data: { removedAt: new Date() },
        });
      });
      const staleBefore = afterInsert.find(
        (row) => row.repositoryFullName === STALE_REPO
      );

      // 3. CONFLICT UPDATE.
      const later = new Date(NOW.getTime() + 60_000);
      const reconciled = await reconcileOrgRepoSyncStates(ORG_ID, {
        now: later,
      });
      // Both repos are still candidates: the covered one through its live
      // installation row, the tombstoned one through its PR projection.
      expect(reconciled).toEqual({
        repoCount: 2,
        failedRepoCount: 0,
        settled: true,
      });

      const afterUpdate = await findStates();
      const stale = afterUpdate.find(
        (row) => row.repositoryFullName === STALE_REPO
      );
      const covered = afterUpdate.find(
        (row) => row.repositoryFullName === COVERED_REPO
      );
      expect(covered?.tier).toBe(GitHubRepoSyncTier.Installed);
      expect(covered?.lastTierEvaluatedAt).toEqual(later);

      // The uncovered repo is UPDATED IN PLACE through the conflict arm: same
      // row, demoted tier, refreshed evaluation stamp. Asserting the tier MOVED
      // is the point — an arm that wrote `EXCLUDED` for the wrong column, or
      // that was never reached, both leave `Installed` behind.
      expect(stale?.id).toBe(staleBefore?.id);
      expect(stale?.tier).toBe(GitHubRepoSyncTier.Unsyncable);
      expect(staleBefore?.tier).toBe(GitHubRepoSyncTier.Installed);
      expect(stale?.lastTierEvaluatedAt).toEqual(later);
      // …and every reconciler-owned column the arm does not name survives it.
      expect(stale?.watermark).toEqual(SWEEP_STATE.watermark);
      expect(stale?.cursor).toBe(SWEEP_STATE.cursor);
      expect(stale?.lastSweptAt).toEqual(SWEEP_STATE.lastSweptAt);
      expect(stale?.consecutiveFailureCount).toBe(
        SWEEP_STATE.consecutiveFailureCount
      );
      expect(stale?.nextRetryAt).toEqual(SWEEP_STATE.nextRetryAt);
      expect(stale?.deferredReason).toBe(SWEEP_STATE.deferredReason);
    });

    it("preserves reconciler-owned sweep state through a conflict update of an evaluated repo", async () => {
      // The covered repo is the one reconcile keeps writing, so park the sweep
      // state THERE and prove the ON CONFLICT arm — not merely the absence of a
      // write — leaves it untouched.
      await reconcileOrgRepoSyncStates(ORG_ID, { now: NOW });
      await withDb((db) =>
        db.gitHubRepoSyncState.update({
          where: {
            organizationId_repositoryFullName: {
              organizationId: ORG_ID,
              repositoryFullName: COVERED_REPO,
            },
          },
          data: SWEEP_STATE,
          select: { id: true },
        })
      );
      const before = (await findStates()).find(
        (row) => row.repositoryFullName === COVERED_REPO
      );

      const later = new Date(NOW.getTime() + 120_000);
      await reconcileOrgRepoSyncStates(ORG_ID, { now: later });

      const after = (await findStates()).find(
        (row) => row.repositoryFullName === COVERED_REPO
      );
      expect(after?.id).toBe(before?.id);
      expect(after?.createdAt).toEqual(before?.createdAt);
      expect(after?.tier).toBe(GitHubRepoSyncTier.Installed);
      expect(after?.lastTierEvaluatedAt).toEqual(later);
      expect(after?.watermark).toEqual(SWEEP_STATE.watermark);
      expect(after?.cursor).toBe(SWEEP_STATE.cursor);
      expect(after?.lastSweptAt).toEqual(SWEEP_STATE.lastSweptAt);
      expect(after?.consecutiveFailureCount).toBe(
        SWEEP_STATE.consecutiveFailureCount
      );
      expect(after?.nextRetryAt).toEqual(SWEEP_STATE.nextRetryAt);
      expect(after?.deferredReason).toBe(SWEEP_STATE.deferredReason);
      // `updated_at` is supplied as a BOUND `now`, not `NOW()` — so assert the
      // exact value rather than a monotonic bound, which would stay green if
      // the conflict arm stopped writing the column at all.
      expect(after?.updatedAt).toEqual(later);
      expect(after?.updatedAt).not.toEqual(before?.updatedAt);
    });
  }
);
