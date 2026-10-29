import { IssueStatus } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import {
  hasDatabase,
  seedArtifact,
  seedBlockedFanOut,
  terminalize,
} from "./__tests__/blocked-dependent-fixtures";
import {
  blockedDependentUnblockService,
  UNBLOCK_CANDIDATE_CHUNK_SIZE,
} from "./blocked-dependent-unblock-service";

/**
 * ISS-11104 — the committed half of the blocked-dependent coverage.
 *
 * Split out of `blocked-dependent-unblock.integration.test.ts`, which runs every
 * case inside one ambient auto-rollback transaction. These cases are the exact
 * opposite and cannot share that file's wrapper: they need each chunk's own
 * COMMITTED transaction to be observable, so they run on
 * `createCommittedTestOrganizationTracker` and clean up after themselves.
 */

/**
 * The ISS-11104 boundary fixture, pinned to LITERALS on purpose — see the
 * "keeps the fan-out spanning more than one chunk" case for why deriving the
 * expected chunk count from `UNBLOCK_CANDIDATE_CHUNK_SIZE` would make the
 * boundary assertions unfalsifiable.
 */
const FAN_OUT_ROW_COUNT = 97;
const FAN_OUT_CHUNK_COUNT = 4;

const describeIfDb = hasDatabase ? describe : describe.skip;

describeIfDb("blocked-dependent unblock — committed chunk boundary", () => {
  /**
   * ISS-11104 — the per-chunk transaction BOUNDARY, not just the chunked
   * `IN (…)` list.
   *
   * The fan-out case above proves every row moved, which an unbounded
   * single-statement sweep satisfies too. `xmin` is the transaction that last
   * wrote a row, and the two assertions here kill the two ways the boundary can
   * be removed:
   *
   * - hoisting `withDb.tx` out of `forEachUnblockedChunk`'s loop puts every row
   *   on ONE transaction, so the distinct count collapses from
   *   {@link FAN_OUT_CHUNK_COUNT} to 1;
   * - replacing that `withDb.tx` with a plain `withDb` still gives each chunk's
   *   statement its own implicit xid, so the count survives — but the status
   *   write and the chunk's audit receipt then land in DIFFERENT transactions,
   *   which is the atomicity ISS-10993 added and the equality below pins.
   *
   * Driven through `resolveBlocksForChangedArtifacts`, the entry point that
   * passes `captureInTx`, because `unblockDependentsOfChanged` writes no receipt
   * and so cannot observe the second mutation at all.
   *
   * Its own committed fixture, and deliberately NOT `autoRollbackTransaction`:
   * that wrapper's ambient transaction absorbs every chunk and pins the count at
   * 1 however the service is written — the exact blindness ISS-11104 closes, and
   * why the harness now fails such a case instead of passing it.
   */
  describe("per-chunk transaction boundary", () => {
    const tracker = createCommittedTestOrganizationTracker();
    let organizationId = "";

    beforeAll(async () => {
      organizationId = await tracker.create();
      const blockerId = await seedArtifact({
        organizationId,
        status: IssueStatus.InProgress,
      });
      await seedBlockedFanOut({
        organizationId,
        blockerId,
        count: FAN_OUT_ROW_COUNT,
      });
      await terminalize({
        organizationId,
        id: blockerId,
        status: IssueStatus.Done,
      });
      await blockedDependentUnblockService.resolveBlocksForChangedArtifacts({
        organizationId,
        changedArtifactIds: [blockerId],
      });
    });

    afterAll(async () => {
      await tracker.cleanup();
    });

    it("keeps the fan-out spanning more than one chunk", () => {
      // The two literals below are the fixture, not a derivation: computing the
      // expected count from UNBLOCK_CANDIDATE_CHUNK_SIZE would agree with any
      // value of it, including one wide enough to make the fan-out a single
      // chunk — under which both cases below pass while observing nothing.
      expect(Math.ceil(FAN_OUT_ROW_COUNT / UNBLOCK_CANDIDATE_CHUNK_SIZE)).toBe(
        FAN_OUT_CHUNK_COUNT
      );
      expect(FAN_OUT_CHUNK_COUNT).toBeGreaterThan(1);
    });

    it("writes each chunk on its own transaction, not one wide one", async () => {
      const writers = await withDb(
        (db) =>
          db.$queryRaw<{ xmin: string }[]>`
          SELECT DISTINCT xmin::text AS xmin
          FROM artifacts
          WHERE organization_id = ${organizationId}::uuid
            AND status = ${IssueStatus.Todo}
        `
      );

      expect(writers).toHaveLength(FAN_OUT_CHUNK_COUNT);
    });

    it("commits each row's audit receipt in that same transaction", async () => {
      // Both halves, because the mismatch count ALONE passes with zero
      // receipts: if `captureInTx` stops writing the activity event the JOIN
      // matches nothing, `mismatches` is 0, and a case named for receipt
      // atomicity stays green over a receipt that no longer exists.
      // `withReceipt` is the presence assertion on the same JOIN that
      // `mismatches` is the absence assertion on — counted DISTINCT by row, so
      // it says every unblocked row carries a receipt without also pinning how
      // many events one row may have — and losing the receipt reds this too.
      const receipts = await withDb(
        (db) =>
          db.$queryRaw<{ withReceipt: bigint; mismatches: bigint }[]>`
          SELECT count(DISTINCT a.id) AS "withReceipt",
                 count(*) FILTER (WHERE a.xmin <> e.xmin) AS mismatches
          FROM artifacts a
          JOIN artifact_activity_events e
            ON e.artifact_id = a.id
           AND e.organization_id = a.organization_id
          WHERE a.organization_id = ${organizationId}::uuid
            AND a.status = ${IssueStatus.Todo}
        `
      );

      expect(Number(receipts[0]?.withReceipt)).toBe(FAN_OUT_ROW_COUNT);
      expect(Number(receipts[0]?.mismatches)).toBe(0);
    });
  });
});
