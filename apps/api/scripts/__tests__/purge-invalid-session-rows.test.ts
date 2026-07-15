/**
 * Unit tests for the FEA-1964 invalid-session purge.
 *
 * `@repo/database` is mocked: `withDb` / `withDb.tx` run the callback against a
 * fake Prisma client whose methods return fixtures, so we can assert the
 * orchestration (count-first, drift guard, cascade delete, orphan check,
 * org-scoping, run-config gating) without a database. The DB cascade itself is
 * guaranteed by schema `onDelete: Cascade` (artifact→session_detail→children)
 * and re-checked at runtime by the orphan assertion below.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

import {
  BackupRequiredError,
  CURRENT_SERVER_MIN_REVISION,
  chunk,
  countCascadeAssociations,
  countDependents,
  countOrphanedChildren,
  invalidSessionWhere,
  OrphanRowsRemainError,
  PredicateDriftError,
  positiveIntEnv,
  purgeInvalidSessionRows,
  resolveRunConfig,
  writeBackupToFile,
} from "../purge-invalid-session-rows";

function makeFakeDb() {
  return {
    sessionDetail: { findMany: vi.fn(), count: vi.fn() },
    agentSessionTokenUsage: { count: vi.fn() },
    agentSessionEvent: { count: vi.fn() },
    artifact: { deleteMany: vi.fn(), findMany: vi.fn() },
    loop: { count: vi.fn() },
  };
}

type FakeDb = ReturnType<typeof makeFakeDb>;

/** A `_count` projection row as Prisma returns it for countCascadeAssociations. */
function associationCountRow(overrides: Partial<Record<string, number>> = {}) {
  return {
    _count: {
      sourceLinks: 0,
      targetLinks: 0,
      ratings: 0,
      evaluations: 0,
      commentThreads: 0,
      fileAttachments: 0,
      tagArtifacts: 0,
      favoritedBy: 0,
      linearSubtasks: 0,
      ...overrides,
    },
  };
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = makeFakeDb();
  // Both the non-tx and tx paths run against the same fake client so findMany /
  // count call ordering is shared and deterministic across the test.
  mocks.withDb.mockImplementation((cb: (c: FakeDb) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (c: FakeDb) => unknown) => cb(db));
  // Default: no wider-cascade associations on the matched artifacts. Tests that
  // exercise the association signal override these.
  db.artifact.findMany.mockResolvedValue([]);
  db.loop.count.mockResolvedValue(0);
});

function selectRow(id: string, dataRevision: number | null) {
  return {
    artifactId: id,
    externalSessionId: `ext-${id}`,
    computeTargetId: `ct-${id}`,
    dataRevision,
  };
}

function exportRow(id: string) {
  return {
    artifactId: id,
    externalSessionId: `ext-${id}`,
    computeTargetId: `ct-${id}`,
    dataRevision: 1,
    tokenUsageByModel: [{ id: `tu-${id}` }],
    events: [{ id: `ev-${id}` }],
    artifact: { id, organizationId: "org-A" },
  };
}

describe("invalidSessionWhere", () => {
  it("is org-scoped and matches NULL or below-min revisions only", () => {
    expect(invalidSessionWhere("org-A")).toStrictEqual({
      artifact: { organizationId: "org-A" },
      OR: [
        { dataRevision: null },
        { dataRevision: { lt: CURRENT_SERVER_MIN_REVISION } },
      ],
    });
    // Current-revision rows (== 3) are intentionally excluded: only `< 3` matches.
    expect(CURRENT_SERVER_MIN_REVISION).toBe(3);
  });
});

describe("chunk", () => {
  it("splits into batches of at most size, last batch may be short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toStrictEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toStrictEqual([]);
    expect(chunk([1, 2], 10)).toStrictEqual([[1, 2]]);
  });
});

describe("writeBackupToFile", () => {
  it("writes NDJSON (header + one line per session, bigint-safe) at mode 0o600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purge-bkp-"));
    process.env.PURGE_BACKUP_DIR = dir;
    try {
      const path = await writeBackupToFile({
        orgId: "org-A",
        minRevision: 3,
        exportedAt: "2026-06-19T12:00:00.000Z",
        // bigint in a child must serialize as a string via backupReplacer; a
        // single giant JSON.stringify would otherwise be the scale failure mode.
        sessionDetails: [
          { artifactId: "a1", tokens: 10n },
          { artifactId: "a2" },
        ] as never,
      });

      expect(path.endsWith(".ndjson")).toBe(true);
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(3); // header + 2 sessions, one object per line
      expect(JSON.parse(lines[0])).toMatchObject({
        orgId: "org-A",
        minRevision: 3,
        sessionCount: 2,
      });
      expect(JSON.parse(lines[1])).toStrictEqual({
        artifactId: "a1",
        tokens: "10",
      });
      expect(JSON.parse(lines[2])).toStrictEqual({ artifactId: "a2" });
      // Low 9 bits = permission bits (avoids a bitwise mask Biome disallows).
      expect((await stat(path)).mode % 0o1000).toBe(0o600);
    } finally {
      delete process.env.PURGE_BACKUP_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("countDependents", () => {
  it("counts dependents by the invalid-row predicate (relation filter, no id list)", async () => {
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(6);
    db.agentSessionEvent.count.mockResolvedValueOnce(12);

    const result = await countDependents(db as never, "org-A");

    expect(result).toStrictEqual({ tokenUsageCount: 6, eventCount: 12 });
    // No id arrays — scoped via the session relation predicate so it cannot hit
    // the bind-parameter limit regardless of org size.
    const where = { session: invalidSessionWhere("org-A") };
    expect(db.agentSessionTokenUsage.count).toHaveBeenCalledWith({ where });
    expect(db.agentSessionEvent.count).toHaveBeenCalledWith({ where });
  });
});

describe("countOrphanedChildren", () => {
  it("batches the id list and sums child counts across chunks", async () => {
    // 3 ids with a chunk of 10k → single batch here; assert sum + id-based query.
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(0);
    db.agentSessionEvent.count.mockResolvedValueOnce(0);

    const result = await countOrphanedChildren(db as never, ["a1", "a2", "a3"]);

    expect(result).toStrictEqual({ tokenUsageCount: 0, eventCount: 0 });
    expect(db.agentSessionTokenUsage.count).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["a1", "a2", "a3"] } },
    });
  });

  it("does nothing for an empty id list", async () => {
    const result = await countOrphanedChildren(db as never, []);
    expect(result).toStrictEqual({ tokenUsageCount: 0, eventCount: 0 });
    expect(db.agentSessionTokenUsage.count).not.toHaveBeenCalled();
    expect(db.agentSessionEvent.count).not.toHaveBeenCalled();
  });
});

describe("countCascadeAssociations", () => {
  it("sums per-artifact association counts (incl. source+target links) and loop refs, filtered by predicate", async () => {
    db.artifact.findMany.mockResolvedValueOnce([
      associationCountRow({
        commentThreads: 2,
        sourceLinks: 1,
        targetLinks: 1,
      }),
      associationCountRow({ favoritedBy: 3, tagArtifacts: 1, ratings: 1 }),
    ]);
    db.loop.count.mockResolvedValueOnce(4);

    const result = await countCascadeAssociations(db as never, "org-A");

    expect(result).toMatchObject({
      artifactLinks: 2, // 1 source + 1 target
      commentThreads: 2,
      favorites: 3,
      tagArtifacts: 1,
      ratings: 1,
      loopReferences: 4,
    });
    // total counts every field, including the dangling-pointer loop refs.
    expect(result.total).toBe(2 + 2 + 3 + 1 + 1 + 4);
    // No id arrays — artifacts + loops filtered via the session predicate, so it
    // cannot hit the bind-parameter limit regardless of org size.
    const sessionWhere = invalidSessionWhere("org-A");
    expect(db.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { session: sessionWhere } })
    );
    expect(db.loop.count).toHaveBeenCalledWith({
      where: {
        OR: [
          { artifact: { session: sessionWhere } },
          { sessionArtifact: { session: sessionWhere } },
        ],
      },
    });
  });

  it("returns zero when no matched artifacts or loops", async () => {
    db.artifact.findMany.mockResolvedValueOnce([]);
    db.loop.count.mockResolvedValueOnce(0);
    const result = await countCascadeAssociations(db as never, "org-A");
    expect(result.total).toBe(0);
  });
});

describe("positiveIntEnv", () => {
  it("returns the parsed value for a positive integer", () => {
    expect(positiveIntEnv("600000", 120_000)).toBe(600_000);
  });

  it("falls back when unset, empty, or not a positive integer", () => {
    expect(positiveIntEnv(undefined, 120_000)).toBe(120_000);
    expect(positiveIntEnv("", 120_000)).toBe(120_000);
    expect(positiveIntEnv("  ", 120_000)).toBe(120_000);
    expect(positiveIntEnv("0", 120_000)).toBe(120_000);
    expect(positiveIntEnv("-5", 120_000)).toBe(120_000);
    expect(positiveIntEnv("12.5", 120_000)).toBe(120_000);
    expect(positiveIntEnv("abc", 120_000)).toBe(120_000);
  });
});

describe("resolveRunConfig", () => {
  it("requires ORG_ID", () => {
    expect(resolveRunConfig({})).toMatchObject({ ok: false });
  });

  it("defaults to a dry run when ORG_ID is present", () => {
    expect(resolveRunConfig({ ORG_ID: "org-A" })).toStrictEqual({
      ok: true,
      orgId: "org-A",
      dryRun: true,
    });
  });

  it("executes only when DRY_RUN=0", () => {
    expect(resolveRunConfig({ ORG_ID: "org-A", DRY_RUN: "0" })).toStrictEqual({
      ok: true,
      orgId: "org-A",
      dryRun: false,
    });
    expect(resolveRunConfig({ ORG_ID: "org-A", DRY_RUN: "1" })).toMatchObject({
      dryRun: true,
    });
  });
});

describe("purgeInvalidSessionRows — dry run", () => {
  it("counts the target by predicate without deleting or backing up", async () => {
    // Target is a predicate COUNT (no id list / no findMany of rows).
    db.sessionDetail.count.mockResolvedValueOnce(4);
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(6);
    db.agentSessionEvent.count.mockResolvedValueOnce(12);
    // One matched artifact carries a comment thread + a favorite the backup
    // won't capture, and two loops point at the matched set.
    db.artifact.findMany.mockResolvedValueOnce([
      associationCountRow({ commentThreads: 1, favoritedBy: 1 }),
    ]);
    db.loop.count.mockResolvedValueOnce(2);
    const writeBackup = vi.fn();

    const report = await purgeInvalidSessionRows(
      { orgId: "org-A", dryRun: true },
      { writeBackup }
    );

    expect(report).toMatchObject({
      dryRun: true,
      targetCount: 4,
      tokenUsageCount: 6,
      eventCount: 12,
      exportedCount: 0,
      deletedCount: 0,
      backupPath: null,
      associations: {
        commentThreads: 1,
        favorites: 1,
        loopReferences: 2,
        total: 4,
      },
    });
    expect(db.sessionDetail.count).toHaveBeenCalledWith({
      where: invalidSessionWhere("org-A"),
    });
    // Dry run must not enumerate rows by id (scale-free).
    expect(db.sessionDetail.findMany).not.toHaveBeenCalled();
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });
});

describe("purgeInvalidSessionRows — execute", () => {
  it("backs up first (outside the txn), then deletes parents org-scoped with cascade and passes the orphan check", async () => {
    const ids = ["a1", "a2", "a3", "a4"];
    db.sessionDetail.findMany
      .mockResolvedValueOnce(ids.map((id) => exportRow(id))) // export (read, pre-txn)
      .mockResolvedValueOnce(ids.map((id) => selectRow(id, 1))); // re-fetch in txn
    // Dependents derive from the exported children, not a count query; the only
    // count calls are the in-txn orphan check.
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(0);
    db.agentSessionEvent.count.mockResolvedValueOnce(0);
    db.artifact.deleteMany.mockResolvedValueOnce({ count: 4 });

    const writeBackup = vi.fn().mockResolvedValue("/var/tmp/backup.json");
    const now = () => new Date("2026-06-18T12:00:00.000Z");

    const report = await purgeInvalidSessionRows(
      { orgId: "org-A", dryRun: false },
      { writeBackup, now }
    );

    expect(report).toMatchObject({
      dryRun: false,
      targetCount: 4,
      tokenUsageCount: 4, // one token-usage row per exported session
      eventCount: 4, // one event row per exported session
      exportedCount: 4,
      deletedCount: 4,
      backupPath: "/var/tmp/backup.json",
    });
    expect(writeBackup).toHaveBeenCalledTimes(1);
    expect(writeBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-A",
        minRevision: 3,
        exportedAt: "2026-06-18T12:00:00.000Z",
        sessionDetails: expect.arrayContaining([
          expect.objectContaining({ artifactId: "a1" }),
        ]),
      })
    );
    // Backup happens before the delete AND before the transaction opens.
    const backupOrder = writeBackup.mock.invocationCallOrder[0];
    const txOrder = mocks.withDb.tx.mock.invocationCallOrder[0];
    const deleteOrder = db.artifact.deleteMany.mock.invocationCallOrder[0];
    expect(backupOrder).toBeLessThan(txOrder);
    expect(backupOrder).toBeLessThan(deleteOrder);
    // Delete is org-scoped (defense-in-depth) and targets the exported IDs.
    expect(db.artifact.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ids }, organizationId: "org-A" },
    });
    // The delete tx raises Prisma's 5s default timeout — the cascade delete runs
    // inside the tx and can exceed it on a large invalid set.
    const txOptions = mocks.withDb.tx.mock.calls[0]?.[1] as
      | { timeout?: number; maxWait?: number }
      | undefined;
    expect(txOptions?.timeout).toBeGreaterThan(5000);
    expect(txOptions?.maxWait).toBeGreaterThan(0);
  });

  it("passes injected tx timeout/maxWait through to the delete transaction", async () => {
    const ids = ["a1", "a2"];
    db.sessionDetail.findMany
      .mockResolvedValueOnce(ids.map((id) => exportRow(id)))
      .mockResolvedValueOnce(ids.map((id) => selectRow(id, 1)));
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(0);
    db.agentSessionEvent.count.mockResolvedValueOnce(0);
    db.artifact.deleteMany.mockResolvedValueOnce({ count: 2 });

    await purgeInvalidSessionRows(
      { orgId: "org-A", dryRun: false },
      {
        writeBackup: vi.fn().mockResolvedValue("/var/tmp/b.json"),
        txTimeoutMs: 600_000,
        txMaxWaitMs: 25_000,
      }
    );

    expect(mocks.withDb.tx.mock.calls[0]?.[1]).toStrictEqual({
      timeout: 600_000,
      maxWait: 25_000,
    });
  });

  it("refuses to delete when no backup writer is provided", async () => {
    db.sessionDetail.findMany.mockResolvedValueOnce(
      ["a1", "a2"].map((id) => exportRow(id))
    );

    await expect(
      purgeInvalidSessionRows({ orgId: "org-A", dryRun: false })
    ).rejects.toBeInstanceOf(BackupRequiredError);
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
  });

  it("aborts without deleting when the invalid set shrinks between backup and delete", async () => {
    db.sessionDetail.findMany
      .mockResolvedValueOnce(
        ["a1", "a2", "a3", "a4"].map((id) => exportRow(id))
      ) // backed up: 4
      .mockResolvedValueOnce(["a1", "a2", "a3"].map((id) => selectRow(id, 1))); // txn: only 3 still invalid

    await expect(
      purgeInvalidSessionRows(
        { orgId: "org-A", dryRun: false },
        { writeBackup: vi.fn().mockResolvedValue("/var/tmp/b.json") }
      )
    ).rejects.toBeInstanceOf(PredicateDriftError);
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
  });

  it("aborts when the set rotates to the same size but different rows (identity guard)", async () => {
    db.sessionDetail.findMany
      .mockResolvedValueOnce(
        ["a1", "a2", "a3", "a4"].map((id) => exportRow(id))
      ) // backed up: a1..a4
      .mockResolvedValueOnce(
        ["a1", "a2", "a3", "a5"].map((id) => selectRow(id, 1))
      ); // txn: same count, a4 swapped for a5

    await expect(
      purgeInvalidSessionRows(
        { orgId: "org-A", dryRun: false },
        { writeBackup: vi.fn().mockResolvedValue("/var/tmp/b.json") }
      )
    ).rejects.toBeInstanceOf(PredicateDriftError);
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
  });

  it("rolls back (throws) when orphaned child rows survive the delete", async () => {
    const ids = ["a1", "a2"];
    db.sessionDetail.findMany
      .mockResolvedValueOnce(ids.map((id) => exportRow(id)))
      .mockResolvedValueOnce(ids.map((id) => selectRow(id, 1)));
    db.agentSessionTokenUsage.count.mockResolvedValueOnce(2); // orphan check: still 2 -> failure
    db.agentSessionEvent.count.mockResolvedValueOnce(0);
    db.artifact.deleteMany.mockResolvedValueOnce({ count: 2 });

    await expect(
      purgeInvalidSessionRows(
        { orgId: "org-A", dryRun: false },
        { writeBackup: vi.fn().mockResolvedValue("/var/tmp/b.json") }
      )
    ).rejects.toBeInstanceOf(OrphanRowsRemainError);
  });

  it("does nothing when there are no invalid rows (no backup, no txn)", async () => {
    db.sessionDetail.findMany.mockResolvedValueOnce([]);
    const writeBackup = vi.fn();

    const report = await purgeInvalidSessionRows(
      { orgId: "org-A", dryRun: false },
      { writeBackup }
    );

    expect(report).toMatchObject({
      targetCount: 0,
      exportedCount: 0,
      deletedCount: 0,
      backupPath: null,
    });
    expect(mocks.withDb.tx).not.toHaveBeenCalled();
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(writeBackup).not.toHaveBeenCalled();
  });
});
