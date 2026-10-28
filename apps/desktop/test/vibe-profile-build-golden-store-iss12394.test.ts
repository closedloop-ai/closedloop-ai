import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vibeCorpusTimeMapPath } from "@repo/api/src/vibe-seed-corpus-time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * Drives buildShiftedGoldenStore's own control flow with the golden corpus
 * stubbed out: no file under packages/golden-sessions is read. The staging
 * dir is an empty temp dir, the collector boot pass completes at once, and
 * the store is seeded with the sessions each case names.
 */

const fake = vi.hoisted(() => ({
  stagingDirs: [] as string[],
  collectorCount: 1,
  seed: async (_db: SqliteAgentDatabase): Promise<void> => undefined,
  recomputeFailed: 0,
  managerStarts: 0,
}));

vi.mock("../scripts/rehearsal-build-store", async () => {
  const fs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  return {
    stageCorpusIntoTemp: () => {
      const dir = fs.mkdtempSync(
        nodePath.join(nodeOs.tmpdir(), "vibe-golden-stage-")
      );
      fake.stagingDirs.push(dir);
      return dir;
    },
    runRehearsalBackfills: () => Promise.resolve({ errors: 0, scanned: 0 }),
    assertBackfillsClean: () => undefined,
  };
});
vi.mock("../src/main/collectors/golden/golden-collectors.js", () => ({
  createGoldenCollectors: () =>
    Array.from({ length: fake.collectorCount }, () => ({})),
}));
vi.mock("../src/main/collectors/engine/collector-manager.js", () => ({
  CollectorManager: class {
    private readonly onDone: () => void;
    constructor(options: { onBootImportComplete: () => void }) {
      this.onDone = options.onBootImportComplete;
    }
    start() {
      fake.managerStarts += 1;
      this.onDone();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));
vi.mock("../src/main/database/sqlite.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/main/database/sqlite.js")>();
  return {
    ...original,
    openSqliteAgentDatabase: async (
      ...args: Parameters<typeof original.openSqliteAgentDatabase>
    ) => {
      const db = await original.openSqliteAgentDatabase(...args);
      await fake.seed(db);
      const recompute = db.recomputeAnalyticsRollups.bind(db);
      db.recomputeAnalyticsRollups = async (ids) => {
        const result = await recompute(ids);
        return fake.recomputeFailed > 0
          ? { ...result, failed: fake.recomputeFailed }
          : result;
      };
      return db;
    },
  };
});

import { buildShiftedGoldenStore } from "../scripts/vibe-profile/build-golden-store";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const NOW = "2026-10-07T00:00:00.000Z";
const NEWEST = "2026-08-01T10:00:00.000Z";
const NO_COLLECTORS_RE =
  /^golden corpus produced no collectors: empty staging dir$/;
const ZERO_SESSIONS_RE = /^the golden corpus imported zero sessions$/;
const RECOMPUTE_RE = /^analytics recompute failed for 1 of 1 shifted sessions$/;
const dirs: string[] = [];

beforeEach(() => {
  fake.collectorCount = 1;
  fake.seed = async () => undefined;
  fake.recomputeFailed = 0;
  fake.managerStarts = 0;
});

afterEach(async () => {
  for (const dir of [...dirs.splice(0), ...fake.stagingDirs.splice(0)]) {
    await rm(dir, { recursive: true, force: true });
  }
});

function storePath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-golden-12394-"));
  dirs.push(dir);
  return path.join(dir, "store");
}

function seedOneSession() {
  let seeded = false;
  fake.seed = async (db) => {
    if (!seeded) {
      seeded = true;
      await insertSqliteSession(db, "corpus-1", { startedAt: NEWEST });
    }
  };
}

describe("buildShiftedGoldenStore", () => {
  it("fails before the boot pass when the corpus yields no collectors, and removes the staging dir", async () => {
    fake.collectorCount = 0;

    await expect(
      buildShiftedGoldenStore(storePath(), NOW, () => undefined)
    ).rejects.toThrow(NO_COLLECTORS_RE);
    expect(fake.managerStarts).toBe(0);
    expect(fake.stagingDirs).toHaveLength(1);
    expect(existsSync(fake.stagingDirs[0] ?? "")).toBe(false);
  });

  it("fails when the import left no session to anchor the shift on", async () => {
    await expect(
      buildShiftedGoldenStore(storePath(), NOW, () => undefined)
    ).rejects.toThrow(ZERO_SESSIONS_RE);
    expect(fake.managerStarts).toBe(1);
  });

  it("fails when the analytics recompute reports a failed session", async () => {
    seedOneSession();
    fake.recomputeFailed = 1;

    await expect(
      buildShiftedGoldenStore(storePath(), NOW, () => undefined)
    ).rejects.toThrow(RECOMPUTE_RE);
  });

  it("anchors the shift on the newest session, writes the time map, and lands that session on now", async () => {
    seedOneSession();
    const store = storePath();

    const result = await buildShiftedGoldenStore(store, NOW, () => undefined);

    const shiftMs = Date.parse(NOW) - Date.parse(NEWEST);
    expect(result).toEqual({
      newestCorpusInstant: NEWEST,
      corpusShiftMs: shiftMs,
      sessionCount: 1,
    });
    const timeMap = JSON.parse(
      readFileSync(vibeCorpusTimeMapPath(store), "utf8")
    );
    expect(timeMap.shiftMs).toBe(shiftMs);
    expect(timeMap.idleGaps).toEqual([]);
    const db = await openSqliteAgentDatabase({
      dataDir: store,
      detectBillingMode: () => "api",
      retentionDays: 36_500,
    });
    try {
      const rows = await db.prisma.client.session.findMany({
        select: { id: true, startedAt: true },
      });
      expect(rows).toEqual([{ id: "corpus-1", startedAt: NOW }]);
    } finally {
      await db.close();
    }
  });
});
