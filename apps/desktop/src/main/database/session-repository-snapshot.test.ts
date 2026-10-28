import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionListCursorSortKey } from "../agent-sync/agent-session-read-model.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { readRepositoryScopedSnapshot } from "./session-repository-snapshot.js";
import { openSqliteAgentDatabase } from "./sqlite.js";

function revisionStore(revisions: number[]) {
  let inTransaction = false;
  const probeTransactionState: boolean[] = [];
  const pairs = vi.fn(() => {
    probeTransactionState.push(inTransaction);
    return Promise.resolve([
      {
        pair_key: "/work/repo\u001forg/alpha",
        cwd: "/work/repo",
        repo_full_name: "org/alpha",
      },
    ]);
  });
  type FakeSnapshot = {
    $queryRawUnsafe: typeof pairs;
    $transaction: <T>(read: (reader: FakeSnapshot) => Promise<T>) => Promise<T>;
  };
  const snapshot: FakeSnapshot = {
    $queryRawUnsafe: pairs,
    $transaction: async <T>(read: (reader: typeof snapshot) => Promise<T>) => {
      inTransaction = true;
      try {
        return await read(snapshot);
      } finally {
        inTransaction = false;
      }
    },
  };
  const revision = vi.fn(async () => [{ revision: revisions.shift() ?? 0 }]);
  const prisma = {
    client: { $queryRawUnsafe: revision },
    read: async <T>(read: (reader: typeof snapshot) => Promise<T>) =>
      read(snapshot),
  } as unknown as DesktopPrisma;
  return {
    prisma,
    pairs,
    revision,
    probeTransactionState,
    isInTransaction: () => inTransaction,
  };
}

describe("DT-14 standalone repository snapshot", () => {
  it("DT-42/46: a repository write before the snapshot keeps page and total coherent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prd728-repository-"));
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "unknown",
      now: () => "2026-06-12T03:00:00.000Z",
    });
    try {
      await db.whenBootMaintenanceSettled();
      await db.run(
        `INSERT INTO sessions (id, name, status, harness, billing_mode, cwd, repo_full_name, metadata, started_at, updated_at)
         VALUES ('one', 'One', 'inactive', 'claude', 'api', '/work/one', 'org/alpha', '{}', '2026-06-12T01:00:00.000Z', '2026-06-12T03:00:00.000Z'),
                ('two', 'Two', 'inactive', 'claude', 'api', '/work/two', 'org/alpha', '{}', '2026-06-12T01:00:00.000Z', '2026-06-12T02:00:00.000Z')`
      );
      const cursor = db.syncSource.listSessionCursorPage;
      if (!cursor) {
        throw new Error("production compact cursor unavailable");
      }
      const originalRead = db.prisma.read.bind(db.prisma);
      let reads = 0;
      const readSpy = vi
        .spyOn(db.prisma, "read")
        .mockImplementation(async (read) => {
          reads += 1;
          if (reads === 2) {
            await db.run(
              "UPDATE sessions SET repo_full_name = 'org/other' WHERE id = 'two'"
            );
          }
          return originalRead(read);
        });
      try {
        const page = await cursor({
          quality: "all",
          repositories: ["org/alpha"],
          limit: 25,
          offset: 0,
          sortBy: SessionListCursorSortKey.Updated,
          sortDir: "desc",
        });
        expect(page.rows.map((row) => row.id)).toEqual(["one"]);
        expect(page.total).toBe(1);
        expect(readSpy).toHaveBeenCalledTimes(2);
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("DT-42: unrelated writer traffic cannot turn a completed repository page into an error", async () => {
    const store = revisionStore([1, 2, 3, 4, 5, 6]);
    const read = vi.fn(async (_snapshot: unknown, keys?: string[]) => keys);
    await expect(
      readRepositoryScopedSnapshot(
        store.prisma,
        ["org/alpha"],
        { clause: "", params: [] },
        read
      )
    ).resolves.toEqual(["/work/repo\u001forg/alpha"]);
    expect(store.probeTransactionState).toEqual([false]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("resolves repository pairs once before the short read snapshot", async () => {
    const store = revisionStore([1, 2, 2, 2]);
    const read = vi.fn((_snapshot: unknown, keys?: string[]) => {
      expect(store.isInTransaction()).toBe(true);
      return Promise.resolve(keys);
    });
    const result = await readRepositoryScopedSnapshot(
      store.prisma,
      ["org/alpha"],
      { clause: "", params: [] },
      read
    );
    expect(result).toEqual(["/work/repo\u001forg/alpha"]);
    expect(store.pairs).toHaveBeenCalledTimes(1);
    expect(store.probeTransactionState).toEqual([false]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.revision).not.toHaveBeenCalled();
  });

  it("does not make a completed list read depend on unrelated writer revisions", async () => {
    const store = revisionStore([1, 2, 3, 4, 5, 6]);
    const read = vi.fn(async () => "complete page");
    await expect(
      readRepositoryScopedSnapshot(
        store.prisma,
        ["org/alpha"],
        { clause: "", params: [] },
        read
      )
    ).resolves.toBe("complete page");
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.revision).not.toHaveBeenCalled();
  });
});
