/**
 * Tests for split-root read fixes across engineer API routes.
 *
 * The pattern: files written under `.claude/work` (legacy) must still be
 * readable when `.closedloop-ai/work` also exists (possibly empty). Each
 * route resolves files independently using findFirstExistingPath. Writes
 * always target `.closedloop-ai/work`.
 *
 * We inline the exact resolution logic from each route since the handlers
 * are not exported.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findFirstExistingPath,
  resolveReviewReadPaths,
} from "@/lib/engineer/process-utils";

// ---------------------------------------------------------------------------
// Helpers mirroring route logic
// ---------------------------------------------------------------------------

/** symphony/chat + comment-chat + finding-chat: legacy migration at getWorkPaths time */
function migrateChatHistoryIfNeeded(
  newHistoryPath: string,
  legacyHistoryPath: string
): void {
  if (!existsSync(newHistoryPath) && existsSync(legacyHistoryPath)) {
    const dir = join(newHistoryPath, "..");
    mkdirSync(dir, { recursive: true });
    copyFileSync(legacyHistoryPath, newHistoryPath);
  }
}

/** extract-learnings: resolve chatFile per-file */
function resolveChatFilePath(
  claudeWorkDir: string,
  oldWorkDir: string,
  chatFilename: string
): string {
  return (
    findFirstExistingPath(
      join(claudeWorkDir, chatFilename),
      join(oldWorkDir, chatFilename)
    ) ?? join(claudeWorkDir, chatFilename)
  );
}

/** process-learnings POST: resolve pendingDir per-file */
function resolvePendingDir(claudeWorkDir: string, oldWorkDir: string): string {
  return (
    findFirstExistingPath(
      join(claudeWorkDir, ".learnings", "pending"),
      join(oldWorkDir, ".learnings", "pending")
    ) ?? join(claudeWorkDir, ".learnings", "pending")
  );
}

/** codex/chat: resolve chatStatePath per-file */
function resolveChatStatePath(
  claudeWorkDir: string,
  legacyWorkDir: string,
  filename: string
): string {
  return (
    findFirstExistingPath(
      join(claudeWorkDir, filename),
      join(legacyWorkDir, filename)
    ) ?? join(claudeWorkDir, filename)
  );
}

/** status route readActiveAgents: collect from both dirs, deduplicate by agentId */
function collectAgentIds(worktreeDir: string): string[] {
  const newAgentTypesDir = join(
    worktreeDir,
    ".closedloop-ai",
    "work",
    ".agent-types"
  );
  const oldAgentTypesDir = join(worktreeDir, ".claude", "work", ".agent-types");
  const dirsToCheck = [newAgentTypesDir, oldAgentTypesDir].filter((d) =>
    existsSync(d)
  );
  const seen = new Set<string>();
  for (const dir of dirsToCheck) {
    try {
      // readdirSync imported at top level
      for (const file of readdirSync(dir)) {
        if (!file.includes("-")) {
          seen.add(file);
        }
      }
    } catch {
      // ignore
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("codex/review + codex/stop — per-file read resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-review-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves statePath from .claude/work when .closedloop-ai/work exists but has no state file", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-review-codex.json"),
      JSON.stringify({ status: "completed" })
    );
    // New dir exists but is empty
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const { statePath } = resolveReviewReadPaths(testDir, "codex");
    expect(existsSync(statePath)).toBe(true);
    expect(statePath).toContain(".claude");
    const data = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(data.status).toBe("completed");
  });

  it("all artifacts follow winning root (no cross-root resolution)", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    mkdirSync(newWorkDir, { recursive: true });
    // State file only in new dir, log only in legacy
    writeFileSync(
      join(newWorkDir, "codex-review-claude.json"),
      JSON.stringify({ status: "running" })
    );
    writeFileSync(join(legacyWorkDir, "codex-review-claude.log"), "log output");

    const { statePath, logPath } = resolveReviewReadPaths(testDir, "claude");
    // Production resolves all artifacts from the winning root (new wins here)
    expect(statePath).toContain(".closedloop-ai");
    expect(logPath).toContain(".closedloop-ai");
  });

  it("codex/stop deleteReviewFiles resolves files from legacy dir", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-review-codex.json"),
      JSON.stringify({ status: "stopped" })
    );
    writeFileSync(join(legacyWorkDir, "codex-review-codex.log"), "review log");
    // New dir exists but empty
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const { statePath, logPath } = resolveReviewReadPaths(testDir, "codex");
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(logPath)).toBe(true);
  });

  it("resolveReviewReadPaths returns .claude root when state only exists at legacy path", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-review-codex.json"),
      JSON.stringify({ status: "completed" })
    );

    const result = resolveReviewReadPaths(testDir, "codex");
    // Winning root is legacy since new has no state file
    expect(result.winningRoot).toContain(".claude");
    expect(result.statePath).toContain(".claude");
  });
});

describe("symphony/chat — legacy chat history migration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-chat-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("migrates chat-history.json from legacy path to new path before writing", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    const legacyHistory = {
      messages: [{ id: "msg-1", role: "user", content: "hello" }],
      ticketId: "T-1",
      repoPath: "/repo",
    };
    writeFileSync(
      join(legacyWorkDir, "chat-history.json"),
      JSON.stringify(legacyHistory)
    );

    // New dir exists but no history file there
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const newHistoryPath = join(newWorkDir, "chat-history.json");
    const legacyHistoryPath = join(legacyWorkDir, "chat-history.json");

    migrateChatHistoryIfNeeded(newHistoryPath, legacyHistoryPath);

    expect(existsSync(newHistoryPath)).toBe(true);
    const migrated = JSON.parse(readFileSync(newHistoryPath, "utf-8"));
    expect(migrated.messages).toHaveLength(1);
    expect(migrated.messages[0].content).toBe("hello");
  });

  it("does not overwrite existing new path with legacy", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    mkdirSync(newWorkDir, { recursive: true });

    writeFileSync(
      join(legacyWorkDir, "chat-history.json"),
      JSON.stringify({ messages: [{ id: "old" }] })
    );
    writeFileSync(
      join(newWorkDir, "chat-history.json"),
      JSON.stringify({ messages: [{ id: "new" }] })
    );

    const newHistoryPath = join(newWorkDir, "chat-history.json");
    const legacyHistoryPath = join(legacyWorkDir, "chat-history.json");

    migrateChatHistoryIfNeeded(newHistoryPath, legacyHistoryPath);

    // New path should still have the new content
    const content = JSON.parse(readFileSync(newHistoryPath, "utf-8"));
    expect(content.messages[0].id).toBe("new");
  });

  it("migrates provider-scoped chat history (chat-history-claude.json)", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "chat-history-claude.json"),
      JSON.stringify({ messages: [{ id: "claude-1" }] })
    );
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const newPath = join(newWorkDir, "chat-history-claude.json");
    const legacyPath = join(legacyWorkDir, "chat-history-claude.json");

    migrateChatHistoryIfNeeded(newPath, legacyPath);

    expect(existsSync(newPath)).toBe(true);
    const migrated = JSON.parse(readFileSync(newPath, "utf-8"));
    expect(migrated.messages[0].id).toBe("claude-1");
  });
});

describe("comment-chat — legacy chat history migration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-comment-chat-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("migrates comment chat history from .claude/work/comment-chats to new path", () => {
    const legacyDir = join(testDir, ".claude", "work", "comment-chats");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "comment_123.json"),
      JSON.stringify({ messages: [{ id: "c-1" }] })
    );
    // New dir exists but empty
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const newPath = join(
      testDir,
      ".closedloop-ai",
      "work",
      "comment-chats",
      "comment_123.json"
    );
    const legacyPath = join(legacyDir, "comment_123.json");

    migrateChatHistoryIfNeeded(newPath, legacyPath);

    expect(existsSync(newPath)).toBe(true);
    const migrated = JSON.parse(readFileSync(newPath, "utf-8"));
    expect(migrated.messages[0].id).toBe("c-1");
  });
});

describe("finding-chat — legacy chat history migration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-finding-chat-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("migrates finding chat history from .claude/work/finding-chats to new path", () => {
    const legacyDir = join(testDir, ".claude", "work", "finding-chats");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "finding_abc.json"),
      JSON.stringify({ messages: [{ id: "f-1" }] })
    );
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const newPath = join(
      testDir,
      ".closedloop-ai",
      "work",
      "finding-chats",
      "finding_abc.json"
    );
    const legacyPath = join(legacyDir, "finding_abc.json");

    migrateChatHistoryIfNeeded(newPath, legacyPath);

    expect(existsSync(newPath)).toBe(true);
    const migrated = JSON.parse(readFileSync(newPath, "utf-8"));
    expect(migrated.messages[0].id).toBe("f-1");
  });
});

describe("extract-learnings — per-file chat history resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-extract-learnings-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves chat-history.json from legacy path when new path has no file", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "chat-history.json"),
      JSON.stringify({ messages: [] })
    );
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const resolved = resolveChatFilePath(
      newWorkDir,
      legacyWorkDir,
      "chat-history.json"
    );
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toContain(".claude");
  });

  it("resolves scoped chat file (comment-chats/X.json) from legacy path", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(join(legacyWorkDir, "comment-chats"), { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "comment-chats", "cmt_1.json"),
      JSON.stringify({ messages: [{ id: "cmt" }] })
    );
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const resolved = resolveChatFilePath(
      newWorkDir,
      legacyWorkDir,
      "comment-chats/cmt_1.json"
    );
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toContain(".claude");
  });

  it("returns new path when neither dir has the file (caller handles 404)", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(newWorkDir, { recursive: true });
    mkdirSync(legacyWorkDir, { recursive: true });

    const resolved = resolveChatFilePath(
      newWorkDir,
      legacyWorkDir,
      "chat-history.json"
    );
    // Should be in new dir (the caller will 404 because file doesn't exist)
    expect(resolved).toContain(".closedloop-ai");
    expect(existsSync(resolved)).toBe(false);
  });
});

describe("process-learnings POST — per-file pendingDir resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-process-learnings-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves pendingDir from legacy path when new path has no pending dir", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    const legacyPendingDir = join(legacyWorkDir, ".learnings", "pending");
    mkdirSync(legacyPendingDir, { recursive: true });
    writeFileSync(join(legacyPendingDir, "item.json"), "{}");

    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const resolved = resolvePendingDir(newWorkDir, legacyWorkDir);
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toContain(".claude");
  });

  it("resolves pendingDir from new path when both dirs exist", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(join(legacyWorkDir, ".learnings", "pending"), {
      recursive: true,
    });
    mkdirSync(join(newWorkDir, ".learnings", "pending"), { recursive: true });

    const resolved = resolvePendingDir(newWorkDir, legacyWorkDir);
    expect(resolved).toContain(".closedloop-ai");
  });

  it("returns new path as default when neither dir has pending dir", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(newWorkDir, { recursive: true });
    mkdirSync(legacyWorkDir, { recursive: true });

    const resolved = resolvePendingDir(newWorkDir, legacyWorkDir);
    expect(resolved).toContain(".closedloop-ai");
    expect(existsSync(resolved)).toBe(false);
  });
});

describe("codex/chat — per-file chatStatePath resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-codex-chat-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves chatStatePath from legacy path when new path has no state file", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-chat-main.json"),
      JSON.stringify({ sessionId: "sess-legacy", messageCount: 3 })
    );
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    const resolved = resolveChatStatePath(
      newWorkDir,
      legacyWorkDir,
      "codex-chat-main.json"
    );
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toContain(".claude");
    const data = JSON.parse(readFileSync(resolved, "utf-8"));
    expect(data.sessionId).toBe("sess-legacy");
  });

  it("prefers new path when state file exists in both dirs", () => {
    const legacyWorkDir = join(testDir, ".claude", "work");
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(legacyWorkDir, { recursive: true });
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(legacyWorkDir, "codex-chat-main.json"),
      JSON.stringify({ sessionId: "sess-old" })
    );
    writeFileSync(
      join(newWorkDir, "codex-chat-main.json"),
      JSON.stringify({ sessionId: "sess-new" })
    );

    const resolved = resolveChatStatePath(
      newWorkDir,
      legacyWorkDir,
      "codex-chat-main.json"
    );
    expect(resolved).toContain(".closedloop-ai");
    const data = JSON.parse(readFileSync(resolved, "utf-8"));
    expect(data.sessionId).toBe("sess-new");
  });
});

describe("status route readActiveAgents — merge both dirs", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "split-root-agents-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("finds agents only in legacy .claude/work when .closedloop-ai/work/.agent-types does not exist", () => {
    const legacyAgentDir = join(testDir, ".claude", "work", ".agent-types");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(
      join(legacyAgentDir, "abc123"),
      "planner|PlanAgent|2024-01-01"
    );
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const agents = collectAgentIds(testDir);
    expect(agents).toContain("abc123");
  });

  it("merges agents from both dirs and deduplicates", () => {
    const legacyAgentDir = join(testDir, ".claude", "work", ".agent-types");
    const newAgentDir = join(testDir, ".closedloop-ai", "work", ".agent-types");
    mkdirSync(legacyAgentDir, { recursive: true });
    mkdirSync(newAgentDir, { recursive: true });

    // Same agent in both dirs (same file name = same agentId)
    writeFileSync(
      join(legacyAgentDir, "shared123"),
      "coder|CodeAgent|2024-01-01"
    );
    writeFileSync(join(newAgentDir, "shared123"), "coder|CodeAgent|2024-01-02");
    // Unique agent only in new dir
    writeFileSync(
      join(newAgentDir, "unique456"),
      "reviewer|ReviewAgent|2024-01-03"
    );

    const agents = collectAgentIds(testDir);
    // Deduplicated: shared123 appears once, unique456 once
    expect(agents.filter((a) => a === "shared123")).toHaveLength(1);
    expect(agents).toContain("unique456");
    expect(agents).toHaveLength(2);
  });

  it("skips retry-tracking files (files containing -)", () => {
    const legacyAgentDir = join(testDir, ".claude", "work", ".agent-types");
    mkdirSync(legacyAgentDir, { recursive: true });
    writeFileSync(join(legacyAgentDir, "validagent"), "coder|Coder|2024-01");
    writeFileSync(join(legacyAgentDir, "retry-tracking-file"), "retry-data");

    const agents = collectAgentIds(testDir);
    expect(agents).toContain("validagent");
    expect(agents).not.toContain("retry-tracking-file");
  });
});

// ---------------------------------------------------------------------------
// Codex review state: liveness-aware resolution
// ---------------------------------------------------------------------------

describe("codex review liveness-aware state resolution", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "liveness-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Calls the real production resolveReviewReadPaths and returns statePath. */
  function resolveStatePath(worktreeDir: string, provider: string): string {
    return resolveReviewReadPaths(worktreeDir, provider).statePath;
  }

  it("stale new + running-status old (both PIDs dead) -> prefers new (no live PID to flip)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeFileSync(
      join(newWork, "codex-review-codex.json"),
      JSON.stringify({ status: "completed", pid: 999_999_999 })
    );
    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_998 }) // dead PID
    );

    const resolved = resolveStatePath(testDir, "codex");
    // Neither PID is live, so new root wins by default
    expect(resolved).toBe(join(newWork, "codex-review-codex.json"));
  });

  it("both running, stale new PID + live old PID -> prefers old (PID liveness wins)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeFileSync(
      join(newWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_999 }) // dead
    );
    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: process.pid }) // live
    );

    const resolved = resolveStatePath(testDir, "codex");
    expect(resolved).toBe(join(oldWork, "codex-review-codex.json"));
  });

  it("both running, both PIDs dead -> prefers new (default)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    writeFileSync(
      join(newWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_997 })
    );
    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_996 })
    );

    const resolved = resolveStatePath(testDir, "codex");
    expect(resolved).toBe(join(newWork, "codex-review-codex.json"));
  });

  it("only old exists -> returns old", () => {
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_995 })
    );

    const resolved = resolveStatePath(testDir, "codex");
    expect(resolved).toBe(join(oldWork, "codex-review-codex.json"));
  });

  it("all artifacts follow the winning root (no cross-root reads)", () => {
    const newWork = join(testDir, ".closedloop-ai", "work");
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(newWork, { recursive: true });
    mkdirSync(oldWork, { recursive: true });

    // Old root has a live review
    writeFileSync(
      join(newWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: 999_999_999 })
    );
    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: process.pid })
    );
    writeFileSync(join(oldWork, "codex-review-codex.log"), "old log");
    writeFileSync(join(newWork, "codex-review-codex.log"), "new log");

    const resolved = resolveStatePath(testDir, "codex");
    // State picks old root; log should also come from old root
    const logPath = join(dirname(resolved), "codex-review-codex.log");
    expect(readFileSync(logPath, "utf-8")).toBe("old log");
  });
});
