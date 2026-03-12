import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLaunchLock,
  isProcessRunning,
  readLaunchMetadata,
  readProcessPid,
  releaseLaunchLock,
  writeLaunchMetadata,
} from "@/lib/engineer/process-utils";

/**
 * Integration-style tests for the launch idempotency logic.
 * These test the state transitions and metadata ordering that the
 * launch route orchestrates, using the shared process-utils functions.
 */
describe("launch-idempotency", () => {
  let testDir: string;
  let worktreeDir: string;
  let lockDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `launch-idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    worktreeDir = join(testDir, "myrepo-AI_100");
    lockDir = join(testDir, ".closedloop-ai", "locks", "myrepo-AI_100");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("live PID returns alreadyRunning with metadata, does NOT re-spawn", async () => {
    // Simulate existing worktree with live process
    const claudeWorkDir = join(worktreeDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(join(claudeWorkDir, "process.pid"), String(process.pid));
    writeLaunchMetadata(worktreeDir, {
      baseBranch: "main",
      parentTicketId: "AI-50",
    });

    // Check PID liveness (fast path)
    const pid = await readProcessPid(worktreeDir);
    expect(pid).toBe(process.pid);
    expect(isProcessRunning(pid!)).toBe(true);

    // Read metadata for alreadyRunning response
    const meta = readLaunchMetadata(worktreeDir);
    expect(meta).toEqual({ baseBranch: "main", parentTicketId: "AI-50" });
  });

  it("live PID + missing launch-metadata.json (legacy) returns undefined metadata", async () => {
    // Simulate legacy worktree (no launch-metadata.json)
    const claudeWorkDir = join(worktreeDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(join(claudeWorkDir, "process.pid"), String(process.pid));

    const pid = await readProcessPid(worktreeDir);
    expect(pid).toBe(process.pid);
    expect(isProcessRunning(pid!)).toBe(true);

    const meta = readLaunchMetadata(worktreeDir);
    expect(meta).toBeNull();
  });

  it("dead PID allows re-spawn, writes metadata then PID (ordering)", async () => {
    const claudeWorkDir = join(worktreeDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(join(claudeWorkDir, "process.pid"), "999999999");

    // Dead PID detected
    const pid = await readProcessPid(worktreeDir);
    expect(pid).toBe(999_999_999);
    expect(isProcessRunning(pid!)).toBe(false);

    // Acquire lock (simulating the launch handler)
    const lock = acquireLaunchLock(lockDir);
    expect(lock).not.toBeNull();

    try {
      // Write metadata BEFORE PID (ordering guarantee)
      writeLaunchMetadata(worktreeDir, { baseBranch: "develop" });

      // Verify metadata written before we write PID
      const metaBefore = readLaunchMetadata(worktreeDir);
      expect(metaBefore?.baseBranch).toBe("develop");

      // Simulate PID write (after spawn)
      const newPid = 42;
      writeFileSync(join(claudeWorkDir, "process.pid"), String(newPid));

      const finalPid = await readProcessPid(worktreeDir);
      expect(finalPid).toBe(42);
    } finally {
      releaseLaunchLock(lockDir, lock!.fd);
    }
  });

  it("no PID file allows spawn, writes metadata then PID", async () => {
    const claudeWorkDir = join(worktreeDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    // No process.pid file

    const pid = await readProcessPid(worktreeDir);
    expect(pid).toBeNull();

    const lock = acquireLaunchLock(lockDir);
    expect(lock).not.toBeNull();

    try {
      writeLaunchMetadata(worktreeDir, {
        baseBranch: "main",
        parentTicketId: "AI-200",
      });
      writeFileSync(join(claudeWorkDir, "process.pid"), "55555");

      const meta = readLaunchMetadata(worktreeDir);
      expect(meta?.baseBranch).toBe("main");
      expect(meta?.parentTicketId).toBe("AI-200");
    } finally {
      releaseLaunchLock(lockDir, lock!.fd);
    }
  });

  it("relaunch preserves existing metadata when new values are undefined", () => {
    // First launch sets metadata
    writeLaunchMetadata(worktreeDir, {
      baseBranch: "feature/AI-50",
      parentTicketId: "AI-50",
    });

    // Relaunch with undefined values (existing worktree path)
    writeLaunchMetadata(worktreeDir, {
      baseBranch: undefined,
      parentTicketId: undefined,
    });

    const meta = readLaunchMetadata(worktreeDir);
    expect(meta).toEqual({
      baseBranch: "feature/AI-50",
      parentTicketId: "AI-50",
    });
  });

  it("lock contention returns null (would be 409)", () => {
    const lock1 = acquireLaunchLock(lockDir);
    expect(lock1).not.toBeNull();

    const lock2 = acquireLaunchLock(lockDir);
    expect(lock2).toBeNull();

    releaseLaunchLock(lockDir, lock1!.fd);
  });
});
