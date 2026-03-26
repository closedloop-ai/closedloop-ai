/**
 * Tests for the hasReviewState split-root fix.
 *
 * hasReviewState is private to apps/app/app/api/engineer/git/worktree/route.ts,
 * so we inline the same algorithm and assert observable filesystem behavior.
 *
 * The fix: check BOTH .closedloop-ai/work and .claude/work for
 * codex-review-*.json files instead of only one dir.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Inline re-implementation of hasReviewState from git/worktree/route.ts. */
function hasReviewState(worktreeDir: string): boolean {
  const dirs = [
    join(worktreeDir, ".closedloop-ai", "work"),
    join(worktreeDir, ".claude", "work"),
  ];
  for (const workDir of dirs) {
    try {
      if (
        existsSync(workDir) &&
        readdirSync(workDir).some((f) => f.startsWith("codex-review-"))
      ) {
        return true;
      }
    } catch {
      // Can't read directory
    }
  }
  return false;
}

describe("hasReviewState — split-root review file detection", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "worktree-review-state-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns true when codex-review file is only under .claude/work while .closedloop-ai/work also exists (empty)", () => {
    // .claude/work has the review file
    const claudeWorkDir = join(testDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      join(claudeWorkDir, "codex-review-codex.json"),
      '{"status":"completed"}'
    );

    // .closedloop-ai/work exists but is empty
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });

    expect(hasReviewState(testDir)).toBe(true);
  });

  it("returns true when codex-review file is only under .closedloop-ai/work", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "codex-review-claude.json"),
      '{"status":"running"}'
    );

    expect(hasReviewState(testDir)).toBe(true);
  });

  it("returns false when neither dir has review files", () => {
    // Both dirs exist but neither has codex-review-* files
    mkdirSync(join(testDir, ".claude", "work"), { recursive: true });
    writeFileSync(
      join(testDir, ".claude", "work", "state.json"),
      '{"status":"STOPPED"}'
    );
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });
    writeFileSync(
      join(testDir, ".closedloop-ai", "work", "state.json"),
      '{"status":"STOPPED"}'
    );

    expect(hasReviewState(testDir)).toBe(false);
  });

  it("returns false when neither work dir exists at all", () => {
    expect(hasReviewState(testDir)).toBe(false);
  });

  it("returns true when codex-review file is under .closedloop-ai/work and .claude/work does not exist", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "codex-review-codex.json"),
      '{"status":"completed"}'
    );

    expect(hasReviewState(testDir)).toBe(true);
  });
});
