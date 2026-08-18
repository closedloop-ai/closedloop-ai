/**
 * ISS-4678 (Problem 2): the ingestion watermark
 * (`ComputeTarget.lastAgentSessionSyncAt`) advances ONLY when session data
 * actually landed. `upsertSessions` previously stamped it unconditionally after
 * the session loop, so an accepted no-op batch (empty payload or an
 * all-foreign-chunk payload that persists zero rows) kept the org looking
 * permanently "actively ingesting" and silently disarmed the ISS-4543 stall
 * detector that reads this exact column.
 *
 * ISS-4827 adds the ATTEMPT watermark (`lastAgentSessionSyncAttemptAt`), which
 * is stamped on EVERY accepted batch — including the zero-row ones above. That
 * is the signal the stall detector needs to tell a fleet that is reaching the
 * cloud but not landing data from one that is merely open and idle.
 *
 * These tests drive the real `stampIngestSyncWatermark` decision through a
 * mocked transaction client and assert the observable write.
 */
import type { TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stampIngestSyncWatermark } from "./ingest-sync-stamp";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const COMPUTE_TARGET_ID = "target-stamp-1";

const computeTargetUpdateMany = vi.fn();

function buildTx(): TransactionClient {
  return {
    computeTarget: { updateMany: computeTargetUpdateMany },
  } as unknown as TransactionClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  computeTargetUpdateMany.mockResolvedValue({ count: 1 });
});

describe("stampIngestSyncWatermark", () => {
  it("advances the watermark when at least one session persisted", async () => {
    await stampIngestSyncWatermark(buildTx(), {
      computeTargetId: COMPUTE_TARGET_ID,
      persistedSessionCount: 3,
      syncTimestamp: NOW,
    });

    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(2);
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: COMPUTE_TARGET_ID,
        OR: [
          { lastAgentSessionSyncAttemptAt: null },
          { lastAgentSessionSyncAttemptAt: { lt: NOW } },
        ],
      },
      data: { lastAgentSessionSyncAttemptAt: NOW },
    });
    expect(computeTargetUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: COMPUTE_TARGET_ID,
        OR: [
          { lastAgentSessionSyncAt: null },
          { lastAgentSessionSyncAt: { lt: NOW } },
        ],
      },
      data: { lastAgentSessionSyncAt: NOW },
    });
  });

  it("does NOT advance the LANDED-DATA watermark for an empty batch (persisted count 0)", async () => {
    await stampIngestSyncWatermark(buildTx(), {
      computeTargetId: COMPUTE_TARGET_ID,
      persistedSessionCount: 0,
      syncTimestamp: NOW,
    });

    // ISS-4827: the write still happens — but ONLY for the attempt watermark.
    // An accepted empty / all-foreign-chunk batch is positive evidence that a
    // desktop reached the cloud even though no session rows landed, and without
    // that stamp the stall detector has only the device heartbeat, which a
    // merely-open desktop refreshes on its own. The landed-data key must be
    // absent from the write, not written with a stale value.
    expect(computeTargetUpdateMany).toHaveBeenCalledTimes(1);
    expect(computeTargetUpdateMany).toHaveBeenCalledWith({
      where: {
        id: COMPUTE_TARGET_ID,
        OR: [
          { lastAgentSessionSyncAttemptAt: null },
          { lastAgentSessionSyncAttemptAt: { lt: NOW } },
        ],
      },
      data: { lastAgentSessionSyncAttemptAt: NOW },
    });
    const [[args]] = computeTargetUpdateMany.mock.calls;
    expect(args.data).not.toHaveProperty("lastAgentSessionSyncAt");
  });

  it("resolves without throwing on an empty batch — the older-Desktop resync contract", async () => {
    await expect(
      stampIngestSyncWatermark(buildTx(), {
        computeTargetId: COMPUTE_TARGET_ID,
        persistedSessionCount: 0,
        syncTimestamp: NOW,
      })
    ).resolves.toBeUndefined();
  });

  it("does NOT advance the LANDED-DATA watermark for a defensively-negative persisted count", async () => {
    await stampIngestSyncWatermark(buildTx(), {
      computeTargetId: COMPUTE_TARGET_ID,
      persistedSessionCount: -1,
      syncTimestamp: NOW,
    });

    expect(computeTargetUpdateMany).toHaveBeenCalledWith({
      where: {
        id: COMPUTE_TARGET_ID,
        OR: [
          { lastAgentSessionSyncAttemptAt: null },
          { lastAgentSessionSyncAttemptAt: { lt: NOW } },
        ],
      },
      data: { lastAgentSessionSyncAttemptAt: NOW },
    });
  });
});
