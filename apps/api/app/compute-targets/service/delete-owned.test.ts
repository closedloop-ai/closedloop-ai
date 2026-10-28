import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  deleteTranscriptObjects: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: mocks.deleteTranscriptObjects,
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

import { computeTargetsService } from "../service";

/**
 * The compute-target teardown, split out of `service.test.ts` with the function
 * it covers (ISS-8674). Driven through `computeTargetsService.deleteOwned`
 * rather than the extracted module directly, so the delegation stays covered
 * and deleting it fails here.
 */
function installDb(db: unknown) {
  const dbWithDefaults =
    typeof db === "object" && db !== null
      ? {
          computeTargetHealthCheck: { deleteMany: vi.fn() },
          // The chunked pre-drain and the FOR UPDATE both go through the raw
          // client. Defaulted so every case models them: the drain reports an
          // empty queue (one round trip, then stop) and the lock finds the row.
          // A case that needs a different answer passes its own.
          $executeRaw: vi.fn().mockResolvedValue(0),
          $queryRaw: vi.fn().mockResolvedValue([{ id: "target-1" }]),
          ...db,
        }
      : db;
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

describe("computeTargetsService deleteOwned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session transcripts before the compute target", async () => {
    const artifactDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const transcriptFindMany = vi.fn().mockResolvedValue([]);
    const transcriptDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: artifactDeleteMany,
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    // The RESTRICT FK on session_transcript.compute_target_id requires the
    // transcript rows to be cleared before the target row (FEA-2807).
    expect(transcriptDeleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
    expect(transcriptDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      targetDeleteMany.mock.invocationCallOrder[0]
    );
  });

  // ISS-8674 put an AFTER trigger on desktop_commands that writes the target's
  // queued_command_count, so every command write locks the command row and then
  // the target row. desktop_commands is onDelete: Cascade, so leaving the drain
  // to the cascade would invert that here — the parent DELETE takes the target
  // row first, and only then goes looking for command rows a concurrent ack,
  // event ingest, expiry or requeue already holds. That is a lock cycle, and
  // Postgres resolves it by aborting one side with a 40P01 that nothing in
  // `withDb` retries. Draining the commands in their own statement first puts
  // this transaction back on the order every other writer uses.
  it("drains the target's desktop commands before deleting the target", async () => {
    const commandDeleteMany = vi.fn().mockResolvedValue({ count: 4 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      desktopCommand: { deleteMany: commandDeleteMany },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await computeTargetsService.deleteOwned("target-1", "org-1", "user-1");

    expect(commandDeleteMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
    });
    // The order is the whole point — asserting only that both ran would stay
    // green with the cascade back in charge.
    expect(commandDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      targetDeleteMany.mock.invocationCallOrder[0]
    );
  });

  it("purges the collected transcript objects after the rows are deleted", async () => {
    const transcriptFindMany = vi.fn().mockResolvedValue([
      { objectStorageKey: "transcripts/org-1/a.jsonl" },
      { objectStorageKey: "transcripts/org-1/b.jsonl" },
      // An empty key is filtered out so it never reaches the purge call.
      { objectStorageKey: "" },
    ]);
    const transcriptDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    mocks.deleteTranscriptObjects.mockResolvedValue(undefined);
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    // Keys are collected before the rows carrying them are dropped.
    expect(transcriptFindMany).toHaveBeenCalledWith({
      where: { computeTargetId: "target-1" },
      select: { objectStorageKey: true },
    });
    expect(transcriptFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      transcriptDeleteMany.mock.invocationCallOrder[0]
    );
    // The S3 objects are purged with exactly the non-empty collected keys.
    expect(mocks.deleteTranscriptObjects).toHaveBeenCalledTimes(1);
    expect(mocks.deleteTranscriptObjects).toHaveBeenCalledWith([
      "transcripts/org-1/a.jsonl",
      "transcripts/org-1/b.jsonl",
    ]);
  });

  it("does not purge transcript objects when there are none", async () => {
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(true);
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });

  it("still reports success and logs the orphaned keys when the object purge fails", async () => {
    mocks.deleteTranscriptObjects.mockRejectedValue(new Error("s3 down"));
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { objectStorageKey: "transcripts/org-1/a.jsonl" },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    // The FK-ordering fix must not be corrupted by an S3 failure: the target
    // row is already gone, so the delete still reports success.
    expect(deleted).toBe(true);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][1]).toMatchObject({
      computeTargetId: "target-1",
      objectStorageKeys: ["transcripts/org-1/a.jsonl"],
    });
  });

  it("does not purge transcript objects when the target row was not deleted", async () => {
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        // A concurrent delete won the race: count 0.
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { objectStorageKey: "transcripts/org-1/a.jsonl" },
          ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });

  it("returns false without deleting when the target is not owned", async () => {
    const artifactDeleteMany = vi.fn();
    const transcriptFindMany = vi.fn();
    const transcriptDeleteMany = vi.fn();
    const targetDeleteMany = vi.fn();
    installDb({
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: targetDeleteMany,
      },
      artifact: {
        deleteMany: artifactDeleteMany,
      },
      sessionTranscript: {
        findMany: transcriptFindMany,
        deleteMany: transcriptDeleteMany,
      },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(artifactDeleteMany).not.toHaveBeenCalled();
    expect(transcriptFindMany).not.toHaveBeenCalled();
    expect(transcriptDeleteMany).not.toHaveBeenCalled();
    expect(targetDeleteMany).not.toHaveBeenCalled();
    expect(mocks.deleteTranscriptObjects).not.toHaveBeenCalled();
  });

  // The pre-drain deletes rows before any transaction opens, so the ownership
  // read that gates it is a security boundary, not an optimization. A caller
  // who does not own the target must not be able to empty its queue.
  it("does not drain a target the caller does not own", async () => {
    const drain = vi.fn().mockResolvedValue(0);
    installDb({
      $executeRaw: drain,
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue(null),
        deleteMany: vi.fn(),
      },
      artifact: { deleteMany: vi.fn() },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(drain).not.toHaveBeenCalled();
  });

  // The reason the drain moved out of the transaction (marisolashgrove): the
  // counter trigger turns one bulk delete into one single-row UPDATE per
  // command against one target row, which is superlinear and passes
  // `withDb.tx`'s 5s default at ~8,000 rows. Asserting only that the drain
  // happened would stay green with it back inside the transaction, so this
  // pins that it completes BEFORE the transaction opens.
  it("empties the queue in committed chunks before opening the transaction", async () => {
    // Two full chunks, then a short one — the loop stops on the first statement
    // that removes nothing, so a drain that stopped after one round trip would
    // leave rows behind and fail here on the call count.
    const drain = vi
      .fn()
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(1000)
      .mockResolvedValue(0);
    installDb({
      $executeRaw: drain,
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await computeTargetsService.deleteOwned("target-1", "org-1", "user-1");

    expect(drain).toHaveBeenCalledTimes(3);
    expect(drain.mock.invocationCallOrder[2]).toBeLessThan(
      mocks.withDb.tx.mock.invocationCallOrder[0]
    );
  });

  // The lock ORDER is what closes the delete-vs-enqueue cycle (davetho): a
  // concurrent enqueue holds the FK's KEY SHARE, which does not conflict with
  // the counter trigger's FOR NO KEY UPDATE, so the teardown must take the
  // stronger lock before it writes anything the enqueue could be waiting on.
  it("locks the target row before any delete inside the transaction", async () => {
    const lock = vi.fn().mockResolvedValue([{ id: "target-1" }]);
    const artifactDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const targetDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      $queryRaw: lock,
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: { deleteMany: artifactDeleteMany },
      sessionTranscript: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await computeTargetsService.deleteOwned("target-1", "org-1", "user-1");

    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0][0].join("")).toContain("FOR UPDATE");
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      artifactDeleteMany.mock.invocationCallOrder[0]
    );
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      targetDeleteMany.mock.invocationCallOrder[0]
    );
  });

  // The lock is the authoritative ownership check, so losing the row between
  // the gate read and it must abort the teardown rather than delete a target
  // this caller no longer owns.
  it("returns false when the row is gone by the time the lock is taken", async () => {
    const targetDeleteMany = vi.fn();
    installDb({
      $queryRaw: vi.fn().mockResolvedValue([]),
      desktopCommand: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        deleteMany: targetDeleteMany,
      },
      artifact: { deleteMany: vi.fn() },
      sessionTranscript: { findMany: vi.fn(), deleteMany: vi.fn() },
    });

    const deleted = await computeTargetsService.deleteOwned(
      "target-1",
      "org-1",
      "user-1"
    );

    expect(deleted).toBe(false);
    expect(targetDeleteMany).not.toHaveBeenCalled();
  });
});
