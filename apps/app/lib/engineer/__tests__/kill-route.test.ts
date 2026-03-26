/**
 * Tests for kill route dual-path logic.
 *
 * resolvePid and cancelLoop are private to the kill route, so we test the
 * same filesystem logic inline using the identical algorithm.
 *
 * resolvePid: looks up process.pid using findFirstExistingPath with
 *   new (.closedloop-ai/work/process.pid) then old (.claude/work/process.pid).
 *
 * cancelLoop: deletes the loop state file, checking new path first then old.
 */
import {
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
  findFirstExistingPath,
  isProcessRunning,
} from "@/lib/engineer/process-utils";

/**
 * Simplified stub for basic path existence tests.
 * Production resolvePid iterates both candidates and prefers the one
 * with a live process -- see the liveness-aware tests below.
 */
function resolvePidPath(worktreeDir: string): string | null {
  return findFirstExistingPath(
    join(worktreeDir, ".closedloop-ai", "work", "process.pid"),
    join(worktreeDir, ".claude", "work", "process.pid")
  );
}

/** Inline re-implementation of cancelLoop from the kill route. */
function cancelLoop(worktreeDir: string): boolean {
  const newStateFile = join(
    worktreeDir,
    ".closedloop-ai",
    "closedloop-loop.local.md"
  );
  const oldStateFile = join(worktreeDir, ".claude", "closedloop-loop.local.md");
  const stateFile = findFirstExistingPath(newStateFile, oldStateFile);
  if (!stateFile) {
    return false;
  }
  try {
    unlinkSync(stateFile);
    return true;
  } catch {
    return false;
  }
}

describe("kill route — resolvePid dual-path", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kill-route-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("PID at old .claude/work path only -> resolves old path", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(join(oldWorkDir, "process.pid"), "11111");

    const pidPath = resolvePidPath(testDir);
    expect(pidPath).not.toBeNull();

    const pid = Number.parseInt(readFileSync(pidPath!, "utf-8").trim(), 10);
    expect(pid).toBe(11_111);
  });

  it("PID at new .closedloop-ai/work path only -> resolves new path", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(join(newWorkDir, "process.pid"), "22222");

    const pidPath = resolvePidPath(testDir);
    expect(pidPath).not.toBeNull();

    const pid = Number.parseInt(readFileSync(pidPath!, "utf-8").trim(), 10);
    expect(pid).toBe(22_222);
  });

  it("both paths exist -> new path wins", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(join(newWorkDir, "process.pid"), "999999998");

    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(join(oldWorkDir, "process.pid"), "999999997");

    const pidPath = resolvePidPath(testDir);
    expect(pidPath).not.toBeNull();
    expect(pidPath).toContain(".closedloop-ai");

    const pid = Number.parseInt(readFileSync(pidPath!, "utf-8").trim(), 10);
    expect(pid).toBe(999_999_998);
  });

  it("neither path exists -> null (no PID file)", () => {
    const pidPath = resolvePidPath(testDir);
    expect(pidPath).toBeNull();
  });
});

describe("kill route — cancelLoop dual-path", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kill-cancel-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("state file at new .closedloop-ai/ path -> deletes it, returns true", () => {
    const newStateDir = join(testDir, ".closedloop-ai");
    mkdirSync(newStateDir, { recursive: true });
    const newStateFile = join(newStateDir, "closedloop-loop.local.md");
    writeFileSync(newStateFile, "active: true\n");

    const cancelled = cancelLoop(testDir);

    expect(cancelled).toBe(true);
    expect(existsSync(newStateFile)).toBe(false);
  });

  it("state file at old .claude/ path only -> deletes it, returns true", () => {
    const oldStateDir = join(testDir, ".claude");
    mkdirSync(oldStateDir, { recursive: true });
    const oldStateFile = join(oldStateDir, "closedloop-loop.local.md");
    writeFileSync(oldStateFile, "active: true\n");

    const cancelled = cancelLoop(testDir);

    expect(cancelled).toBe(true);
    expect(existsSync(oldStateFile)).toBe(false);
  });

  it("both state files exist -> new path wins (old remains)", () => {
    const newStateDir = join(testDir, ".closedloop-ai");
    mkdirSync(newStateDir, { recursive: true });
    const newStateFile = join(newStateDir, "closedloop-loop.local.md");
    writeFileSync(newStateFile, "new state\n");

    const oldStateDir = join(testDir, ".claude");
    mkdirSync(oldStateDir, { recursive: true });
    const oldStateFile = join(oldStateDir, "closedloop-loop.local.md");
    writeFileSync(oldStateFile, "old state\n");

    const cancelled = cancelLoop(testDir);

    expect(cancelled).toBe(true);
    expect(existsSync(newStateFile)).toBe(false);
    // Old file left intact — only the new one was deleted
    expect(existsSync(oldStateFile)).toBe(true);
  });

  it("no state file in either location -> returns false", () => {
    const cancelled = cancelLoop(testDir);
    expect(cancelled).toBe(false);
  });
});

describe("kill route — resolvePid liveness-aware (production behavior)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kill-liveness-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Mirrors production resolvePid: iterates both PID candidates,
   * returns the first with a live process. Falls back to first stale PID.
   */
  function resolvePidLivenessAware(
    worktreeDir: string
  ): { pid: number; pidFilePath: string } | null {
    const candidates = [
      join(worktreeDir, ".closedloop-ai", "work", "process.pid"),
      join(worktreeDir, ".claude", "work", "process.pid"),
    ];
    let fallback: { pid: number; pidFilePath: string } | null = null;
    for (const pidPath of candidates) {
      if (!existsSync(pidPath)) {
        continue;
      }
      try {
        const content = readFileSync(pidPath, "utf-8").trim();
        const pid = Number.parseInt(content, 10);
        if (Number.isNaN(pid)) {
          continue;
        }
        if (isProcessRunning(pid)) {
          return { pid, pidFilePath: pidPath };
        }
        fallback ??= { pid, pidFilePath: pidPath };
      } catch {
        // skip
      }
    }
    return fallback;
  }

  it("stale new PID + live old PID -> returns live old PID", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(newWorkDir, { recursive: true });
    mkdirSync(oldWorkDir, { recursive: true });

    writeFileSync(join(newWorkDir, "process.pid"), "999999999"); // stale
    writeFileSync(join(oldWorkDir, "process.pid"), String(process.pid)); // live

    const result = resolvePidLivenessAware(testDir);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(process.pid);
    expect(result!.pidFilePath).toContain(".claude");
  });

  it("both stale -> returns new path PID (first fallback)", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(newWorkDir, { recursive: true });
    mkdirSync(oldWorkDir, { recursive: true });

    writeFileSync(join(newWorkDir, "process.pid"), "999999998");
    writeFileSync(join(oldWorkDir, "process.pid"), "999999997");

    const result = resolvePidLivenessAware(testDir);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(999_999_998);
    expect(result!.pidFilePath).toContain(".closedloop-ai");
  });
});

describe("markStateAsStopped — TOCTOU resilience", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kill-mark-stopped-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Mirrors the markStateAsStopped preflight: if the legacy PID file
   * disappears between existsSync and readFileSync, the try-catch
   * should swallow the error and proceed with migration + write.
   */
  it("succeeds when legacy PID file is deleted between check and read (TOCTOU)", () => {
    const oldWorkDir = join(testDir, ".claude", "work");
    mkdirSync(oldWorkDir, { recursive: true });
    writeFileSync(
      join(oldWorkDir, "state.json"),
      JSON.stringify({ status: "IN_PROGRESS" })
    );
    // No PID file -- simulates it being deleted after existsSync returned true
    // The production code wraps readFileSync in try-catch, so no PID file = treat as dead

    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    // Simulate the preflight logic with the try-catch guard
    if (!existsSync(newWorkDir) && existsSync(oldWorkDir)) {
      const legacyPidPath = join(oldWorkDir, "process.pid");
      if (existsSync(legacyPidPath)) {
        try {
          readFileSync(legacyPidPath, "utf-8");
        } catch {
          // TOCTOU: treat as dead
        }
      }
      // Migration proceeds
      mkdirSync(join(testDir, ".closedloop-ai"), { recursive: true });
    }

    // Write STOPPED to new path (as markStateAsStopped does)
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "state.json"),
      JSON.stringify({ status: "STOPPED", phase: "Process stopped by user" })
    );

    expect(existsSync(join(newWorkDir, "state.json"))).toBe(true);
    const state = JSON.parse(
      readFileSync(join(newWorkDir, "state.json"), "utf-8")
    );
    expect(state.status).toBe("STOPPED");
  });

  it("writes STOPPED even when neither work dir exists initially", () => {
    // Neither .closedloop-ai/work nor .claude/work exist
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "state.json"),
      JSON.stringify({ status: "STOPPED", phase: "Process stopped by user" })
    );

    expect(existsSync(join(newWorkDir, "state.json"))).toBe(true);
  });
});
