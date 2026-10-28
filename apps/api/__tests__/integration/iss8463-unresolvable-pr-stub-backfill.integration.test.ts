/**
 * ISS-8463 — the one-shot backfill of unresolvable factless PR stubs, against
 * Postgres.
 *
 * The risk this ticket carries is OVER-selection, so the fixture is a mixed
 * population and every case below asserts an exclusion. A predicate that matched
 * every factless desktop row would satisfy no test here. The LIMIT boundary is a
 * different question and lives in
 * `iss8463-unresolvable-pr-stub-limit-boundary.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  applyStampBackfill,
  revertStampBackfill,
  selectUnresolvableStubs,
  summarizeUnresolvableStubs,
} from "../../scripts/backfill-unresolvable-pr-stubs-queries";
import { joinAmbientTransactionForSessionSyncWrites } from "../utils/db-helpers";
import { baseFixture, PR_OBSERVED_AT } from "./agent-session-pr-sync-helpers";
import {
  CUTOFF,
  NORMALIZED_REPO,
  OLD_ATTEMPT,
  ROLLBACK_OPTIONS,
  readStamp,
  seedMixedPopulation,
  seedStub,
  syncPrRow,
} from "./iss8463-stub-backfill-fixtures";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("unresolvable PR stub backfill (ISS-8463)", () => {
  it("selects only the unresolvable stub out of a mixed population", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const seeded = await seedMixedPopulation(fx);

      const selected = await selectUnresolvableStubs(CUTOFF);

      expect(selected.map((row) => row.id)).toEqual([seeded.unresolvable.id]);
      // Named exclusions, so a regression reports WHICH cohort leaked rather
      // than only that the count moved.
      const selectedIds = new Set(selected.map((row) => row.id));
      expect(selectedIds.has(seeded.selfHealing.id)).toBe(false);
      expect(selectedIds.has(seeded.postFix.id)).toBe(false);
      expect(selectedIds.has(seeded.healthy.id)).toBe(false);
      expect(selectedIds.has(seeded.frozen.id)).toBe(false);
      expect(selectedIds.has(seeded.recentlyAttempted.id)).toBe(false);
      expect(selectedIds.has(seeded.attemptedPostFix.id)).toBe(false);
    }, ROLLBACK_OPTIONS);
  });

  it("reports the KPI step at the (org, repo) grain the metric is emitted at", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      await seedMixedPopulation(fx);

      const population = await summarizeUnresolvableStubs(CUTOFF, null);
      const mine = population.groups.filter(
        (group) => group.organizationId === fx.organizationId
      );

      // One row to clear, but FIVE factless desktop stubs behind it — the seven
      // cohorts minus the healthy row (carries facts) and the frozen row (wrong
      // mechanism), i.e. exactly the reconciler's stub-arm cohort. The backlog is
      // what tells the operator whether the attempt-age cutoff actually bought
      // the retries it assumes; the cleared count alone cannot.
      expect(mine).toEqual([
        {
          organizationId: fx.organizationId,
          repositoryFullName: NORMALIZED_REPO,
          eligibleCount: 1n,
          selectedCount: 1n,
          desktopStubBacklog: 5n,
        },
      ]);
    }, ROLLBACK_OPTIONS);
  });

  it("captures the pre-image and clears the stamp in one statement", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const seeded = await seedMixedPopulation(fx);
      const runId = randomUUID();

      const cleared = await applyStampBackfill({
        runId,
        cutoff: CUTOFF,
        limit: null,
      });

      expect(cleared.map((row) => row.id)).toEqual([seeded.unresolvable.id]);
      // `pr_state` is captured but deliberately NOT modified — the row keeps the
      // state it had, and only the false stamp goes.
      await expect(readStamp(seeded.unresolvable.id)).resolves.toEqual({
        lastVerifiedAt: null,
        prState: GitHubPRState.Merged,
      });
      const captures = await withDb((db) =>
        db.pullRequestVerificationStampBackfill.findMany({ where: { runId } })
      );
      expect(captures).toEqual([
        expect.objectContaining({
          pullRequestDetailId: seeded.unresolvable.id,
          organizationId: fx.organizationId,
          priorLastVerifiedAt: PR_OBSERVED_AT,
          priorPrState: GitHubPRState.Merged,
          revertedAt: null,
        }),
      ]);
      // The untouched cohorts keep their stamps — the clear is as narrow as the
      // selection.
      await expect(readStamp(seeded.selfHealing.id)).resolves.toMatchObject({
        lastVerifiedAt: PR_OBSERVED_AT,
      });
      await expect(readStamp(seeded.frozen.id)).resolves.toMatchObject({
        lastVerifiedAt: PR_OBSERVED_AT,
      });
    }, ROLLBACK_OPTIONS);
  });

  /**
   * The runtime half of the capture table's FK contract; the declaration is
   * pinned by
   * `packages/database/__tests__/iss8463-pull-request-verification-stamp-backfill-migration.test.ts`.
   *
   * Without ON DELETE CASCADE this audit table would BLOCK the delete of the
   * very row it holds a pre-image of — the FK default is NO ACTION, and nothing
   * in TypeScript would show it.
   */
  it("drops a capture when the detail row it describes is deleted", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const seeded = await seedMixedPopulation(fx);
      const runId = randomUUID();
      await applyStampBackfill({ runId, cutoff: CUTOFF, limit: null });
      await expect(
        withDb((db) =>
          db.pullRequestVerificationStampBackfill.count({ where: { runId } })
        )
      ).resolves.toBe(1);

      await withDb((db) =>
        db.pullRequestDetail.delete({
          where: { id: seeded.unresolvable.id },
        })
      );

      await expect(
        withDb((db) =>
          db.pullRequestVerificationStampBackfill.count({ where: { runId } })
        )
      ).resolves.toBe(0);
    }, ROLLBACK_OPTIONS);
  });

  it("restores the exact prior stamp on revert", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const seeded = await seedMixedPopulation(fx);
      const runId = randomUUID();
      await applyStampBackfill({ runId, cutoff: CUTOFF, limit: null });

      const result = await revertStampBackfill(runId);

      expect(result).toEqual({ closedCount: 1, restoredCount: 1 });
      await expect(readStamp(seeded.unresolvable.id)).resolves.toMatchObject({
        lastVerifiedAt: PR_OBSERVED_AT,
      });
      // A second revert closes nothing — distinct from the re-verified case
      // below, which closes a capture it deliberately does not restore.
      await expect(revertStampBackfill(runId)).resolves.toEqual({
        closedCount: 0,
        restoredCount: 0,
      });
    }, ROLLBACK_OPTIONS);
  });

  it("leaves a live measurement in place when reverting a re-verified row", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const seeded = await seedMixedPopulation(fx);
      const runId = randomUUID();
      await applyStampBackfill({ runId, cutoff: CUTOFF, limit: null });
      const reconciled = new Date("2026-08-30T00:00:00.000Z");
      await withDb((db) =>
        db.pullRequestDetail.update({
          where: { id: seeded.unresolvable.id },
          data: { lastVerifiedAt: reconciled, title: "Resolved at last" },
        })
      );

      const result = await revertStampBackfill(runId);

      expect(result).toEqual({ closedCount: 1, restoredCount: 0 });
      await expect(readStamp(seeded.unresolvable.id)).resolves.toMatchObject({
        lastVerifiedAt: reconciled,
      });
    }, ROLLBACK_OPTIONS);
  });

  it("is idempotent: a second apply selects nothing already cleared", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      await seedMixedPopulation(fx);
      await applyStampBackfill({
        runId: randomUUID(),
        cutoff: CUTOFF,
        limit: null,
      });

      const second = await applyStampBackfill({
        runId: randomUUID(),
        cutoff: CUTOFF,
        limit: null,
      });

      expect(second).toEqual([]);
    }, ROLLBACK_OPTIONS);
  });

  /**
   * AC-4, driven rather than assumed: the ISS-8423 producer fix is what has to
   * hold, so this runs the real desktop sync lane against a cleared row instead
   * of reasoning about it.
   */
  it("is not re-stamped by the next desktop sync of the same factless PR", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await seedStub(fx, "feature/unresolvable", 9001, {
        lastVerifiedAt: PR_OBSERVED_AT,
        lastRefreshAttemptAt: OLD_ATTEMPT,
      });
      await applyStampBackfill({
        runId: randomUUID(),
        cutoff: CUTOFF,
        limit: null,
      });
      await expect(readStamp(pr.id)).resolves.toMatchObject({
        lastVerifiedAt: null,
      });

      await syncPrRow(fx, "feature/unresolvable", 9001);

      const after = await withDb((db) =>
        db.pullRequestDetail.findUniqueOrThrow({
          where: { id: pr.id },
          select: { lastVerifiedAt: true, lastRefreshAttemptAt: true },
        })
      );
      expect(after.lastVerifiedAt).toBeNull();
      // The retry clock is the reconciler's, and an ingest of a factless ref is
      // not a refresh attempt — the producer must not push the row back out of
      // the stub arm's window either.
      expect(after.lastRefreshAttemptAt).toEqual(OLD_ATTEMPT);
    }, ROLLBACK_OPTIONS);
  });

  /**
   * The other half of AC-4: a re-sync that DOES carry a fact re-verifies the
   * row. Without this, "stays cleared" would also be satisfied by a producer
   * that had simply stopped stamping anything.
   */
  it("is re-stamped when a later desktop sync actually observes a fact", async () => {
    await joinAmbientTransactionForSessionSyncWrites(async () => {
      const fx = await baseFixture();
      const pr = await seedStub(fx, "feature/unresolvable", 9001, {
        lastVerifiedAt: PR_OBSERVED_AT,
        lastRefreshAttemptAt: OLD_ATTEMPT,
      });
      await applyStampBackfill({
        runId: randomUUID(),
        cutoff: CUTOFF,
        limit: null,
      });

      await syncPrRow(fx, "feature/unresolvable", 9001, "Now observed");

      await expect(readStamp(pr.id)).resolves.toMatchObject({
        lastVerifiedAt: PR_OBSERVED_AT,
      });
    }, ROLLBACK_OPTIONS);
  });
});
