import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedPacks } from "../scripts/vibe-profile/seed-packs";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import catalogSeed from "../src/main/packs/catalog-seed.json" with {
  type: "json",
};

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const scannerControl = vi.hoisted(() => ({ failBmad: false }));

vi.mock("../src/main/packs/pack-scanner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/main/packs/pack-scanner.js")>();
  return {
    ...actual,
    runPackScanner: async (
      ...args: Parameters<typeof actual.runPackScanner>
    ) => {
      const result = await actual.runPackScanner(...args);
      if (!scannerControl.failBmad) {
        return result;
      }
      return { ...result, scopes: { ...result.scopes, bmad: false } };
    },
  };
});

const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY_MS = 86_400_000;
const SCOPE_FAILED = /pack scanner failed a scope: .*"bmad":false/;
const GIT_FAILED =
  /git remote add origin https:\/\/github\.com\/garrytan\/gstack\.git failed/;
const NO_INSTALL_COMMAND =
  /catalog seed has no claude install command for gstack/;

let dir: string;
let db: SqliteDb;
let homes: { claudeHome: string; codexHome: string };
let savedEnv: Record<string, string | undefined>;

const HOME_KEYS = ["CLAUDE_HOME", "CODEX_HOME"] as const;

function restoreEnv(): void {
  for (const key of HOME_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

describe("seedPacks", () => {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "vibe-seed-packs-"));
    homes = {
      claudeHome: path.join(dir, "claude"),
      codexHome: path.join(dir, "codex"),
    };
    savedEnv = Object.fromEntries(
      HOME_KEYS.map((key) => [key, process.env[key]])
    );
    // the scanner resolves homes from env, as prepare.ts sets them
    process.env.CLAUDE_HOME = homes.claudeHome;
    process.env.CODEX_HOME = homes.codexHome;
    db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "api",
      now: () => NOW.toISOString(),
    });
  });

  afterEach(async () => {
    scannerControl.failBmad = false;
    restoreEnv();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("installs gstack and BMad, seeds 30 days of stats per github pack and two install runs", async () => {
    const result = await seedPacks(db, homes, NOW);

    const githubPacks = catalogSeed.packs.filter(
      (pack) => pack.github_url.length > 0
    );
    // gstack is found once under the Claude home and once through the Codex
    // symlinks, so it counts as two installs: 6 + 6 gstack skills + 4 BMad
    expect(result).toMatchObject({ installRuns: 2, packs: 3, skills: 16 });
    expect(result.catalogRows).toBe(catalogSeed.packs.length);

    const history = await db.prisma.client.$queryRawUnsafe<
      { pack_id: string; n: number | bigint; oldest: string }[]
    >(
      `SELECT pack_id, COUNT(*) AS n, MIN(fetched_at) AS oldest
         FROM pack_catalog_history GROUP BY pack_id ORDER BY pack_id`
    );
    expect(history.map((row) => row.pack_id)).toEqual(
      githubPacks.map((pack) => pack.pack_id).sort()
    );
    expect(history.every((row) => Number(row.n) === 30)).toBe(true);
    expect(history[0]?.oldest).toBe(
      new Date(NOW.getTime() - 29 * DAY_MS).toISOString()
    );

    const runs = await db.prisma.client.$queryRawUnsafe<
      { pack_id: string; exit_code: number | bigint; stdout_tail: string }[]
    >(
      "SELECT pack_id, exit_code, stdout_tail FROM pack_install_runs ORDER BY pack_id"
    );
    expect(runs.map((run) => run.pack_id)).toEqual(["bmad-method", "gstack"]);
    expect(runs.every((run) => Number(run.exit_code) === 0)).toBe(true);
  });

  it("throws when the pack scanner fails a scope", async () => {
    scannerControl.failBmad = true;
    await expect(seedPacks(db, homes, NOW)).rejects.toThrow(SCOPE_FAILED);
  });

  it("throws when the gstack checkout already has an origin remote", async () => {
    await seedPacks(db, homes, NOW);
    await expect(seedPacks(db, homes, NOW)).rejects.toThrow(GIT_FAILED);
  });

  it("throws when an installed catalog pack has no claude install command", async () => {
    const gstack = catalogSeed.packs.find((pack) => pack.pack_id === "gstack");
    if (!gstack) {
      throw new Error("catalog seed has no gstack pack");
    }
    const original = gstack.install_commands;
    // pins current behavior on a catalog the bundled seed never ships: the
    // import is the same shared object the script reads, so mutate and restore
    Reflect.deleteProperty(gstack, "install_commands");
    try {
      await expect(seedPacks(db, homes, NOW)).rejects.toThrow(
        NO_INSTALL_COMMAND
      );
    } finally {
      gstack.install_commands = original;
    }
  });
});
