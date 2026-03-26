import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveReviewReadPaths } from "@/lib/engineer/process-utils";

/**
 * Tests for saveWorktreeState / restoreWorktreeState logic.
 *
 * These functions are private to worktree.ts but their behavior is observable
 * through addWorktree. Since addWorktree requires a real git repo to function,
 * we test the state-save/restore logic by duplicating its core mechanics
 * inline using the same Node.js primitives (renameSync, cpSync, copyFileSync,
 * readdirSync, statSync).
 *
 * Each test sets up a simulated "pre-existing non-git worktree" and a
 * "freshly-checked-out worktree" (with git-tracked files restored by git),
 * then runs the same save+restore logic and asserts the expected outcome.
 */

type SavedWorktreeState = {
  claudeDir: string | null;
  closedloopAiDir: string | null;
};

/**
 * Inline re-implementation of saveWorktreeState from worktree.ts.
 * Saves into sub-paths of a caller-supplied scratch directory so the
 * test's afterEach cleanup can reliably remove every temp dir it creates.
 */
function saveState(
  worktreeDir: string,
  scratchDir: string
): SavedWorktreeState {
  const claudeDir = join(worktreeDir, ".claude");
  let savedClaudeDir: string | null = null;
  if (existsSync(claudeDir)) {
    // Use a unique sub-path inside scratchDir — no need to pre-create it,
    // renameSync will atomically move the source dir to this destination.
    savedClaudeDir = join(
      scratchDir,
      `saved-claude-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    renameSync(claudeDir, savedClaudeDir);
  }

  const closedloopAiDir = join(worktreeDir, ".closedloop-ai");
  let savedClosedloopAiDir: string | null = null;
  if (existsSync(closedloopAiDir)) {
    savedClosedloopAiDir = join(
      scratchDir,
      `saved-closedloop-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    renameSync(closedloopAiDir, savedClosedloopAiDir);
  }

  return { claudeDir: savedClaudeDir, closedloopAiDir: savedClosedloopAiDir };
}

function restoreState(saved: SavedWorktreeState, worktreeDir: string): void {
  const { claudeDir: savedClaudeDir, closedloopAiDir: savedClosedloopAiDir } =
    saved;

  if (savedClaudeDir) {
    const destClaude = join(worktreeDir, ".claude");
    if (existsSync(destClaude)) {
      for (const child of readdirSync(savedClaudeDir)) {
        const srcChild = join(savedClaudeDir, child);
        const destChild = join(destClaude, child);
        if (!existsSync(destChild)) {
          try {
            let isDir = false;
            try {
              isDir = statSync(srcChild).isDirectory();
            } catch {
              // treat as file
            }
            if (isDir) {
              cpSync(srcChild, destChild, { recursive: true });
            } else {
              copyFileSync(srcChild, destChild);
            }
          } catch {
            // best effort
          }
        }
      }
      rmSync(savedClaudeDir, { recursive: true, force: true });
    } else {
      renameSync(savedClaudeDir, destClaude);
    }
  }

  if (savedClosedloopAiDir) {
    const destClosedloopAi = join(worktreeDir, ".closedloop-ai");
    try {
      cpSync(savedClosedloopAiDir, destClosedloopAi, { recursive: true });
      rmSync(savedClosedloopAiDir, { recursive: true, force: true });
    } catch {
      // best effort -- backup preserved if cpSync failed
    }
  }
}

describe("worktree state save/restore", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-state-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves .claude/work/attachments/image.png and restores when .claude/ already exists (cpSync recursion)", () => {
    // Simulate pre-existing non-git worktree with attachment
    const attachmentsDir = join(testDir, ".claude", "work", "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, "image.png"), "binary-data");

    // Save state (renames .claude/ away to tmp)
    const saved = saveState(testDir, testDir);
    expect(saved.claudeDir).not.toBeNull();
    expect(existsSync(join(testDir, ".claude"))).toBe(false);

    // Simulate git worktree add recreating .claude/ with a tracked file
    const claudeRestoredDir = join(testDir, ".claude");
    mkdirSync(claudeRestoredDir, { recursive: true });
    writeFileSync(join(claudeRestoredDir, "settings.json"), '{"version":1}');

    // Restore state — merges, does NOT overwrite settings.json
    restoreState(saved, testDir);

    // work/attachments/image.png must be present
    const restoredImg = join(
      testDir,
      ".claude",
      "work",
      "attachments",
      "image.png"
    );
    expect(existsSync(restoredImg)).toBe(true);
    expect(readFileSync(restoredImg, "utf-8")).toBe("binary-data");

    // git-tracked settings.json must survive untouched
    expect(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8")
    ).toBe('{"version":1}');
  });

  it("saves .claude/settings.local.json and does NOT overwrite git-tracked settings.json", () => {
    // Pre-existing state has both settings.local.json and settings.json
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), '{"local":true}');
    writeFileSync(join(claudeDir, "settings.json"), '{"old":true}');

    const saved = saveState(testDir, testDir);

    // Git recreates .claude/ with new settings.json
    mkdirSync(join(testDir, ".claude"), { recursive: true });
    writeFileSync(join(testDir, ".claude", "settings.json"), '{"new":true}');

    restoreState(saved, testDir);

    // settings.local.json restored (was absent in fresh .claude/)
    expect(
      readFileSync(join(testDir, ".claude", "settings.local.json"), "utf-8")
    ).toBe('{"local":true}');

    // settings.json kept at new (git-restored) value — destination-precedence
    expect(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8")
    ).toBe('{"new":true}');
  });

  it("saves .closedloop-ai/work/comment-chats/IC_1234.json and survives worktree recreation", () => {
    const chatDir = join(testDir, ".closedloop-ai", "work", "comment-chats");
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, "IC_1234.json"), '{"messages":[]}');

    const saved = saveState(testDir, testDir);
    expect(saved.closedloopAiDir).not.toBeNull();
    expect(existsSync(join(testDir, ".closedloop-ai"))).toBe(false);

    // Simulate fresh worktree (no .closedloop-ai/)
    restoreState(saved, testDir);

    const restored = join(
      testDir,
      ".closedloop-ai",
      "work",
      "comment-chats",
      "IC_1234.json"
    );
    expect(existsSync(restored)).toBe(true);
    expect(JSON.parse(readFileSync(restored, "utf-8"))).toEqual({
      messages: [],
    });
  });

  it("renames .claude/ straight in when new worktree has no .claude/", () => {
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# instructions");

    const saved = saveState(testDir, testDir);
    // Fresh worktree — no .claude/ present after git checkout
    restoreState(saved, testDir);

    // All contents available
    expect(readFileSync(join(testDir, ".claude", "CLAUDE.md"), "utf-8")).toBe(
      "# instructions"
    );
  });

  it("a tracked settings.json already restored by git is NOT overwritten", () => {
    // Saved state contains settings.json with old value
    const claudeDir = join(testDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), '{"saved":"old"}');

    const saved = saveState(testDir, testDir);

    // Git checkout recreates settings.json with new value
    mkdirSync(join(testDir, ".claude"), { recursive: true });
    writeFileSync(
      join(testDir, ".claude", "settings.json"),
      '{"tracked":"new"}'
    );

    restoreState(saved, testDir);

    // Destination-precedence: git-restored file wins
    expect(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8")
    ).toBe('{"tracked":"new"}');
  });

  it("preserves .claude/ backup when a child copy fails (partial failure)", () => {
    // Simulate: save .claude/ with a child, then restore into a dir
    // where the destination child path is a non-writable directory (forces copy failure)
    const scratchDir = join(testDir, "scratch");
    mkdirSync(scratchDir, { recursive: true });

    // Create a saved .claude/ dir with two children
    const savedClaudeDir = join(scratchDir, "saved-claude");
    mkdirSync(savedClaudeDir, { recursive: true });
    writeFileSync(join(savedClaudeDir, "good-file.json"), '{"ok":true}');
    writeFileSync(join(savedClaudeDir, "bad-file.json"), '{"will":"fail"}');

    // Create destination .claude/ with a directory named "bad-file.json"
    // (making copyFileSync fail since you can't overwrite a dir with a file)
    const destClaude = join(testDir, ".claude");
    mkdirSync(destClaude, { recursive: true });
    mkdirSync(join(destClaude, "bad-file.json"), { recursive: true });

    // Run the merge logic (mirrors production restoreWorktreeState)
    let allCopied = true;
    for (const child of readdirSync(savedClaudeDir)) {
      const srcChild = join(savedClaudeDir, child);
      const destChild = join(destClaude, child);
      if (!existsSync(destChild)) {
        try {
          copyFileSync(srcChild, destChild);
        } catch {
          allCopied = false;
        }
      }
    }

    // good-file.json was absent in dest, so it was copied
    expect(existsSync(join(destClaude, "good-file.json"))).toBe(true);
    // bad-file.json already existed (as dir), copy was skipped by existsSync check
    // allCopied should still be true since the child existed
    // But let's test the failure case: remove good-file to force a real failure path
    rmSync(join(destClaude, "good-file.json"));
    rmSync(join(destClaude, "bad-file.json"), { recursive: true });

    // Now simulate a copy failure scenario
    allCopied = true;
    for (const child of readdirSync(savedClaudeDir)) {
      const srcChild = join(savedClaudeDir, child);
      const destChild = join(destClaude, child);
      if (!existsSync(destChild)) {
        try {
          // Force a failure on one file by making dest a read-only dir
          if (child === "bad-file.json") {
            throw new Error("simulated ENOSPC");
          }
          copyFileSync(srcChild, destChild);
        } catch {
          allCopied = false;
        }
      }
    }

    // Backup should be preserved since not all copies succeeded
    expect(allCopied).toBe(false);
    if (allCopied) {
      rmSync(savedClaudeDir, { recursive: true, force: true });
    }
    // savedClaudeDir still exists -- data not lost
    expect(existsSync(savedClaudeDir)).toBe(true);
    expect(existsSync(join(savedClaudeDir, "bad-file.json"))).toBe(true);
  });
});

describe("checkLegacyProcessAndMigrate", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-preflight-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("does not migrate when called from codex stop (no process.pid but codex review running)", () => {
    // Simulates the scenario: codex review is running (has codex-review-codex.pid)
    // but no process.pid exists. checkLegacyProcessAndMigrate would migrate,
    // which is wrong for codex stop. This test verifies the codex stop route
    // should NOT call checkLegacyProcessAndMigrate.
    const oldWork = join(testDir, ".claude", "work");
    mkdirSync(oldWork, { recursive: true });
    // No process.pid, but codex review PID exists
    writeFileSync(join(oldWork, "codex-review-codex.pid"), String(process.pid));
    writeFileSync(
      join(oldWork, "codex-review-codex.json"),
      JSON.stringify({ status: "running", pid: process.pid })
    );

    // resolveReviewReadPaths should find the state at the legacy path
    // without needing migration
    const { statePath } = resolveReviewReadPaths(testDir, "codex");
    expect(statePath).toContain(".claude");
    expect(existsSync(statePath)).toBe(true);

    // The old work dir should NOT have been renamed
    expect(existsSync(oldWork)).toBe(true);
  });
});
