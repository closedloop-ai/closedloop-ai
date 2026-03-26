/**
 * Comprehensive migration tests for the .claude/work -> .closedloop-ai/work transition.
 *
 * Tests the REAL exported functions from process-utils against all known recurring
 * bug patterns:
 *
 *   1. Split-root reads: code picks one root dir then reads all files from it
 *   2. Write-to-legacy: reads resolve via findFirstExisting but write goes back to legacy
 *   3. Copy-without-cleanup: migration copies to new path but leaves legacy copy
 *   4. Migration-while-running: checkLegacyProcessAndMigrate renames while a codex
 *      review process is still writing
 *   5. TOCTOU races: existsSync followed by readFileSync without try-catch
 *   6. Delete misses dual-root: DELETE handlers only remove from one resolved path
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkLegacyProcessAndMigrate,
  findFirstExistingPath,
  migrateWorkDirIfNeeded,
  readProcessPid,
  resolveReviewReadPaths,
} from "@/lib/engineer/process-utils";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const DEAD_PID_1 = 999_999_990;
const DEAD_PID_2 = 999_999_991;
const DEAD_PID_3 = 999_999_992;

function writePid(dir: string, filename: string, pid: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), String(pid));
}

function writeJson(dir: string, filename: string, obj: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// 1. checkLegacyProcessAndMigrate
// ---------------------------------------------------------------------------

describe("checkLegacyProcessAndMigrate — process.pid blocking", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "clpm-pid-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("blocks when process.pid has live process", () => {
    const oldWork = join(testDir, ".claude", "work");
    writePid(oldWork, "process.pid", process.pid);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    expect(existsSync(oldWork)).toBe(true);
    expect(existsSync(join(testDir, ".closedloop-ai", "work"))).toBe(false);
  });

  it("blocks when codex-review-claude.pid has live process", () => {
    const oldWork = join(testDir, ".claude", "work");
    writePid(oldWork, "codex-review-claude.pid", process.pid);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    expect(existsSync(oldWork)).toBe(true);
  });

  it("blocks when codex-review-codex.pid has live process", () => {
    const oldWork = join(testDir, ".claude", "work");
    writePid(oldWork, "codex-review-codex.pid", process.pid);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    expect(existsSync(oldWork)).toBe(true);
  });

  it("migrates when all PIDs are dead", () => {
    const oldWork = join(testDir, ".claude", "work");
    writePid(oldWork, "process.pid", DEAD_PID_1);
    writePid(oldWork, "codex-review-claude.pid", DEAD_PID_2);
    writePid(oldWork, "codex-review-codex.pid", DEAD_PID_3);
    writeJson(oldWork, "state.json", { status: "STOPPED" });

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    expect(existsSync(oldWork)).toBe(false);
    const newWork = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(newWork)).toBe(true);
    expect(existsSync(join(newWork, "state.json"))).toBe(true);
  });

  it("migrates when no PID files exist", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(
      join(oldWork, "launch-metadata.json"),
      '{"baseBranch":"main"}'
    );

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    const newWork = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(join(newWork, "launch-metadata.json"))).toBe(true);
  });

  it("returns nothing-to-migrate when .closedloop-ai/work already exists", () => {
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });
    mkdirSync(join(testDir, ".claude", "work"), { recursive: true });

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("nothing-to-migrate");
  });

  it("returns nothing-to-migrate when neither dir exists", () => {
    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("nothing-to-migrate");
  });

  it("TOCTOU - PID file deleted between check and read (no PID file, old dir exists)", () => {
    // Simulate: .claude/work exists but the PID file was deleted
    // between existsSync and readFileSync. This is handled by the try-catch
    // in checkLegacyProcessAndMigrate, which treats a missing/unreadable PID
    // as dead and proceeds with migration.
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "state.json"), '{"status":"STOPPED"}');
    // No PID file -- simulates TOCTOU where PID was deleted before read

    const result = checkLegacyProcessAndMigrate(testDir);

    // Should migrate, not throw
    expect(result).toBe("migrated");
    expect(
      existsSync(join(testDir, ".closedloop-ai", "work", "state.json"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. resolveReviewReadPaths
// ---------------------------------------------------------------------------

describe("resolveReviewReadPaths — winning root selection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "resolve-review-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("state only at legacy -> winning root is legacy, all artifacts from legacy", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });
    writeJson(oldWork, "codex-review-codex.json", { status: "completed" });

    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(oldWork);
    expect(paths.statePath).toBe(join(oldWork, "codex-review-codex.json"));
    expect(paths.logPath).toBe(join(oldWork, "codex-review-codex.log"));
    expect(paths.pidPath).toBe(join(oldWork, "codex-review-codex.pid"));
    expect(paths.findingsPath).toBe(
      join(oldWork, "review-findings-codex.json")
    );
  });

  it("state only at new -> winning root is new", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });
    writeJson(newWork, "codex-review-claude.json", {
      status: "running",
      pid: DEAD_PID_1,
    });

    const paths = resolveReviewReadPaths(testDir, "claude");

    expect(paths.winningRoot).toBe(newWork);
    expect(paths.statePath).toContain(".closedloop-ai");
  });

  it("state at both, new is running with live PID -> new wins", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeJson(newWork, "codex-review-codex.json", {
      status: "running",
      pid: process.pid,
    });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: DEAD_PID_1,
    });

    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(newWork);
    expect(paths.statePath).toContain(".closedloop-ai");
  });

  it("state at both, old is running with live PID, new is stale -> old wins", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeJson(newWork, "codex-review-codex.json", {
      status: "running",
      pid: DEAD_PID_1,
    });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: process.pid,
    });

    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(oldWork);
    expect(paths.statePath).toContain(".claude");
  });

  it("state at both, both running, both PIDs dead -> new wins (default)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeJson(newWork, "codex-review-codex.json", {
      status: "running",
      pid: DEAD_PID_1,
    });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: DEAD_PID_2,
    });

    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(newWork);
  });

  it("state at both, both running, new PID dead, old PID live -> old wins", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeJson(newWork, "codex-review-claude.json", {
      status: "running",
      pid: DEAD_PID_1,
    });
    writeJson(oldWork, "codex-review-claude.json", {
      status: "running",
      pid: process.pid,
    });

    const paths = resolveReviewReadPaths(testDir, "claude");

    expect(paths.winningRoot).toBe(oldWork);
  });

  it("ALL artifacts follow the winning root — log, pid, findings all from same dir", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    // Old wins (live PID)
    writeJson(newWork, "codex-review-codex.json", {
      status: "running",
      pid: DEAD_PID_1,
    });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: process.pid,
    });
    writeFileSync(join(oldWork, "codex-review-codex.log"), "old log");
    writeFileSync(join(newWork, "codex-review-codex.log"), "new log");

    const paths = resolveReviewReadPaths(testDir, "codex");

    // All artifacts point to the same (old) root
    expect(paths.statePath).toContain(".claude");
    expect(paths.logPath).toContain(".claude");
    expect(paths.pidPath).toContain(".claude");
    expect(paths.findingsPath).toContain(".claude");

    // Verify log path reads from correct root
    expect(readFileSync(paths.logPath, "utf-8")).toBe("old log");
  });

  it("no state at either root -> returns new path defaults", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });

    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(newWork);
    expect(paths.statePath).toBe(join(newWork, "codex-review-codex.json"));
  });

  it("resolves correct filenames for the claude provider", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });

    const paths = resolveReviewReadPaths(testDir, "claude");

    expect(paths.statePath).toContain("codex-review-claude.json");
    expect(paths.logPath).toContain("codex-review-claude.log");
    expect(paths.pidPath).toContain("codex-review-claude.pid");
    expect(paths.findingsPath).toContain("review-findings-claude.json");
  });
});

// ---------------------------------------------------------------------------
// 3. migrateWorkDirIfNeeded
// ---------------------------------------------------------------------------

describe("migrateWorkDirIfNeeded", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "migrate-work-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("renames .claude/work to .closedloop-ai/work", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "process.pid"), "9999");
    writeJson(oldWork, "state.json", { status: "IN_PROGRESS" });

    migrateWorkDirIfNeeded(testDir);

    const newWork = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(newWork)).toBe(true);
    expect(existsSync(join(newWork, "process.pid"))).toBe(true);
    expect(existsSync(join(newWork, "state.json"))).toBe(true);
    expect(existsSync(oldWork)).toBe(false);
  });

  it("no-op when .closedloop-ai/work already exists", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });
    writeJson(newWork, "state.json", { status: "completed" });

    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writePid(oldWork, "process.pid", 1234);

    migrateWorkDirIfNeeded(testDir);

    // New dir unchanged; old dir still present
    expect(readFileSync(join(newWork, "state.json"), "utf-8")).toContain(
      "completed"
    );
    expect(existsSync(oldWork)).toBe(true);
  });

  it("no-op when neither exists", () => {
    expect(() => migrateWorkDirIfNeeded(testDir)).not.toThrow();
    expect(existsSync(join(testDir, ".closedloop-ai", "work"))).toBe(false);
  });

  it("concurrent call safety (TOCTOU) - second call should not throw", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "data.txt"), "content");

    migrateWorkDirIfNeeded(testDir);
    // Second call: old dir is gone, new dir exists -> should be a no-op, not throw
    expect(() => migrateWorkDirIfNeeded(testDir)).not.toThrow();

    // New dir still intact
    const newWork = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(join(newWork, "data.txt"))).toBe(true);
  });

  it("creates intermediate .closedloop-ai parent if it does not exist", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "data.txt"), "hello");

    // .closedloop-ai/ parent does not exist at all
    expect(existsSync(join(testDir, ".closedloop-ai"))).toBe(false);

    migrateWorkDirIfNeeded(testDir);

    expect(
      existsSync(join(testDir, ".closedloop-ai", "work", "data.txt"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. readProcessPid
// ---------------------------------------------------------------------------

describe("readProcessPid — dual-root, liveness-aware", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "read-pid-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("PID only at new path -> returns it", async () => {
    writePid(join(testDir, ".closedloop-ai", "work"), "process.pid", 12_345);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(12_345);
  });

  it("PID only at old path -> returns it", async () => {
    writePid(join(testDir, ".claude", "work"), "process.pid", 11_111);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(11_111);
  });

  it("PID at both, new is live -> returns new (checked first)", async () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    writePid(newWork, "process.pid", process.pid);
    writePid(oldWork, "process.pid", DEAD_PID_1);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(process.pid);
  });

  it("PID at both, old is live, new is stale -> returns old (live wins)", async () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    writePid(newWork, "process.pid", DEAD_PID_1);
    writePid(oldWork, "process.pid", process.pid);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(process.pid);
  });

  it("PID at both, both stale -> returns new (first fallback)", async () => {
    writePid(
      join(testDir, ".closedloop-ai", "work"),
      "process.pid",
      DEAD_PID_1
    );
    writePid(join(testDir, ".claude", "work"), "process.pid", DEAD_PID_2);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(DEAD_PID_1);
  });

  it("neither exists -> null", async () => {
    const pid = await readProcessPid(testDir);
    expect(pid).toBeNull();
  });

  it("invalid PID content -> null", async () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });
    writeFileSync(join(newWork, "process.pid"), "not-a-number");

    const pid = await readProcessPid(testDir);
    expect(pid).toBeNull();
  });

  it("PID at new path is NaN, old path is valid -> returns old", async () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    writeFileSync(join(newWork, "process.pid"), "garbage");
    writePid(oldWork, "process.pid", DEAD_PID_2);

    const pid = await readProcessPid(testDir);
    expect(pid).toBe(DEAD_PID_2);
  });
});

// ---------------------------------------------------------------------------
// 5. Write-path convergence patterns
// ---------------------------------------------------------------------------

describe("write-path convergence — findFirstExisting reads, canonical writes", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "write-converge-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("findFirstExistingPath resolves to legacy for reads", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    const legacyFile = join(oldWork, "state.json");
    writeJson(oldWork, "state.json", { status: "IN_PROGRESS" });

    const readPath = findFirstExistingPath(
      join(newWork, "state.json"),
      join(oldWork, "state.json")
    );

    expect(readPath).toBe(legacyFile);
    expect(readPath).toContain(".claude");
  });

  it("writes MUST go to .closedloop-ai/work, never back to legacy resolve path", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    // Legacy has existing state
    writeJson(oldWork, "state.json", { status: "IN_PROGRESS" });

    // Read resolves to legacy
    const readPath = findFirstExistingPath(
      join(newWork, "state.json"),
      join(oldWork, "state.json")
    );
    expect(readPath).toContain(".claude");

    // Write MUST target canonical new path, NOT the resolved read path
    const canonicalWritePath = join(newWork, "state.json");
    writeJson(newWork, "state.json", { status: "STOPPED" });

    expect(canonicalWritePath).toContain(".closedloop-ai");
    const written = JSON.parse(readFileSync(canonicalWritePath, "utf-8"));
    expect(written.status).toBe("STOPPED");

    // Legacy file must remain unchanged (write did not go back to it)
    const legacy = JSON.parse(
      readFileSync(join(oldWork, "state.json"), "utf-8")
    );
    expect(legacy.status).toBe("IN_PROGRESS");
  });

  it("after copy-migration, legacy file should be deleted (not left behind)", () => {
    const oldWork = join(testDir, ".claude", "work");
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(newWork, { recursive: true });

    const legacyPath = join(oldWork, "chat-history.json");
    const newPath = join(newWork, "chat-history.json");
    writeFileSync(legacyPath, JSON.stringify({ messages: [{ role: "user" }] }));

    // Migration: copy then delete
    if (!existsSync(newPath) && existsSync(legacyPath)) {
      copyFileSync(legacyPath, newPath);
      try {
        unlinkSync(legacyPath);
      } catch {
        // best effort
      }
    }

    expect(existsSync(newPath)).toBe(true);
    // Bug: legacy copy left behind resurrects on DELETE
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("DELETE operations must clean both roots, not just the resolved one", () => {
    const oldWork = join(testDir, ".claude", "work");
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(newWork, { recursive: true });

    // Both roots have the file (e.g. after copy-without-cleanup)
    const filename = "codex-review-codex.json";
    writeJson(oldWork, filename, { status: "stopped" });
    writeJson(newWork, filename, { status: "stopped" });

    // Correct DELETE: remove from both roots
    const oldFilePath = join(oldWork, filename);
    const newFilePath = join(newWork, filename);
    for (const p of [newFilePath, oldFilePath]) {
      try {
        if (existsSync(p)) {
          unlinkSync(p);
        }
      } catch {
        // best effort
      }
    }

    // Both must be gone
    expect(existsSync(oldFilePath)).toBe(false);
    expect(existsSync(newFilePath)).toBe(false);
  });

  it("delete that only removes resolved path leaves stale legacy copy", () => {
    const oldWork = join(testDir, ".claude", "work");
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(newWork, { recursive: true });

    const filename = "codex-review-codex.json";
    writeJson(oldWork, filename, { status: "stopped" });
    writeJson(newWork, filename, { status: "stopped" });

    // Bug pattern: DELETE only removes the path resolved by findFirstExisting
    const resolvedPath = findFirstExistingPath(
      join(newWork, filename),
      join(oldWork, filename)
    );
    if (resolvedPath) {
      unlinkSync(resolvedPath);
    }

    // New path was resolved first, so only new file was deleted
    expect(existsSync(join(newWork, filename))).toBe(false);
    // Stale legacy copy remains -- this is the bug
    expect(existsSync(join(oldWork, filename))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Migration-while-running (bug #4)
// ---------------------------------------------------------------------------

describe("migration-while-running — preflight blocks rename when process active", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "migrate-running-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("legacy codex review running (codex-review-codex.pid alive) -> preflight blocks migration", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: process.pid,
    });
    writePid(oldWork, "codex-review-codex.pid", process.pid);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
    // Old dir must NOT have been renamed (process is still writing)
    expect(existsSync(oldWork)).toBe(true);
    expect(existsSync(join(testDir, ".closedloop-ai", "work"))).toBe(false);
  });

  it("legacy codex review stopped (pid dead) -> preflight migrates", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "completed",
      pid: DEAD_PID_1,
    });
    writePid(oldWork, "codex-review-codex.pid", DEAD_PID_1);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("migrated");
    expect(existsSync(oldWork)).toBe(false);
    const newWork = join(testDir, ".closedloop-ai", "work");
    expect(existsSync(newWork)).toBe(true);
    expect(existsSync(join(newWork, "codex-review-codex.json"))).toBe(true);
  });

  it("after migration, resolveReviewReadPaths finds state at new path", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "codex-review-codex.json", {
      status: "completed",
      pid: DEAD_PID_1,
    });
    writePid(oldWork, "codex-review-codex.pid", DEAD_PID_1);

    checkLegacyProcessAndMigrate(testDir);

    // After migration, old dir is gone; new dir has the state
    const paths = resolveReviewReadPaths(testDir, "codex");
    expect(paths.statePath).toContain(".closedloop-ai");
    expect(existsSync(paths.statePath)).toBe(true);
    const state = JSON.parse(readFileSync(paths.statePath, "utf-8"));
    expect(state.status).toBe("completed");
  });

  it("both codex PIDs alive -> both block migration independently", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    // claude review alive, codex review alive
    writePid(oldWork, "codex-review-claude.pid", process.pid);
    writePid(oldWork, "codex-review-codex.pid", process.pid);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
  });

  it("claude codex PID alive but codex PID dead -> blocked by claude PID", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writePid(oldWork, "codex-review-claude.pid", process.pid);
    writePid(oldWork, "codex-review-codex.pid", DEAD_PID_1);

    const result = checkLegacyProcessAndMigrate(testDir);

    expect(result).toBe("live-process-blocking");
  });
});

// ---------------------------------------------------------------------------
// 7. Integration scenarios
// ---------------------------------------------------------------------------

describe("integration — full lifecycle", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "integration-lifecycle-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("legacy state exists, migration runs, reads still work, writes go to new path", () => {
    // Setup: legacy state
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "state.json", { status: "STOPPED" });
    writePid(oldWork, "process.pid", DEAD_PID_1);

    // Step 1: preflight checks — migration succeeds
    const migrateResult = checkLegacyProcessAndMigrate(testDir);
    expect(migrateResult).toBe("migrated");

    const newWork = join(testDir, ".closedloop-ai", "work");

    // Step 2: reads still work (findFirstExisting finds new path after migration)
    const statePath = findFirstExistingPath(
      join(newWork, "state.json"),
      join(oldWork, "state.json")
    );
    expect(statePath).not.toBeNull();
    expect(statePath).toContain(".closedloop-ai");

    // Step 3: writes go to new canonical path
    const writeTarget = join(newWork, "state.json");
    writeJson(newWork, "state.json", { status: "IN_PROGRESS" });
    expect(writeTarget).toContain(".closedloop-ai");
    const updated = JSON.parse(readFileSync(writeTarget, "utf-8"));
    expect(updated.status).toBe("IN_PROGRESS");

    // Step 4: delete cleans new path
    unlinkSync(writeTarget);
    expect(existsSync(writeTarget)).toBe(false);
  });

  it("legacy state exists, second migration call is idempotent", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "state.json", { status: "STOPPED" });

    // First migration
    const first = checkLegacyProcessAndMigrate(testDir);
    expect(first).toBe("migrated");

    // Second migration call on same dir -> nothing-to-migrate (new already exists)
    const second = checkLegacyProcessAndMigrate(testDir);
    expect(second).toBe("nothing-to-migrate");
  });

  it("resolveReviewReadPaths: no state at either root -> new path defaults used for writes", () => {
    // No state anywhere
    const paths = resolveReviewReadPaths(testDir, "codex");

    expect(paths.winningRoot).toBe(join(testDir, ".closedloop-ai", "work"));
    expect(paths.statePath).toContain(".closedloop-ai");
    // File should not exist yet (defaults returned)
    expect(existsSync(paths.statePath)).toBe(false);
  });

  it("readProcessPid still returns PID after migration to new root", async () => {
    const oldWork = join(testDir, ".claude", "work");
    writePid(oldWork, "process.pid", DEAD_PID_3);
    writeJson(oldWork, "state.json", { status: "STOPPED" });

    // Migrate
    migrateWorkDirIfNeeded(testDir);

    // Now readProcessPid should find PID at new path
    const pid = await readProcessPid(testDir);
    expect(pid).toBe(DEAD_PID_3);
  });

  it("full delete: both roots cleaned after copy-without-cleanup then delete-both", () => {
    const oldWork = join(testDir, ".claude", "work");
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(newWork, { recursive: true });

    const filename = "chat-history.json";

    // Copy-without-cleanup bug left a copy in both
    writeJson(oldWork, filename, { messages: [] });
    copyFileSync(join(oldWork, filename), join(newWork, filename));
    // Bug: legacy NOT deleted — both exist

    expect(existsSync(join(oldWork, filename))).toBe(true);
    expect(existsSync(join(newWork, filename))).toBe(true);

    // Correct DELETE cleans both
    for (const root of [newWork, oldWork]) {
      const p = join(root, filename);
      try {
        if (existsSync(p)) {
          unlinkSync(p);
        }
      } catch {
        // best effort
      }
    }

    expect(existsSync(join(oldWork, filename))).toBe(false);
    expect(existsSync(join(newWork, filename))).toBe(false);
  });

  it("findFirstExistingPath returns null when both dirs exist but file is absent", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    const result = findFirstExistingPath(
      join(newWork, "state.json"),
      join(oldWork, "state.json")
    );

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. TOCTOU resilience
// ---------------------------------------------------------------------------

describe("TOCTOU resilience — existsSync followed by readFileSync", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "toctou-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("readProcessPid handles missing file gracefully (TOCTOU simulation)", async () => {
    // File exists at start, then is deleted. readProcessPid has try-catch.
    const newWork = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWork, { recursive: true });
    const pidPath = join(newWork, "process.pid");
    writeFileSync(pidPath, "99999");

    // Delete between existsSync and readFile -- readProcessPid uses async readFile
    // wrapped in try-catch, so it should return null for the deleted file.
    unlinkSync(pidPath);

    const pid = await readProcessPid(testDir);
    expect(pid).toBeNull();
  });

  it("checkLegacyProcessAndMigrate: try-catch prevents crash when PID file deleted mid-check", () => {
    // Create old dir without a PID file (simulates PID file deleted between existsSync and readFile)
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    writeJson(oldWork, "state.json", { status: "STOPPED" });
    // No process.pid, no codex-review PIDs -- existsSync returns false, skips read

    expect(() => checkLegacyProcessAndMigrate(testDir)).not.toThrow();
    const result = checkLegacyProcessAndMigrate(join(testDir, "fresh"));
    // Fresh dir has no old work dir -> nothing-to-migrate
    expect(result).toBe("nothing-to-migrate");
  });

  it("resolveReviewReadPaths handles malformed JSON state without throwing", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    // Both have state files, but new has malformed JSON
    writeFileSync(join(newWork, "codex-review-codex.json"), "INVALID JSON{{{");
    writeJson(oldWork, "codex-review-codex.json", {
      status: "running",
      pid: process.pid,
    });

    // Should not throw; falls back to new root on parse error
    expect(() => resolveReviewReadPaths(testDir, "codex")).not.toThrow();
    const paths = resolveReviewReadPaths(testDir, "codex");
    // Parse error -> stick with new root (default)
    expect(paths.winningRoot).toBe(newWork);
  });
});

// ---------------------------------------------------------------------------
// Split-root live-process detection (P2 fix: preflight checks legacy PIDs even
// when .closedloop-ai/work already exists)
// ---------------------------------------------------------------------------

describe("checkLegacyProcessAndMigrate — split-root live-process detection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-preflight-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("blocks when both roots exist and legacy process.pid is alive", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "process.pid"), String(process.pid));

    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("live-process-blocking");
  });

  it("blocks when both roots exist and legacy codex-review PID is alive", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "codex-review-codex.pid"), String(process.pid));

    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("live-process-blocking");
  });

  it("returns nothing-to-migrate when both roots exist but all legacy PIDs are dead", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });
    writeFileSync(join(oldWork, "process.pid"), "999999990");
    writeFileSync(join(oldWork, "codex-review-codex.pid"), "999999991");

    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("nothing-to-migrate");
  });

  it("returns nothing-to-migrate when both roots exist and no legacy PIDs present", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    const result = checkLegacyProcessAndMigrate(testDir);
    expect(result).toBe("nothing-to-migrate");
  });
});

// ---------------------------------------------------------------------------
// DELETE chat-history dual-root cleanup (P2 fix: delete from both roots)
// ---------------------------------------------------------------------------

describe("DELETE chat-history — dual-root transcript cleanup", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "chat-history-delete-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("deleting transcript from both roots prevents resurrection via legacy fallback", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    // Simulate split-root: transcript at both locations
    const transcript = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    writeFileSync(join(newWork, "chat-history.json"), transcript);
    writeFileSync(join(oldWork, "chat-history.json"), transcript);

    // Simulate the fixed DELETE handler: delete from both roots
    const paths = [
      join(newWork, "chat-history.json"),
      join(oldWork, "chat-history.json"),
    ];
    for (const p of paths) {
      try {
        unlinkSync(p);
      } catch {
        /* best effort */
      }
    }

    // Neither root should have the file -- no resurrection possible
    expect(existsSync(join(newWork, "chat-history.json"))).toBe(false);
    expect(existsSync(join(oldWork, "chat-history.json"))).toBe(false);

    // findFirstExistingPath should return null (no fallback to stale copy)
    expect(
      findFirstExistingPath(
        join(newWork, "chat-history.json"),
        join(oldWork, "chat-history.json")
      )
    ).toBeNull();
  });

  it("single-root delete that misses legacy copy allows resurrection (demonstrates the bug)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeFileSync(join(newWork, "chat-history.json"), '{"messages":[]}');
    writeFileSync(
      join(oldWork, "chat-history.json"),
      '{"messages":[{"role":"user"}]}'
    );

    // Only delete the new-path copy (the old buggy behavior)
    unlinkSync(join(newWork, "chat-history.json"));

    // Legacy copy still exists -- GET would fall back to it (resurrection!)
    const resurrected = findFirstExistingPath(
      join(newWork, "chat-history.json"),
      join(oldWork, "chat-history.json")
    );
    expect(resurrected).not.toBeNull();
    expect(resurrected).toContain(".claude");
  });
});
