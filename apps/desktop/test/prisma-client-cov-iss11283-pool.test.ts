/**
 * @file prisma-client-cov-iss11283-pool.test.ts
 * @description ISS-11283: `createDesktopPrisma` arms the existing Prisma suites
 * leave unexercised —
 *   - a binary (`Buffer`) raw argument, which the coercion wrapper must pass
 *     through untouched rather than JSON-encode like a plain object;
 *   - the WAL-depth verdict for a store with no `-wal` sidecar to measure
 *     (in-memory: no probe, no anomaly) and for a sidecar that is ABSENT on
 *     disk (ENOENT reads as 0 frames, a measured empty WAL);
 *   - the idle-reader recycler's three guards: a slot with a read in flight is
 *     skipped, a tick that fires while another is still opening does nothing,
 *     and a tick paused mid-open when `disconnect()` begins closes its spare.
 *
 * The recycler runs on `setInterval`, so those cases fake ONLY
 * `setInterval`/`clearInterval` and fire ticks by hand; every open underneath
 * is a real libSQL connection. A reader open is counted by its
 * `PRAGMA query_only=ON`, which only reader connections issue.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WAL_TRUNCATE_INTERVAL_MS } from "../src/main/database/connection-pragmas.js";
import { PrismaClient } from "../src/main/database/generated/client.js";
import {
  type CreateDesktopPrismaOptions,
  createDesktopPrisma,
  type DesktopPrisma,
  WAL_SIDECAR_SUFFIX,
} from "../src/main/database/prisma-client.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { deferred } from "./deferred.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const READER_PRAGMA = "PRAGMA query_only=ON";
const RECYCLE_INTERVAL_MS = 60_000;
const noopWrite = () => Promise.resolve();

type WalRun = {
  truncates: number;
  health: ReturnType<DesktopPrisma["readWalProbeHealth"]>;
};

/**
 * One write against `prisma` on a clock pinned one interval ahead (time floor
 * open, write floor short — the branch that consults the depth verdict),
 * resolving when that write's maintenance pass has settled.
 */
function walOptions(counters: {
  truncates: number;
  settle: (() => void) | null;
}): CreateDesktopPrismaOptions {
  return {
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    onWalTruncate: () => {
      counters.truncates += 1;
    },
    onWalMaintenanceSettled: () => {
      const resolve = counters.settle;
      counters.settle = null;
      resolve?.();
    },
  };
}

async function writeOnce(
  prisma: DesktopPrisma,
  counters: { truncates: number; settle: (() => void) | null }
): Promise<WalRun> {
  const settled = new Promise<void>((resolve) => {
    counters.settle = resolve;
  });
  await prisma.write(noopWrite);
  await settled;
  return { truncates: counters.truncates, health: prisma.readWalProbeHealth() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDesktopPrisma raw-argument coercion (ISS-11283)", () => {
  it("binds a Buffer argument as a blob, not as its JSON form", async () => {
    const opened = await openTestPrisma();
    try {
      const rows = await opened.prisma.client.$queryRawUnsafe<
        { kind: string; size: number; objectText: string }[]
      >(
        "SELECT typeof($1) AS kind, length($1) AS size, $2 AS objectText",
        Buffer.from([1, 2, 3]),
        // Control in the same call: an object carrying a bigint (the shape a
        // raw read of a BIGINT column hands back) IS rewritten by the wrapper —
        // plain JSON.stringify rejects bigints — so the Buffer's blob result is
        // its own pass-through arm rather than a pass-through of everything.
        { tokens: 42n }
      );
      expect(
        rows.map((row) => [row.kind, Number(row.size), row.objectText])
      ).toEqual([["blob", 3, '{"tokens":42}']]);
    } finally {
      await opened.close();
    }
  });
});

describe("createDesktopPrisma WAL-depth verdict (ISS-11283)", () => {
  it("takes the unknown fallback without probing or tallying for an in-memory store", async () => {
    const counters = { truncates: 0, settle: null as (() => void) | null };
    const prisma = await createDesktopPrisma(
      { url: ":memory:" },
      createWriteQueue(),
      walOptions(counters)
    );
    try {
      const run = await writeOnce(prisma, counters);
      // Unknown depth falls back to the base timer TRUNCATE...
      expect(run.truncates).toBe(1);
      // ...and an unmeasurable store is never counted as a probe or anomaly.
      expect(run.health).toEqual({
        measurable: false,
        probes: 0,
        anomalies: 0,
        lastAnomalyReason: null,
      });
    } finally {
      await prisma.disconnect();
    }
  });

  it("opens an in-memory store with no options at all and serves reads", async () => {
    const prisma = await createDesktopPrisma(
      { url: ":memory:" },
      createWriteQueue()
    );
    try {
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<{ n: number }[]>("SELECT 5 AS n")
      );
      expect(rows.map((row) => Number(row.n))).toEqual([5]);
      expect(prisma.readWalProbeHealth().measurable).toBe(false);
    } finally {
      await prisma.disconnect();
    }
  });

  it("reads an absent -wal sidecar as an empty WAL and holds the reclaim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss11283-wal-absent-"));
    const dbPath = path.join(dir, "store.sqlite");
    const counters = { truncates: 0, settle: null as (() => void) | null };
    const prisma = await createDesktopPrisma(
      { url: `file:${dbPath}`, intMode: "number" },
      createWriteQueue(),
      walOptions(counters)
    );
    try {
      const walPath = `${dbPath}${WAL_SIDECAR_SUFFIX}`;
      await rm(walPath, { force: true });
      await expect(stat(walPath)).rejects.toThrow();

      const run = await writeOnce(prisma, counters);

      expect(run.truncates).toBe(0);
      expect(run.health).toEqual({
        measurable: true,
        probes: 1,
        anomalies: 0,
        lastAnomalyReason: null,
      });
    } finally {
      await prisma.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createDesktopPrisma idle-reader recycler guards (ISS-11283)", () => {
  async function openRecyclingPool() {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const readerOpens: string[] = [];
    const recycled: number[] = [];
    let onRecycle: () => void = () => undefined;
    const opened = await openTestPrisma(createWriteQueue(), {
      readerPoolSize: 1,
      readerRecycleIntervalMs: RECYCLE_INTERVAL_MS,
      onStatementSettled: (sql) => {
        if (sql === READER_PRAGMA) {
          readerOpens.push(sql);
        }
      },
      onReaderRecycle: (slot) => {
        recycled.push(slot);
        onRecycle();
      },
    });
    const nextRecycle = () =>
      new Promise<void>((resolve) => {
        onRecycle = resolve;
      });
    return { opened, readerOpens, recycled, nextRecycle };
  }

  it("skips a slot whose read is still in flight", async () => {
    const { opened, readerOpens, recycled } = await openRecyclingPool();
    try {
      expect(readerOpens).toHaveLength(1);
      const gate = deferred();
      const read = opened.prisma.read(async (reader) => {
        await gate.promise;
        return await reader.$queryRawUnsafe<{ n: number }[]>("SELECT 7 AS n");
      });

      vi.advanceTimersByTime(RECYCLE_INTERVAL_MS);
      gate.resolve();
      expect((await read).map((row) => Number(row.n))).toEqual([7]);
      // disconnect() awaits the tick it interrupted, so a tick that had opened
      // a replacement would be counted by now.
      await opened.prisma.disconnect();

      expect(readerOpens).toHaveLength(1);
      expect(recycled).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it("ignores a tick that fires while the previous tick is still opening", async () => {
    const { opened, readerOpens, recycled, nextRecycle } =
      await openRecyclingPool();
    try {
      const firstSwap = nextRecycle();
      vi.advanceTimersByTime(RECYCLE_INTERVAL_MS);
      vi.advanceTimersByTime(RECYCLE_INTERVAL_MS);
      await firstSwap;
      // The second tick is the one disconnect() drains; had it run, its open
      // would be counted here.
      await opened.prisma.disconnect();

      expect(recycled).toEqual([0]);
      expect(readerOpens).toHaveLength(2);
    } finally {
      await opened.close();
    }
  });

  it("closes the spare, and swaps nothing, when disconnect begins while a tick is opening", async () => {
    const { opened, readerOpens, recycled } = await openRecyclingPool();
    const disconnects = vi.spyOn(PrismaClient.prototype, "$disconnect");
    try {
      vi.advanceTimersByTime(RECYCLE_INTERVAL_MS);
      await opened.prisma.disconnect();

      // The tick DID open a replacement (initial reader + the spare)...
      expect(readerOpens).toHaveLength(2);
      // ...but saw `closed` after its await and never swapped it in.
      expect(recycled).toEqual([]);
      // Writer + the pooled reader + the spare.
      expect(disconnects).toHaveBeenCalledTimes(3);
    } finally {
      disconnects.mockRestore();
      await opened.close();
    }
  });
});
