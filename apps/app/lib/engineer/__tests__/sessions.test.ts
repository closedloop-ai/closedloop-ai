import {
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setBaseDirForTesting,
  deleteSession,
  loadSessions,
  pruneInvalidSessions,
  upsertSession,
} from "@/lib/engineer/sessions";

describe("sessions", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    _setBaseDirForTesting(testDir);
  });

  afterEach(() => {
    _setBaseDirForTesting(null);
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("loadSessions", () => {
    it("returns empty when sessions.json is missing", () => {
      const config = loadSessions();
      expect(config).toEqual({ sessions: [] });
    });

    it("returns parsed content when sessions.json exists", () => {
      const data = {
        sessions: [
          {
            ticketId: "AI-1",
            repoPath: "/repo",
            worktreePath: "/wt",
            startedAt: "2024-01-01T00:00:00.000Z",
            lastAccessedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      };
      writeFileSync(join(testDir, "sessions.json"), JSON.stringify(data));

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
      expect(config.sessions[0].ticketId).toBe("AI-1");
    });

    it("returns empty for malformed JSON", () => {
      writeFileSync(join(testDir, "sessions.json"), "not json");

      const config = loadSessions();
      expect(config).toEqual({ sessions: [] });
    });
  });

  describe("upsertSession", () => {
    it("creates a new session", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
      expect(config.sessions[0].ticketId).toBe("AI-10");
      expect(config.sessions[0].startedAt).toBeTruthy();
      expect(config.sessions[0].lastAccessedAt).toBeTruthy();
    });

    it("updates existing session by ticketId", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo-updated",
        worktreePath: "/wt-10-updated",
        pid: 999,
      });

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
      expect(config.sessions[0].repoPath).toBe("/repo-updated");
      expect(config.sessions[0].worktreePath).toBe("/wt-10-updated");
      expect(config.sessions[0].pid).toBe(999);
    });

    it("preserves other sessions during update", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });
      upsertSession({
        ticketId: "AI-20",
        repoPath: "/repo",
        worktreePath: "/wt-20",
      });
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo-v2",
        worktreePath: "/wt-10-v2",
      });

      const config = loadSessions();
      expect(config.sessions).toHaveLength(2);
      expect(
        config.sessions.find((s) => s.ticketId === "AI-10")?.repoPath
      ).toBe("/repo-v2");
      expect(
        config.sessions.find((s) => s.ticketId === "AI-20")?.repoPath
      ).toBe("/repo");
    });

    it("only writes defined optional fields", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt",
        baseBranch: "main",
      });

      const config = loadSessions();
      expect(config.sessions[0].baseBranch).toBe("main");
      expect(config.sessions[0].pid).toBeUndefined();
    });
  });

  describe("deleteSession", () => {
    it("removes session by ticketId", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });
      upsertSession({
        ticketId: "AI-20",
        repoPath: "/repo",
        worktreePath: "/wt-20",
      });

      deleteSession("AI-10");

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
      expect(config.sessions[0].ticketId).toBe("AI-20");
    });

    it("no-op when ticketId not found", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });

      deleteSession("AI-999");

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
    });
  });

  describe("pruneInvalidSessions", () => {
    it("removes sessions that fail predicate", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });
      upsertSession({
        ticketId: "AI-20",
        repoPath: "/repo",
        worktreePath: "/wt-20",
      });

      const valid = pruneInvalidSessions((s) => s.ticketId === "AI-20");

      expect(valid).toHaveLength(1);
      expect(valid[0].ticketId).toBe("AI-20");

      // Verify file was updated
      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
    });

    it("does not rewrite file when nothing is pruned", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });

      const fileBefore = readFileSync(join(testDir, "sessions.json"), "utf-8");

      pruneInvalidSessions(() => true);

      const fileAfter = readFileSync(join(testDir, "sessions.json"), "utf-8");
      expect(fileAfter).toBe(fileBefore);
    });

    it("returns valid sessions", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt-10",
      });

      const valid = pruneInvalidSessions(() => true);
      expect(valid).toHaveLength(1);
      expect(valid[0].ticketId).toBe("AI-10");
    });
  });

  describe("withSessionsLock (via public API)", () => {
    it("cleans up lock file after successful operation", () => {
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt",
      });

      expect(existsSync(join(testDir, "sessions.json.lock"))).toBe(false);
    });

    it("cleans up lock file after failed operation", () => {
      // Seed with invalid JSON to cause parse error in a way that
      // still exercises the lock — saveSessions will be called with empty
      writeFileSync(join(testDir, "sessions.json"), "{}");

      // This should not throw (loadSessions returns empty on bad data)
      // and the lock should be cleaned up
      try {
        upsertSession({
          ticketId: "AI-10",
          repoPath: "/repo",
          worktreePath: "/wt",
        });
      } catch {
        // OK if it throws
      }

      expect(existsSync(join(testDir, "sessions.json.lock"))).toBe(false);
    });

    it("recovers from lock held by dead PID (regardless of age)", () => {
      // Pre-create a recent lock file with a dead PID
      const lockPath = join(testDir, "sessions.json.lock");
      writeFileSync(lockPath, String(999_999_999));

      // Should succeed — dead PID detected and lock removed
      upsertSession({
        ticketId: "AI-10",
        repoPath: "/repo",
        worktreePath: "/wt",
      });

      const config = loadSessions();
      expect(config.sessions).toHaveLength(1);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("throws when lock is held by alive PID and cannot be acquired", () => {
      // Pre-create a lock file with our own PID (alive) and recent timestamp
      const lockPath = join(testDir, "sessions.json.lock");
      // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
      const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
      const fd = openSync(lockPath, flags);
      writeSync(fd, Buffer.from(String(process.pid)));

      try {
        expect(() =>
          upsertSession({
            ticketId: "AI-10",
            repoPath: "/repo",
            worktreePath: "/wt",
          })
        ).toThrow("Failed to acquire sessions lock");
      } finally {
        // Clean up the lock we created
        try {
          const { closeSync, unlinkSync } = require("node:fs");
          closeSync(fd);
          unlinkSync(lockPath);
        } catch {
          // best effort cleanup
        }
      }
    });

    it("multiple serial writers for different tickets preserve all data", () => {
      const count = 10;
      for (let i = 0; i < count; i++) {
        upsertSession({
          ticketId: `AI-${i}`,
          repoPath: "/repo",
          worktreePath: `/wt-${i}`,
        });
      }

      const config = loadSessions();
      expect(config.sessions).toHaveLength(count);

      for (let i = 0; i < count; i++) {
        const session = config.sessions.find((s) => s.ticketId === `AI-${i}`);
        expect(session).toBeTruthy();
        expect(session?.worktreePath).toBe(`/wt-${i}`);
      }
    });
  });
});
