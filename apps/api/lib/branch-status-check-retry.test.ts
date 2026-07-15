import { describe, expect, it, vi } from "vitest";
import {
  type CheckRunRetryKey,
  CheckRunRetryState,
  claimDueCheckRunRetries,
  clearCheckRunRetry,
  discardCheckRunRetry,
  getCheckRunRetryResetData,
  scheduleCheckRunRetry,
  settleRetryableCheckRunFailure,
} from "./branch-status-check-retry";

const retryKey: CheckRunRetryKey = {
  branchArtifactId: "branch-1",
  organizationId: "org-1",
  repositoryId: "repo-1",
  headSha: "head-1",
  resourceId: "check-run-1",
  idempotencyKey: "repo:check-run-1:head-1:completed",
};
const CREDENTIAL_IDENTITY_FIELD_REGEX = /token|account|login|user|credential/i;

describe("branch status check retry", () => {
  it("schedules resource-keyed retry metadata without credential identity", async () => {
    const tx = txWithUpdateCounts(0, 1);
    const now = new Date("2026-07-03T01:00:00Z");

    await expect(
      scheduleCheckRunRetry(tx as never, retryKey, "rate_limited", now, 30)
    ).resolves.toBe("scheduled");

    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: {
        artifact: { organizationId: retryKey.organizationId },
        artifactId: retryKey.branchArtifactId,
        deletedAt: null,
        headSha: retryKey.headSha,
        repositoryId: retryKey.repositoryId,
      },
      data: expect.objectContaining({
        checkRunRetryState: CheckRunRetryState.Pending,
        checkRunRetryHeadSha: retryKey.headSha,
        checkRunRetryResourceId: retryKey.resourceId,
        checkRunRetryIdempotencyKey: retryKey.idempotencyKey,
        checkRunRetryReason: "rate_limited",
      }),
    });
    const data = tx.branchDetail.updateMany.mock.calls[1][0].data;
    expect(Object.keys(data).join(" ")).not.toMatch(
      CREDENTIAL_IDENTITY_FIELD_REGEX
    );
  });

  it("preserves attempts when scheduling the same resource identity again", async () => {
    const tx = txWithUpdateCounts(1);
    const now = new Date("2026-07-03T01:00:00Z");

    await expect(
      scheduleCheckRunRetry(tx as never, retryKey, "rate_limited", now, 30)
    ).resolves.toBe("scheduled");

    expect(tx.branchDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        checkRunRetryHeadSha: retryKey.headSha,
        checkRunRetryIdempotencyKey: retryKey.idempotencyKey,
        checkRunRetryResourceId: retryKey.resourceId,
      }),
      data: expect.not.objectContaining({
        checkRunRetryAttempts: expect.any(Number),
      }),
    });
  });

  it("resets attempts when scheduling a new resource identity", async () => {
    const tx = txWithUpdateCounts(0, 1);
    const now = new Date("2026-07-03T01:00:00Z");

    await expect(
      scheduleCheckRunRetry(tx as never, retryKey, "rate_limited", now, 30)
    ).resolves.toBe("scheduled");

    expect(tx.branchDetail.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.branchDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkRunRetryAttempts: 0,
          checkRunRetryLastAttemptAt: null,
        }),
      })
    );
  });

  it("claims pending and stale claimed rows with lock-safe identity predicates", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    await claimDueCheckRunRetries(
      tx as never,
      new Date("2026-07-03T01:00:00Z"),
      10
    );

    const query = tx.$queryRaw.mock.calls[0][0];
    const queryText = query.strings.join("?");
    expect(queryText).toContain("FOR UPDATE SKIP LOCKED");
    expect(queryText).toContain(
      "branch_detail.check_run_retry_state = candidate.check_run_retry_state"
    );
    expect(queryText).toContain(
      "branch_detail.check_run_retry_resource_id = candidate.check_run_retry_resource_id"
    );
    expect(queryText).toContain("branch_detail.updated_at ASC");
    expect(queryText).toContain("branch_detail.check_run_retry_state = ");
    expect(query.values).toContain(CheckRunRetryState.Claimed);
  });

  it("clears all retry metadata on success or head reset", async () => {
    const tx = txWithUpdateCount(1);

    await expect(clearCheckRunRetry(tx as never, retryKey)).resolves.toBe(
      "cleared"
    );

    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: getCheckRunRetryResetData(),
        where: expect.objectContaining({
          checkRunRetryHeadSha: retryKey.headSha,
          checkRunRetryIdempotencyKey: retryKey.idempotencyKey,
          checkRunRetryResourceId: retryKey.resourceId,
        }),
      })
    );
  });

  it("discards exact retry metadata after a stale or deleted branch settlement", async () => {
    const tx = txWithUpdateCount(1);

    await expect(discardCheckRunRetry(tx as never, retryKey)).resolves.toBe(
      "discarded"
    );

    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith({
      data: getCheckRunRetryResetData(),
      where: {
        artifact: { organizationId: retryKey.organizationId },
        artifactId: retryKey.branchArtifactId,
        checkRunRetryHeadSha: retryKey.headSha,
        checkRunRetryIdempotencyKey: retryKey.idempotencyKey,
        checkRunRetryResourceId: retryKey.resourceId,
        repositoryId: retryKey.repositoryId,
      },
    });
  });

  it("reschedules failures using provider retry-after seconds", async () => {
    const tx = txWithUpdateCount(1);
    const now = new Date("2026-07-03T01:00:00Z");

    await expect(
      settleRetryableCheckRunFailure(
        tx as never,
        retryKey,
        "rate_limited",
        1,
        now,
        90
      )
    ).resolves.toBe("retry_scheduled");

    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkRunRetryNextAt: new Date("2026-07-03T01:01:30Z"),
          checkRunRetryState: CheckRunRetryState.Pending,
        }),
      })
    );
  });

  it("dead-letters after the bounded retry ceiling", async () => {
    const tx = txWithUpdateCount(1);

    await expect(
      settleRetryableCheckRunFailure(
        tx as never,
        retryKey,
        "rate_limited",
        5,
        new Date("2026-07-03T01:00:00Z"),
        null
      )
    ).resolves.toBe("dead_letter");

    expect(tx.branchDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checkRunRetryState: CheckRunRetryState.DeadLetter,
        }),
        where: expect.objectContaining({
          checkRunRetryIdempotencyKey: retryKey.idempotencyKey,
          checkRunRetryResourceId: retryKey.resourceId,
        }),
      })
    );
  });
});

function txWithUpdateCount(count: number) {
  return txWithUpdateCounts(count);
}

function txWithUpdateCounts(...counts: number[]) {
  const updateMany = vi.fn();
  for (const count of counts) {
    updateMany.mockResolvedValueOnce({ count });
  }
  updateMany.mockResolvedValue({ count: counts.at(-1) ?? 0 });
  return {
    branchDetail: {
      updateMany,
    },
  };
}
