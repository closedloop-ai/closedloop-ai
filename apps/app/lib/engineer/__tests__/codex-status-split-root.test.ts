/**
 * Tests for the codex/status and deploy/status per-file resolution fix.
 *
 * The status routes use findFirstExistingPath per-file so each artifact
 * (state.json, log file) resolves independently regardless of which dir it
 * lives in. This covers the case where state.json is at .claude/work while
 * .closedloop-ai/work also exists (empty), and vice versa.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveReviewReadPaths } from "@/lib/engineer/process-utils";

/**
 * Wrapper that calls the real resolveReviewReadPaths and returns statePath.
 * Production uses PID-liveness tiebreaking when both roots have state.
 */
function resolveStateFile(
  worktreeDir: string,
  provider: string
): string | null {
  const { statePath } = resolveReviewReadPaths(worktreeDir, provider);
  return existsSync(statePath) ? statePath : null;
}

describe("codex/status per-file resolution — split-root state files", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "codex-status-split-root-test-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("finds state.json only at .claude/work when .closedloop-ai/work exists but is empty", () => {
    const claudeWorkDir = join(testDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      join(claudeWorkDir, "codex-review-codex.json"),
      '{"status":"completed"}'
    );

    // .closedloop-ai/work exists but no state file there
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });

    const resolved = resolveStateFile(testDir, "codex");
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(".claude");
    expect(existsSync(resolved!)).toBe(true);
  });

  it("finds state.json at .closedloop-ai/work when only that dir has the file", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "codex-review-codex.json"),
      '{"status":"running"}'
    );

    const resolved = resolveStateFile(testDir, "codex");
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(".closedloop-ai");
    expect(existsSync(resolved!)).toBe(true);
  });

  it("returns null when neither dir has the state file", () => {
    mkdirSync(join(testDir, ".closedloop-ai", "work"), { recursive: true });
    mkdirSync(join(testDir, ".claude", "work"), { recursive: true });

    const resolved = resolveStateFile(testDir, "codex");
    expect(resolved).toBeNull();
  });

  it("prefers .closedloop-ai/work when both dirs have the state file", () => {
    const newWorkDir = join(testDir, ".closedloop-ai", "work");
    mkdirSync(newWorkDir, { recursive: true });
    writeFileSync(
      join(newWorkDir, "codex-review-codex.json"),
      '{"status":"completed","source":"new"}'
    );

    const claudeWorkDir = join(testDir, ".claude", "work");
    mkdirSync(claudeWorkDir, { recursive: true });
    writeFileSync(
      join(claudeWorkDir, "codex-review-codex.json"),
      '{"status":"running","source":"old"}'
    );

    const resolved = resolveStateFile(testDir, "codex");
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(".closedloop-ai");
  });
});
