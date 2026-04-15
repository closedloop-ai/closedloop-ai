import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktree, findExistingWorktreeForBranch } from "../worktree";

/**
 * Tests for saveWorktreeState / restoreWorktreeState logic.
 *
 * These functions are private to worktree.ts but their behavior is observable
 * through addWorktree. Since addWorktree requires a real git repo to function,
 * we test the state-save/restore mechanics inline using the same primitives.
 */

type SavedWorktreeState = {
  claudeAgentsDir: string | null;
  closedloopAiDir: string | null;
};

/**
 * Inline re-implementation of saveWorktreeState from worktree.ts.
 */
function saveState(
  worktreeDir: string,
  scratchDir: string
): SavedWorktreeState {
  const claudeAgentsDir = join(worktreeDir, ".claude", "agents");
  let savedClaudeAgentsDir: string | null = null;
  if (existsSync(claudeAgentsDir)) {
    savedClaudeAgentsDir = join(
      scratchDir,
      `saved-claude-agents-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    renameSync(claudeAgentsDir, savedClaudeAgentsDir);
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

  return {
    claudeAgentsDir: savedClaudeAgentsDir,
    closedloopAiDir: savedClosedloopAiDir,
  };
}

/**
 * Inline re-implementation of restoreWorktreeState from worktree.ts.
 */
function restoreState(saved: SavedWorktreeState, worktreeDir: string): void {
  const {
    claudeAgentsDir: savedClaudeAgentsDir,
    closedloopAiDir: savedClosedloopAiDir,
  } = saved;

  if (savedClaudeAgentsDir) {
    const destClaudeAgents = join(worktreeDir, ".claude", "agents");
    try {
      mkdirSync(destClaudeAgents, { recursive: true });
      for (const child of readdirSync(savedClaudeAgentsDir)) {
        const destChild = join(destClaudeAgents, child);
        if (!existsSync(destChild)) {
          cpSync(join(savedClaudeAgentsDir, child), destChild, {
            recursive: true,
            force: false,
          });
        }
      }
      rmSync(savedClaudeAgentsDir, { recursive: true, force: true });
    } catch {
      // Best effort -- backup preserved if restore failed
    }
  }

  if (savedClosedloopAiDir) {
    const destClosedloopAi = join(worktreeDir, ".closedloop-ai");
    try {
      mergeTreeWithoutOverwrite(savedClosedloopAiDir, destClosedloopAi);
      rmSync(savedClosedloopAiDir, { recursive: true, force: true });
    } catch {
      // Best effort -- backup preserved if restore failed
    }
  }
}

function mergeTreeWithoutOverwrite(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });

  for (const child of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourceChild = join(sourceDir, child.name);
    const destChild = join(destDir, child.name);

    if (!existsSync(destChild)) {
      cpSync(sourceChild, destChild, { recursive: true, force: false });
      continue;
    }

    if (child.isDirectory() && lstatSync(destChild).isDirectory()) {
      mergeTreeWithoutOverwrite(sourceChild, destChild);
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

  it("ignores legacy .claude/work state", () => {
    const attachmentsDir = join(testDir, ".claude", "work", "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, "image.png"), "binary-data");

    const saved = saveState(testDir, testDir);
    restoreState(saved, testDir);

    const ignored = join(
      testDir,
      ".closedloop-ai",
      "work",
      "attachments",
      "image.png"
    );
    expect(existsSync(ignored)).toBe(false);
  });

  it("ignores legacy .claude/settings/critic-gates.json", () => {
    const settingsDir = join(testDir, ".claude", "settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "critic-gates.json"),
      '{"defaults":{"baseCritics":["security-privacy"]}}'
    );

    const saved = saveState(testDir, testDir);
    restoreState(saved, testDir);

    const ignored = join(
      testDir,
      ".closedloop-ai",
      "settings",
      "critic-gates.json"
    );
    expect(existsSync(ignored)).toBe(false);
  });

  it("preserves .claude/agents without restoring unrelated .claude state", () => {
    const agentsDir = join(testDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "custom-agent.md"), "# custom agent");
    writeFileSync(join(testDir, ".claude", "settings.json"), '{"legacy":true}');

    const saved = saveState(testDir, testDir);

    mkdirSync(join(testDir, ".claude"), { recursive: true });
    writeFileSync(
      join(testDir, ".claude", "settings.json"),
      '{"tracked":true}'
    );

    restoreState(saved, testDir);

    expect(
      readFileSync(
        join(testDir, ".claude", "agents", "custom-agent.md"),
        "utf-8"
      )
    ).toBe("# custom agent");
    expect(
      readFileSync(join(testDir, ".claude", "settings.json"), "utf-8")
    ).toBe('{"tracked":true}');
  });

  it("merges saved .closedloop-ai/ into an existing destination directory", () => {
    const attachmentsDir = join(
      testDir,
      ".closedloop-ai",
      "work",
      "attachments"
    );
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(join(attachmentsDir, "image.png"), "binary-data");

    const saved = saveState(testDir, testDir);

    // Simulate destination being recreated with different files before restore
    const destDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "state.json"), '{"status":"RUNNING"}');

    restoreState(saved, testDir);

    const restoredImage = join(
      testDir,
      ".closedloop-ai",
      "work",
      "attachments",
      "image.png"
    );
    const preservedState = join(
      testDir,
      ".closedloop-ai",
      "work",
      "state.json"
    );

    expect(existsSync(restoredImage)).toBe(true);
    expect(readFileSync(restoredImage, "utf-8")).toBe("binary-data");
    expect(readFileSync(preservedState, "utf-8")).toBe('{"status":"RUNNING"}');
  });

  it("preserves checked-out .closedloop-ai/settings/critic-gates.json on restore", () => {
    const settingsDir = join(testDir, ".closedloop-ai", "settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "critic-gates.json"),
      '{"defaults":{"baseCritics":["stale"]}}'
    );

    const saved = saveState(testDir, testDir);

    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "critic-gates.json"),
      '{"defaults":{"baseCritics":["current"]}}'
    );

    restoreState(saved, testDir);

    expect(readFileSync(join(settingsDir, "critic-gates.json"), "utf-8")).toBe(
      '{"defaults":{"baseCritics":["current"]}}'
    );
  });

  it("preserves .closedloop-ai backup when restore fails", () => {
    const scratchDir = join(testDir, "scratch");
    const savedClosedloopAiDir = join(scratchDir, "saved-closedloop");
    mkdirSync(join(savedClosedloopAiDir, "work"), { recursive: true });
    writeFileSync(
      join(savedClosedloopAiDir, "work", "state.json"),
      '{"ok":true}'
    );

    // Force cpSync failure: destination exists as a file instead of a directory.
    writeFileSync(join(testDir, ".closedloop-ai"), "not-a-dir");

    restoreState(
      { claudeAgentsDir: null, closedloopAiDir: savedClosedloopAiDir },
      testDir
    );

    expect(existsSync(savedClosedloopAiDir)).toBe(true);
    expect(
      readFileSync(join(savedClosedloopAiDir, "work", "state.json"), "utf-8")
    ).toBe('{"ok":true}');
  });

  it("returns null state when .closedloop-ai does not exist", () => {
    const saved = saveState(testDir, testDir);
    expect(saved.claudeAgentsDir).toBeNull();
    expect(saved.closedloopAiDir).toBeNull();
  });
});

describe("addWorktree", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-add-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("restores saved .closedloop-ai state without overwriting tracked files", () => {
    const repoPath = join(testDir, "repo");
    const worktreeDir = join(testDir, "repo-loop");
    mkdirSync(join(repoPath, ".closedloop-ai", "settings"), {
      recursive: true,
    });
    writeFileSync(
      join(repoPath, ".closedloop-ai", "settings", "critic-gates.json"),
      '{"defaults":{"baseCritics":["current"]}}'
    );
    writeFileSync(join(repoPath, "README.md"), "# repo\n");

    execSync("git init", { cwd: repoPath, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });

    mkdirSync(join(worktreeDir, ".closedloop-ai", "settings"), {
      recursive: true,
    });
    writeFileSync(
      join(worktreeDir, ".closedloop-ai", "settings", "critic-gates.json"),
      '{"defaults":{"baseCritics":["stale"]}}'
    );
    mkdirSync(join(worktreeDir, ".closedloop-ai", "work", "comment-chats"), {
      recursive: true,
    });
    writeFileSync(
      join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        "comment-chats",
        "IC_1234.json"
      ),
      '{"messages":[]}'
    );

    const ref = execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    addWorktree(repoPath, worktreeDir, ref);

    expect(
      readFileSync(
        join(worktreeDir, ".closedloop-ai", "settings", "critic-gates.json"),
        "utf-8"
      )
    ).toBe('{"defaults":{"baseCritics":["current"]}}');
    expect(
      readFileSync(
        join(
          worktreeDir,
          ".closedloop-ai",
          "work",
          "comment-chats",
          "IC_1234.json"
        ),
        "utf-8"
      )
    ).toBe('{"messages":[]}');
  });
});

describe("findExistingWorktreeForBranch", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-find-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns the base repo when its HEAD already matches the branch", () => {
    const repoPath = join(testDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# repo\n");

    execSync("git init", { cwd: repoPath, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
    execSync("git checkout -b feat/pr-42", { cwd: repoPath, stdio: "pipe" });

    expect(findExistingWorktreeForBranch(repoPath, "feat/pr-42")).toBe(
      repoPath
    );
  });

  it("returns an existing worktree when the branch is checked out there", () => {
    const repoPath = join(testDir, "repo");
    const worktreePath = join(testDir, "repo-pr-42");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# repo\n");

    execSync("git init", { cwd: repoPath, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });
    execSync("git branch feat/pr-42", { cwd: repoPath, stdio: "pipe" });
    execSync(`git worktree add "${worktreePath}" feat/pr-42`, {
      cwd: repoPath,
      stdio: "pipe",
    });

    expect(findExistingWorktreeForBranch(repoPath, "feat/pr-42")).toBe(
      realpathSync(worktreePath)
    );
  });

  it("returns null when no checkout matches the branch", () => {
    const repoPath = join(testDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# repo\n");

    execSync("git init", { cwd: repoPath, stdio: "pipe" });
    execSync('git config user.email "test@example.com"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: repoPath, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoPath, stdio: "pipe" });

    expect(findExistingWorktreeForBranch(repoPath, "feat/missing")).toBeNull();
  });
});
