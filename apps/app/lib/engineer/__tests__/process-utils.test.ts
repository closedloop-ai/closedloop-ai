import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLaunchLock,
  cleanStaleLock,
  getReviewPaths,
  isProcessRunning,
  readLaunchMetadata,
  readProcessPid,
  releaseLaunchLock,
  writeLaunchMetadata,
} from "@/lib/engineer/process-utils";

describe("process-utils", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `process-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("readProcessPid", () => {
    it("returns null when process.pid file is missing", async () => {
      const pid = await readProcessPid(testDir);
      expect(pid).toBeNull();
    });

    it("returns parsed PID from valid file", async () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "process.pid"), "12345");

      const pid = await readProcessPid(testDir);
      expect(pid).toBe(12_345);
    });

    it("returns null for non-numeric content", async () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "process.pid"), "not-a-pid");

      const pid = await readProcessPid(testDir);
      expect(pid).toBeNull();
    });

    it("returns null for empty file", async () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "process.pid"), "");

      const pid = await readProcessPid(testDir);
      expect(pid).toBeNull();
    });

    it("trims whitespace from PID file", async () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "process.pid"), "  54321\n");

      const pid = await readProcessPid(testDir);
      expect(pid).toBe(54_321);
    });
  });

  describe("isProcessRunning", () => {
    it("returns true for own process (self-check)", () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it("returns false for a non-existent PID", () => {
      expect(isProcessRunning(999_999_999)).toBe(false);
    });
  });

  describe("readLaunchMetadata", () => {
    it("returns null when file is missing", () => {
      const meta = readLaunchMetadata(testDir);
      expect(meta).toBeNull();
    });

    it("returns baseBranch and parentTicketId from valid file", () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(workDir, "launch-metadata.json"),
        JSON.stringify({ baseBranch: "main", parentTicketId: "AI-100" })
      );

      const meta = readLaunchMetadata(testDir);
      expect(meta).toEqual({ baseBranch: "main", parentTicketId: "AI-100" });
    });

    it("returns null for malformed JSON", () => {
      const workDir = join(testDir, ".closedloop-ai", "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "launch-metadata.json"), "not json");

      const meta = readLaunchMetadata(testDir);
      expect(meta).toBeNull();
    });
  });

  describe("writeLaunchMetadata", () => {
    it("writes launch-metadata.json and creates .closedloop-ai/work dir if needed", () => {
      writeLaunchMetadata(testDir, { baseBranch: "develop" });

      const metaPath = join(
        testDir,
        ".closedloop-ai",
        "work",
        "launch-metadata.json"
      );
      expect(existsSync(metaPath)).toBe(true);
      const content = JSON.parse(readFileSync(metaPath, "utf-8"));
      expect(content.baseBranch).toBe("develop");
    });

    it("merges with existing metadata (undefined values fall back)", () => {
      writeLaunchMetadata(testDir, {
        baseBranch: "main",
        parentTicketId: "AI-50",
      });
      writeLaunchMetadata(testDir, {
        baseBranch: undefined,
        parentTicketId: undefined,
      });

      const meta = readLaunchMetadata(testDir);
      expect(meta).toEqual({ baseBranch: "main", parentTicketId: "AI-50" });
    });

    it("overrides existing values when new values are defined", () => {
      writeLaunchMetadata(testDir, {
        baseBranch: "main",
        parentTicketId: "AI-50",
      });
      writeLaunchMetadata(testDir, { baseBranch: "develop" });

      const meta = readLaunchMetadata(testDir);
      expect(meta).toEqual({ baseBranch: "develop", parentTicketId: "AI-50" });
    });
  });

  describe("acquireLaunchLock", () => {
    it("returns fd on first call", () => {
      const lockDir = join(testDir, "locks");
      const result = acquireLaunchLock(lockDir);
      expect(result).not.toBeNull();
      expect(typeof result!.fd).toBe("number");

      // Clean up
      releaseLaunchLock(lockDir, result!.fd);
    });

    it("returns null on second concurrent call (EEXIST)", () => {
      const lockDir = join(testDir, "locks");
      const first = acquireLaunchLock(lockDir);
      expect(first).not.toBeNull();

      const second = acquireLaunchLock(lockDir);
      expect(second).toBeNull();

      // Clean up
      releaseLaunchLock(lockDir, first!.fd);
    });

    it("lock file records pid and timestamp as JSON", () => {
      const lockDir = join(testDir, "locks");
      const result = acquireLaunchLock(lockDir);
      expect(result).not.toBeNull();

      const lockContent = JSON.parse(
        readFileSync(join(lockDir, "launch.lock"), "utf-8")
      );
      expect(lockContent.pid).toBe(process.pid);
      expect(typeof lockContent.timestamp).toBe("number");

      releaseLaunchLock(lockDir, result!.fd);
    });

    it("creates lock dir automatically if it doesn't exist", () => {
      const lockDir = join(testDir, "deep", "nested", "locks");
      const result = acquireLaunchLock(lockDir);
      expect(result).not.toBeNull();
      expect(existsSync(lockDir)).toBe(true);

      releaseLaunchLock(lockDir, result!.fd);
    });
  });

  describe("releaseLaunchLock", () => {
    it("removes the lock file", () => {
      const lockDir = join(testDir, "locks");
      const result = acquireLaunchLock(lockDir);
      expect(result).not.toBeNull();

      releaseLaunchLock(lockDir, result!.fd);
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(false);
    });
  });

  describe("cleanStaleLock", () => {
    it("removes lock when owner PID is dead", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "launch.lock"),
        JSON.stringify({ pid: 999_999_999, timestamp: Date.now() })
      );

      cleanStaleLock(lockDir);
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(false);
    });

    it("leaves lock alone when owner PID is alive", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "launch.lock"),
        JSON.stringify({ pid: process.pid, timestamp: Date.now() })
      );

      cleanStaleLock(lockDir);
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(true);
    });

    it("leaves recent corrupt lock alone (missing pid, <5s old)", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        join(lockDir, "launch.lock"),
        JSON.stringify({ timestamp: Date.now() })
      );

      cleanStaleLock(lockDir);
      // Recent malformed lock should NOT be deleted (might be in-progress write)
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(true);
    });

    it("removes old corrupt lock (missing pid, >5s old)", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, "launch.lock");
      writeFileSync(lockPath, JSON.stringify({ timestamp: Date.now() }));

      // Backdate the file mtime so it appears old
      const oldTime = new Date(Date.now() - 10_000);
      const { utimesSync } = require("node:fs");
      utimesSync(lockPath, oldTime, oldTime);

      cleanStaleLock(lockDir);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("leaves recent malformed JSON lock alone (<5s old)", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "launch.lock"), "not json");

      cleanStaleLock(lockDir);
      // Recent malformed lock should NOT be deleted
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(true);
    });

    it("removes old malformed JSON lock (>5s old)", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      const lockPath = join(lockDir, "launch.lock");
      writeFileSync(lockPath, "not json");

      const oldTime = new Date(Date.now() - 10_000);
      const { utimesSync } = require("node:fs");
      utimesSync(lockPath, oldTime, oldTime);

      cleanStaleLock(lockDir);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("no-ops when lock file does not exist", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });

      // Should not throw
      cleanStaleLock(lockDir);
    });

    it("no absolute timeout — live PID is authoritative", () => {
      const lockDir = join(testDir, "locks");
      mkdirSync(lockDir, { recursive: true });
      // Lock with very old timestamp but alive PID
      writeFileSync(
        join(lockDir, "launch.lock"),
        JSON.stringify({ pid: process.pid, timestamp: 0 })
      );

      cleanStaleLock(lockDir);
      // Lock should still be present because the PID is alive
      expect(existsSync(join(lockDir, "launch.lock"))).toBe(true);
    });
  });

  describe("getReviewPaths", () => {
    it("returns all expected paths under .closedloop-ai/work", () => {
      const paths = getReviewPaths(testDir, "codex");
      expect(paths.workDir).toBe(join(testDir, ".closedloop-ai", "work"));
      expect(paths.statePath).toBe(
        join(testDir, ".closedloop-ai", "work", "codex-review-codex.json")
      );
      expect(paths.logPath).toBe(
        join(testDir, ".closedloop-ai", "work", "codex-review-codex.log")
      );
      expect(paths.pidPath).toBe(
        join(testDir, ".closedloop-ai", "work", "codex-review-codex.pid")
      );
      expect(paths.findingsPath).toBe(
        join(testDir, ".closedloop-ai", "work", "review-findings-codex.json")
      );
    });

    it("uses provider name in file paths", () => {
      const paths = getReviewPaths(testDir, "claude");
      expect(paths.statePath).toContain("codex-review-claude.json");
      expect(paths.logPath).toContain("codex-review-claude.log");
      expect(paths.pidPath).toContain("codex-review-claude.pid");
      expect(paths.findingsPath).toContain("review-findings-claude.json");
    });
  });
});
