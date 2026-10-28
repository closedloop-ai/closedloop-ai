/**
 * ISS-5299 — Branch-coverage sweep: git-diff, git-action, and router auth
 * helpers. Split out of the codex/tailer sweep when those modules were removed
 * with Loops (ISS-12435); the cases below are unchanged.
 *
 * Dead-code branches intentionally skipped (documented inline):
 *   git-diff.ts  67 (re-throw non-DirectoryNotAllowedError)
 *   git-diff.ts 124 (non-Error catch in handleWorkingDiff outer catch)
 *   git-diff.ts 291 (canonicalizePath catch — TOCTOU race)
 *   git-action.ts  70 (re-throw non-DirectoryNotAllowedError)
 *   git-action.ts 134 (non-Error catch)
 *   router.ts  559 (?? "unauthorized" — reason always present)
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import type { GatewayApprovalRequest } from "../src/server/router.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { dispatchMockRequest } from "./gateway-server-test-doubles.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Dispatcher factories
// ---------------------------------------------------------------------------

function makeGitActionDispatcher(
  pm: FakeProcessManager,
  repoDir: string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(dispatcher, pm.asProcessManager(), () => [
    repoDir,
    os.tmpdir(),
  ]);
  return dispatcher;
}

function makeRouter(
  overrides: Partial<ConstructorParameters<typeof GatewayRouter>[0]> = {}
): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin: "https://app.closedloop.ai",
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "codex-tailer-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 0,
    getGatewayId: () => "test-gateway-id",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// output-tailer.ts — summarizeJsonlRecord: lines 112, 129
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// git-diff.ts — lines 50, 79, 197, 214, 229, 255, 279
// ---------------------------------------------------------------------------

describe("git/diff operations", () => {
  const { makeTempDir: mkGitDir } = createGitOpTempDirs("git-diff-ops-");

  test("body without repoPath returns 400 (line 50 FALSE branch: repoPath → null)", async () => {
    const pm = new FakeProcessManager();
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [
      os.tmpdir(),
    ]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "foo.txt" }), // no repoPath
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("required"));
  });

  test("file exists in repo → assertPathAllowed called (line 79), git status empty → 400 no changes", async () => {
    const repoDir = mkGitDir();
    // Create the file so existsSync(fullFilePath) = true → line 79 TRUE branch
    writeFileSync(path.join(repoDir, "test.txt"), "content");
    const pm = new FakeProcessManager([
      // git status --porcelain -- test.txt → empty (no changes)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "test.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("no changes"));
  });

  test("git show fails with empty stderr → throws 'unknown error' (line 197)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // handleBranchDiff calls both git show ops before asserting:
      // git show origin/main:file.txt → non-zero, empty stderr (no MISSING_PATH_SIGNATURES)
      { exitCode: 128, stdout: "", stderr: "" },
      // git show HEAD:file.txt → called first, checked after (never actually reached)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({
        filePath: "file.txt",
        repoPath: repoDir,
        baseBranch: "main",
      }),
    });
    assert.equal(result.statusCode, 500);
    assert.ok(JSON.parse(result.rawBody).error.includes("unknown error"));
  });

  test("git status fails with empty stderr → 'Failed to get file status' (line 214)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status --porcelain → non-zero, empty stderr
      { exitCode: 128, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 500);
    assert.ok(
      JSON.parse(result.rawBody).error.includes("Failed to get file status")
    );
  });

  test("git status returns 1-char rawLine → rawLine.length < 2 FALSE branch (line 229)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status returns a 1-char line "M\n" — unusual but valid mock
      { exitCode: 0, stdout: "M\n", stderr: "" },
      // git show HEAD:file.txt succeeds
      { exitCode: 0, stdout: "old content", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    // rawLine = "M" (length 1) → twoChar = "M" (FALSE ternary branch at line 228)
    // isNew=false, isDeleted=false, file not on disk → newContent=""
    assert.equal(result.statusCode, 200);
  });

  test("git show HEAD: fails → oldContent set to '' (line 255 FALSE branch)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status returns "M  file.txt\n" (modified file)
      { exitCode: 0, stdout: "M  file.txt\n", stderr: "" },
      // git show HEAD:file.txt fails (exitCode != 0)
      { exitCode: 1, stdout: "", stderr: "path not found" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: "file.txt", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // line 255: exitCode !== 0 → oldContent = "" (FALSE branch)
    assert.equal(body.oldContent, "");
  });

  test("filePath='.' makes canonicalTarget === canonicalRoot → return true (line 279)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git status --porcelain -- . → empty (no changes)
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const dispatcher = new OperationDispatcher();
    registerGitDiffRoutes(dispatcher, pm.asProcessManager(), () => [repoDir]);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git/diff",
      body: JSON.stringify({ filePath: ".", repoPath: repoDir }),
    });
    // repoDir/. = repoDir → canonicalTarget === canonicalRoot → containedInRepo=true (line 279)
    // git status returns empty → "File has no changes"
    assert.equal(result.statusCode, 400);
    assert.ok(JSON.parse(result.rawBody).error.includes("no changes"));
  });
});

// ---------------------------------------------------------------------------
// git-action.ts — lines 408, 503, 511, 668, 708, 756
// ---------------------------------------------------------------------------

describe("git action operations", () => {
  const { makeTempDir: mkGitDir } = createGitOpTempDirs("git-action-ops-");

  test("sync-status: rev-list returns 1 element → behindRaw=undefined ?? '0' (line 408)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git fetch origin → success
      { exitCode: 0, stdout: "", stderr: "" },
      // git rev-parse --abbrev-ref HEAD → "main"
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git branch -r → includes origin/main
      { exitCode: 0, stdout: "  origin/main\n", stderr: "" },
      // git rev-list --left-right --count → "2" (only 1 element, no tab)
      { exitCode: 0, stdout: "2\n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "sync-status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // behindRaw = undefined → ?? "0" → behindBy = 0 (line 408)
    assert.equal(body.behindBy, 0);
  });

  test("git status --porcelain: line with whitespace-only path → parsePorcelainLine returns null (line 503)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // rev-parse HEAD
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git status --porcelain: "M  \t" — length=4, path="\t", trim="" → !rawPath (line 503)
      { exitCode: 0, stdout: "M  \t\n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // parsePorcelainLine returned null → entry skipped → no files
    assert.deepEqual(body.files.modified, []);
  });

  test("git status --porcelain: empty quoted path → unquotePorcelainPath returns '' → !file (line 511)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // porcelain line 'M  ""' → rawPath='""' → unquote → "" → !file (line 511)
      { exitCode: 0, stdout: 'M  ""\n', stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "status", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    assert.deepEqual(body.files.modified, []);
  });

  test("git commit fails with empty stderr/stdout → getGitActionOutput falls back to stderrExcerpt (line 668)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git add . → success
      { exitCode: 0, stdout: "", stderr: "" },
      // git commit -m "msg" → fails, empty stderr and stdout (line 668)
      { exitCode: 1, stdout: "", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({
        action: "commit",
        repoPath: repoDir,
        message: "test commit",
      }),
    });
    // getGitActionOutput: [stderr="", stdout=""].filter(Boolean)=[] → join="" → || stderrExcerpt
    assert.equal(result.statusCode, 500);
  });

  test("git push fails with HTTP 403 → isPushAuthFailure returns true via '403' check (line 708)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git rev-parse --abbrev-ref HEAD → "main"
      { exitCode: 0, stdout: "main\n", stderr: "" },
      // git push → fails with 403 (not "authentication failed" etc.) → covers line 708
      {
        exitCode: 128,
        stdout: "",
        stderr: "HTTP 403 forbidden",
      },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({ action: "push", repoPath: repoDir }),
    });
    assert.equal(result.statusCode, 500);
    const body = JSON.parse(result.rawBody);
    assert.ok(body.details.category === "git_push_auth");
  });

  test("branch-diff: diff line with tab+space → parseNameStatusLine file is empty → null (line 756)", async () => {
    const repoDir = mkGitDir();
    const pm = new FakeProcessManager([
      // git rev-parse --abbrev-ref HEAD
      { exitCode: 0, stdout: "feature\n", stderr: "" },
      // git diff --name-status origin/main...HEAD → "M\t " (tab + space, file.trim()="")
      { exitCode: 0, stdout: "M\t \n", stderr: "" },
    ]);
    const dispatcher = makeGitActionDispatcher(pm, repoDir);
    const result = await dispatchOperation({
      dispatcher,
      method: "POST",
      pathname: "/api/gateway/git",
      body: JSON.stringify({
        action: "branch-diff",
        repoPath: repoDir,
        baseBranch: "main",
      }),
    });
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.rawBody);
    // parseNameStatusLine("M\t "): file=" ".trim()="" → return null → entry skipped
    assert.deepEqual(body.files.modified, []);
  });
});

// ---------------------------------------------------------------------------
// router.ts — firstHeaderValue
// ---------------------------------------------------------------------------

describe("GatewayRouter approval request context", () => {
  test("empty-array header → firstHeaderValue returns null via ?? null (line 1134)", {
    timeout: 10_000,
  }, async () => {
    // The `firstHeaderValue` calls live inside the argument to
    // `this.options.evaluateApproval?.(...)` (router.ts:603-618), which sits
    // behind TWO gates: the route must be `/api/gateway/*` (router.ts:500,584)
    // and it must already be authorized (router.ts:557 returns early otherwise).
    // So the request carries a matching `x-desktop-gateway-token` and targets a
    // gateway path. With no evaluateApproval configured the optional call also short-circuits and
    // the argument is never evaluated, so asserting on the response status
    // alone would prove nothing about line 1134; capturing the hook's argument
    // is what proves the branch ran.
    let captured: GatewayApprovalRequest | null = null;
    const router = makeRouter({
      getGatewayAuthToken: () => "test-auth-token",
      evaluateApproval: (request) => {
        captured = request;
        return { allow: true };
      },
    });

    // `x-desktop-source` is a custom header, so Node types it through the
    // IncomingHttpHeaders index signature as string | string[] | undefined and
    // collects repeated occurrences into an array — an empty array is the
    // degenerate case. `user-agent` is typed string | undefined and cannot
    // carry one. Empty array → Array.isArray true → value[0] undefined → ?? null.
    await dispatchMockRequest({
      router,
      method: "POST",
      path: "/api/gateway/git",
      headers: {
        "content-type": "application/json",
        "x-desktop-gateway-token": "test-auth-token",
        "x-desktop-source": [],
      },
      chunks: [JSON.stringify({})],
    });

    const approval = captured as GatewayApprovalRequest | null;
    assert.ok(approval, "evaluateApproval was never invoked");
    assert.equal(approval.source, null);
    // Contrast: user-agent was absent entirely, so it takes the `!value` arm.
    assert.equal(approval.userAgent, null);
  });
});
