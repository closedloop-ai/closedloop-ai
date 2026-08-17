/**
 * ISS-5299 — Supplemental branch coverage for git gateway operations.
 *
 * Covers branches not reached by the four existing operation suites:
 *   git-action.ts, git-diff.ts, git-worktree.ts, git-branches.ts,
 *   git-helpers.ts, and git-branch-worktree.ts.
 *
 * Lives alongside the main op suites in apps/desktop/test/ so the
 * non-recursive readdirSync runner in scripts/run-node-tests.mjs picks
 * it up automatically.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import {
  GitGatewayErrorCategory,
  GitHookType,
} from "@closedloop-ai/loops-api/friendly-error";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import { registerGitBranchWorktreeRoutes } from "../src/server/operations/git-branch-worktree.js";
import { registerGitBranchesRoutes } from "../src/server/operations/git-branches.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import {
  findWorktreeForBranch,
  resolveRepoFullName,
  resolveRepoFullNameAsync,
} from "../src/server/operations/git-helpers.js";
import { registerGitWorktreeRoutes } from "../src/server/operations/git-worktree.js";
import { getResolvedGitPath } from "../src/server/operations/symphony-loop.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";
import { initGitRepo } from "./symphony-test-utils.js";

// ---------------------------------------------------------------------------
// Module-level regex constants (Ultracite useTopLevelRegex)
// ---------------------------------------------------------------------------

const TRUNCATED_MARKER_REGEX = /\.\.\.\[truncated\]$/;
const FAILED_REMOVE_WORKTREE_REGEX = /Failed to remove worktree/;
const FAILED_RESOLVE_BRANCH_REGEX = /Failed to resolve branch worktree/;

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const WORKTREE_PARENT_ENV = "SYMPHONY_WORKTREE_PARENT_DIR";
const originalParentEnv = process.env[WORKTREE_PARENT_ENV];

afterEach(() => {
  if (originalParentEnv === undefined) {
    Reflect.deleteProperty(process.env, WORKTREE_PARENT_ENV);
  } else {
    process.env[WORKTREE_PARENT_ENV] = originalParentEnv;
  }
});

const { makeTempDir } = createGitOpTempDirs("git-diff-ops-branch-");

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

function failWith(overrides: Partial<ExecResult>): ExecResult {
  return { stdout: "", stderr: "git failed", exitCode: 1, ...overrides };
}

// Dispatch a git-action POST request.
function dispatchAction(
  repoPath: string,
  fake: FakeProcessManager,
  body: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(dispatcher, fake.asProcessManager(), () => [
    repoPath,
  ]);
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/git",
    body: JSON.stringify({ repoPath, ...body }),
  });
}

// Create a git-worktree dispatcher for both DELETE and POST routes.
function newWorktreeDispatcher(
  allowed: string,
  fake: FakeProcessManager,
  symphonyDir = allowed
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitWorktreeRoutes(
    dispatcher,
    fake.asProcessManager(),
    () => [allowed],
    () => symphonyDir
  );
  return dispatcher;
}

// Dispatch a git-branches GET request.
function dispatchBranches(
  repoPath: string,
  fake: FakeProcessManager
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  const dispatcher = new OperationDispatcher();
  registerGitBranchesRoutes(dispatcher, fake.asProcessManager(), () => [
    repoPath,
  ]);
  return dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/git/branches",
    query: { repo: repoPath },
  });
}

// ---------------------------------------------------------------------------
// git-action.ts: parsePorcelainLine / unquotePorcelainPath guards
// ---------------------------------------------------------------------------

describe("git-action.ts — parsePorcelainLine and unquotePorcelainPath guards", () => {
  test("skips a porcelain line shorter than 4 chars, still parses valid lines (lines 497, 172)", async () => {
    const repoPath = makeTempDir();
    // "X" has length 1 — parsePorcelainLine returns null and the handler skips it
    // via the `if (!entry) continue` at line 172.  "M  real.ts" is parsed normally.
    const fake = new FakeProcessManager([
      ok("main\n"), // rev-parse --abbrev-ref HEAD
      ok("X\nM  real.ts\n"), // status --porcelain
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "status" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(nested(res.body, "files").modified, ["real.ts"]);
  });

  test("strips surrounding double-quotes from a git-quoted path (line 523)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("main\n"),
      // Git quotes paths with unusual chars in C-style double quotes.
      ok('A  "file with spaces.ts"\n'),
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "status" });
    assert.equal(res.statusCode, 200);
    // unquotePorcelainPath strips the surrounding quotes; the caller sees the bare name.
    assert.deepEqual(nested(res.body, "files").created, [
      "file with spaces.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: parseNameStatusLine null guard in branch-diff (lines 752, 349)
// ---------------------------------------------------------------------------

describe("git-action.ts — parseNameStatusLine null guard in branch-diff", () => {
  test("skips a name-status line that contains no tab separator (lines 752, 349)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok("feature\n"), // rev-parse HEAD (branch-diff)
      ok("NOTAB-LINE\nA\tsrc/new.ts\n"), // diff --name-status: first line has no tab
    ]);
    const res = await dispatchAction(repoPath, fake, {
      action: "branch-diff",
      baseBranch: "main",
    });
    assert.equal(res.statusCode, 200);
    // The tab-less "NOTAB-LINE" is skipped; "A\tsrc/new.ts" is classified as created.
    assert.deepEqual(nested(res.body, "files").created, ["src/new.ts"]);
    assert.deepEqual(nested(res.body, "files").modified, []);
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: resolveTrackingBranch — origin/HEAD alias row (line 439)
// ---------------------------------------------------------------------------

describe("git-action.ts — resolveTrackingBranch with origin/HEAD alias", () => {
  test("maps the alias row to origin/HEAD and still resolves tracking branch (line 439)", async () => {
    const repoPath = makeTempDir();
    // branch -r includes the "origin/HEAD -> origin/main" alias that git emits.
    // The handler maps it to "origin/HEAD" (drops the " -> " half), which is then
    // not "origin/main", so origin/main is the tracking branch as expected.
    const fake = new FakeProcessManager([
      ok(""), // fetch origin
      ok("feature\n"), // rev-parse HEAD
      ok("  origin/HEAD -> origin/main\n  origin/main\n"), // branch -r
      ok("3\t1\n"), // rev-list --left-right --count
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "sync-status" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trackingBranch, "origin/main");
    assert.equal(res.body.aheadBy, 3);
    assert.equal(res.body.behindBy, 1);
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: rev-list with no whitespace separator (lines 408-409)
// ---------------------------------------------------------------------------

describe("git-action.ts — sync-status malformed rev-list output", () => {
  test("treats missing behindRaw as zero via the nullish-coalescing fallback (lines 408-409)", async () => {
    const repoPath = makeTempDir();
    // rev-list returns only one field with no whitespace separator.
    // [aheadRaw, behindRaw] = ["5", undefined] → behindRaw ?? "0" = "0" → behindBy = 0.
    const fake = new FakeProcessManager([
      ok(""), // fetch origin
      ok("feature\n"), // rev-parse HEAD
      ok("  origin/main\n"), // branch -r
      ok("5"), // rev-list: single value, no space for behindRaw
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "sync-status" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.aheadBy, 5);
    assert.equal(res.body.behindBy, 0);
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: classifyHookType branches (lines 683, 688, 691, 698)
// ---------------------------------------------------------------------------

describe("git-action.ts — classifyHookType Typecheck / Format / Test branches", () => {
  // Each test uses stderr that contains ONLY the matching keyword (no "pre-commit",
  // "husky", or "hook"), so isCommitHookFailure relies on classifyHookType !== Unknown
  // to return true, exercising the short-circuit chain at lines 659 and 668.

  test("classifies tsc output as GitHookType.Typecheck (lines 659 false, 668 false, 683)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""), // git add .
      failWith({ stderr: "tsc --noEmit: 3 type errors found", exitCode: 1 }),
    ]);
    const res = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "wip",
    });
    assert.equal(res.statusCode, 500);
    assert.equal(nested(res.body, "details").hookType, GitHookType.Typecheck);
    assert.equal(
      nested(res.body, "details").category,
      GitGatewayErrorCategory.PreCommitHook
    );
  });

  test("classifies prettier output as GitHookType.Format (lines 659 false, 668 false, 688)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""),
      failWith({
        stderr: "prettier --check: formatting mismatch detected",
        exitCode: 1,
      }),
    ]);
    const res = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "wip",
    });
    assert.equal(res.statusCode, 500);
    assert.equal(nested(res.body, "details").hookType, GitHookType.Format);
  });

  test("classifies vitest output as GitHookType.Test (lines 659 false, 668 false, 698)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      ok(""),
      failWith({ stderr: "vitest: 3 tests failed", exitCode: 1 }),
    ]);
    const res = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "wip",
    });
    assert.equal(res.statusCode, 500);
    assert.equal(nested(res.body, "details").hookType, GitHookType.Test);
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: isSpawnFailure branches (lines 720-721)
// ---------------------------------------------------------------------------

describe("git-action.ts — isSpawnFailure EACCES and errorSyscall branches", () => {
  test("classifies an EACCES error code as SpawnFailed (line 720)", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      failWith({ errorCode: "EACCES", stderr: "permission denied" }),
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "status" });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, LoopErrorCode.SpawnFailed);
    assert.equal(
      nested(res.body, "details").category,
      GitGatewayErrorCategory.SpawnFailed
    );
  });

  test("classifies an errorSyscall starting with 'spawn' as SpawnFailed (line 721)", async () => {
    const repoPath = makeTempDir();
    // Neither ENOENT nor EACCES; only the syscall prefix triggers isSpawnFailure.
    const fake = new FakeProcessManager([
      failWith({ errorSyscall: "spawn git", stderr: "exec failed" }),
    ]);
    const res = await dispatchAction(repoPath, fake, { action: "status" });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, LoopErrorCode.SpawnFailed);
    assert.equal(
      nested(res.body, "details").category,
      GitGatewayErrorCategory.SpawnFailed
    );
  });
});

// ---------------------------------------------------------------------------
// git-action.ts: truncate long stderr (line 730)
// ---------------------------------------------------------------------------

describe("git-action.ts — truncate appends the truncation marker for long stderr", () => {
  test("stderrExcerpt ends with '...[truncated]' when stderr exceeds 1200 chars (line 730)", async () => {
    const repoPath = makeTempDir();
    // 1300 chars exceeds MAX_STDERR_EXCERPT_CHARS=1200 → the truncate branch fires.
    const longStderr = "E".repeat(1300);
    const fake = new FakeProcessManager([
      ok(""), // git add .
      failWith({ stderr: longStderr }),
    ]);
    const res = await dispatchAction(repoPath, fake, {
      action: "commit",
      message: "wip",
    });
    assert.equal(res.statusCode, 500);
    const excerpt = String(nested(res.body, "details").stderrExcerpt ?? "");
    assert.match(excerpt, TRUNCATED_MARKER_REGEX);
    // The first 1200 chars of the stderr are preserved before the marker.
    assert.ok(excerpt.length > 1200);
  });
});

// ---------------------------------------------------------------------------
// git-diff.ts: working diff with image file (lines 235, 259)
// ---------------------------------------------------------------------------

describe("git-diff.ts — working diff image-file path (lines 235, 259)", () => {
  test("returns isImage and mimeType when the changed file has an image extension", async () => {
    const repoPath = makeTempDir();
    const fake = new FakeProcessManager([
      // status --porcelain: "D  image.png" → deleted image file.
      { stdout: "D  image.png\n", stderr: "", exitCode: 0 },
      // git show HEAD:image.png succeeds — this is the old content.
      ok("binary\n"),
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ repoPath, filePath: "image.png" }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.isImage, true);
    assert.equal(res.body.mimeType, "image/png");
    assert.equal(res.body.isDeleted, true);
  });
});

// ---------------------------------------------------------------------------
// git-diff.ts: rawLine shorter than 2 chars — twoChar fallback (line 228)
// ---------------------------------------------------------------------------

describe("git-diff.ts — rawLine shorter than 2 chars (line 228)", () => {
  test("uses rawLine as twoChar when status output is a single character", async () => {
    const repoPath = makeTempDir();
    // "?" is 1 char → rawLine.length < 2 → twoChar = rawLine.
    // worktreeStatus = twoChar[1] ?? "" exercises the ?? "" fallback (line 230).
    // isNew = false, isDeleted = false → calls git show for oldContent.
    const fake = new FakeProcessManager([
      { stdout: "?\n", stderr: "", exitCode: 0 }, // status --porcelain
      ok("old content\n"), // git show HEAD:test.ts
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, fake.asProcessManager(), () => [
      repoPath,
    ]);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ repoPath, filePath: "test.ts" }),
    });
    assert.equal(res.statusCode, 200);
    // oldContent comes from git show; newContent is "" (readFile fails — file absent).
    assert.equal(res.body.oldContent, "old content\n");
    assert.equal(res.body.isNew, false);
    assert.equal(res.body.isDeleted, false);
  });
});

// ---------------------------------------------------------------------------
// git-worktree.ts: invalid JSON body for DELETE (line 27)
// ---------------------------------------------------------------------------

describe("git-worktree.ts — invalid JSON body in DELETE", () => {
  test("returns 400 Invalid JSON body when the DELETE body is not valid JSON (line 27)", async () => {
    const allowed = makeTempDir();
    const fake = new FakeProcessManager();
    const dispatcher = newWorktreeDispatcher(allowed, fake);
    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/git/worktree",
      body: "not-json",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid JSON body");
    assert.equal(fake.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// git-worktree.ts: non-force remove fails with non-conflict error → 500 (line 113)
// ---------------------------------------------------------------------------

describe("git-worktree.ts — non-force remove with non-conflict git error", () => {
  test("returns 500 when git worktree remove fails with an error unrelated to conflicts (line 113)", async () => {
    const allowed = makeTempDir();
    const worktree = path.join(allowed, "tree");
    await fs.mkdir(worktree);
    // stderr does NOT contain "contains modified or untracked files", so the 409
    // branch is skipped and the handler falls through to the 500 at line 113.
    const fake = new FakeProcessManager([
      fail("fatal: not a git repository", 128),
    ]);
    const dispatcher = newWorktreeDispatcher(allowed, fake);
    const res = await dispatchOperation({
      dispatcher,
      method: "DELETE",
      pathname: "/api/gateway/git/worktree",
      body: JSON.stringify({ worktreePath: worktree }),
    });
    assert.equal(res.statusCode, 500);
    assert.match(String(res.body.error), FAILED_REMOVE_WORKTREE_REGEX);
  });
});

// ---------------------------------------------------------------------------
// git-worktree.ts: ls-remote failure in stale cleanup (line 168)
// ---------------------------------------------------------------------------

describe("git-worktree.ts — ls-remote failure adds to errors in stale cleanup", () => {
  test("pushes a pr-dir to errors when ls-remote exits non-zero (line 168)", async () => {
    const allowed = makeTempDir();
    const parent = path.join(allowed, "worktrees");
    const prDir = path.join(parent, "widget-pr-42");
    await fs.mkdir(prDir, { recursive: true });
    process.env[WORKTREE_PARENT_ENV] = parent;
    const fake = new FakeProcessManager([
      ok("feature/stale\n"), // rev-parse --abbrev-ref HEAD → success
      fail("network error"), // ls-remote --heads origin → non-zero exit
    ]);
    const dispatcher = newWorktreeDispatcher(allowed, fake);
    const res = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/worktree",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.errors, [prDir]);
    assert.deepEqual(res.body.removed, []);
    assert.deepEqual(res.body.kept, []);
    // ls-remote call carries the branch name from rev-parse output.
    assert.deepEqual(fake.calls[1].args, [
      "ls-remote",
      "--heads",
      "origin",
      "feature/stale",
    ]);
  });
});

// ---------------------------------------------------------------------------
// git-branches.ts: sort fallback to 0 for branches with no date (lines 189-190)
// ---------------------------------------------------------------------------

describe("git-branches.ts — sort uses 0 fallback for branches with no commit date", () => {
  test("places branches with empty lastCommitDate last, in undefined relative order (lines 189-190)", async () => {
    const repoPath = makeTempDir();
    // An empty date string ("feature/x|") produces lastCommitDate: undefined,
    // which the sort comparator converts to 0 via the ternary false branch.
    const branchOutput = [
      "main|2026-01-01T00:00:00+00:00",
      "feature/no-date-a|",
      "feature/no-date-b|",
      "",
    ].join("\n");
    const fake = new FakeProcessManager([
      ok("refs/remotes/origin/main\n"),
      ok(""),
      ok(branchOutput),
    ]);
    const res = await dispatchBranches(repoPath, fake);
    assert.equal(res.statusCode, 200);
    const branches = res.body.branches as {
      name: string;
      lastCommitDate?: string;
    }[];
    // main comes first regardless of the no-date branches.
    assert.equal(branches[0]?.name, "main");
    const names = branches.map((b) => b.name);
    assert.ok(names.includes("feature/no-date-a"));
    assert.ok(names.includes("feature/no-date-b"));
    // Both no-date branches have no lastCommitDate in the response.
    const noDates = branches.filter((b) => !b.lastCommitDate);
    assert.equal(noDates.length, 2);
  });
});

// ---------------------------------------------------------------------------
// git-helpers.ts: resolveRepoFullName / resolveRepoFullNameAsync null path (lines 25, 55)
// git-helpers.ts: findWorktreeForBranch branch-not-found path (line 87)
// ---------------------------------------------------------------------------

describe("git-helpers.ts — pure function null-return branches", () => {
  test("resolveRepoFullName returns null when the remote URL has no org/repo pattern (line 25)", async () => {
    const repoPath = makeTempDir();
    await initGitRepo(repoPath, { allowEmpty: true });
    // "http://localhost" has no two-segment path, so the regex yields null.
    execFileSync(
      getResolvedGitPath(),
      ["remote", "add", "origin", "http://localhost"],
      {
        cwd: repoPath,
      }
    );
    const result = resolveRepoFullName(repoPath);
    assert.equal(result, null);
  });

  test("resolveRepoFullNameAsync returns null when the remote URL has no org/repo pattern (line 55)", async () => {
    const repoPath = makeTempDir();
    await initGitRepo(repoPath, { allowEmpty: true });
    execFileSync(
      getResolvedGitPath(),
      ["remote", "add", "origin", "http://localhost"],
      {
        cwd: repoPath,
      }
    );
    const result = await resolveRepoFullNameAsync(repoPath);
    assert.equal(result, null);
  });

  test("findWorktreeForBranch returns null when no worktree is on the requested branch (line 87)", async () => {
    const repoPath = makeTempDir();
    await initGitRepo(repoPath, { allowEmpty: true });
    // The repo is on "main"; asking for a nonexistent branch exercises the
    // condition `line.endsWith("/nonexistent-feature") === false` at line 87,
    // then returns null after the loop.
    const result = findWorktreeForBranch(repoPath, "nonexistent-feature");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// git-branch-worktree.ts: missing params → 400 (line 22)
// git-branch-worktree.ts: non-SymphonyDirNotConfiguredError → 500 (line 49)
// ---------------------------------------------------------------------------

describe("git-branch-worktree.ts — missing-params 400 and generic-error 500", () => {
  test("returns 400 when repoFullName or headBranch is absent (line 22)", async () => {
    const dispatcher = new OperationDispatcher();
    registerGitBranchWorktreeRoutes(dispatcher, () => "/tmp/symphony-test");
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/git/branch-worktree",
      // No query params → both repoFullName and headBranch are null.
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "repoFullName and headBranch are required");
  });

  test("returns 500 for a non-SymphonyDirNotConfiguredError caught in the handler (line 49)", async () => {
    const dispatcher = new OperationDispatcher();
    // getSymphonyDir throws a plain Error — not a SymphonyDirNotConfiguredError.
    // The catch block's `if (error instanceof SymphonyDirNotConfiguredError)` is
    // false (line 49 false path), so the handler returns 500 instead of re-throwing.
    registerGitBranchWorktreeRoutes(dispatcher, () => {
      throw new Error("disk read failed");
    });
    const res = await dispatchOperation({
      dispatcher,
      method: "GET",
      pathname: "/api/gateway/git/branch-worktree",
      query: { repoFullName: "org/repo", headBranch: "feature/x" },
    });
    assert.equal(res.statusCode, 500);
    assert.match(String(res.body.error), FAILED_RESOLVE_BRANCH_REGEX);
  });
});

/**
 * Narrow a nested JSON object out of a response body. `dispatchOperation`
 * returns `Record<string, unknown>`, so `body.files?.modified` does not
 * type-check — optional chaining cannot narrow `unknown`. Asserting the shape
 * first keeps the single cast honest and fails loudly when a route stops
 * emitting the sub-object a test is about to read.
 */
function nested(
  body: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = body[key];
  if (value === null || typeof value !== "object") {
    throw new Error(
      `expected response body.${key} to be an object, got ${typeof value}`
    );
  }
  return value as Record<string, unknown>;
}
