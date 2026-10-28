/**
 * ISS-11282 — branch coverage for git-action.ts: allow-list and filesystem
 * errors that are neither a sandbox refusal nor a missing repo, a non-Error
 * rejection, empty-output git failures (message and excerpt fallbacks),
 * unparsable rev-list counts, and porcelain / name-status lines that parse to
 * no path.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { GitGatewayErrorCategory } from "@closedloop-ai/loops-api/friendly-error";
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitActionRoutes } from "../src/server/operations/git-action.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const GIT_PATH = "/api/gateway/git";
const ENOTDIR_REGEX = /^ENOTDIR/;

const { makeTempDir } = createGitOpTempDirs("iss11282-gact-");

class NonErrorRejectingProcessManager extends FakeProcessManager {
  override exec(): Promise<ExecResult> {
    const rejection: unknown = { reason: "not an Error instance" };
    return Promise.reject(rejection);
  }
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function dispatchAction(input: {
  pm: FakeProcessManager;
  getAllowedDirectories: () => string[];
  body: Record<string, unknown>;
}) {
  const dispatcher = new OperationDispatcher();
  registerGitActionRoutes(
    dispatcher,
    input.pm.asProcessManager(),
    input.getAllowedDirectories
  );
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: GIT_PATH,
    body: JSON.stringify(input.body),
  });
}

function inRepo(
  repo: string,
  pm: FakeProcessManager,
  body: Record<string, unknown>
) {
  return dispatchAction({
    pm,
    getAllowedDirectories: () => [repo],
    body: { repoPath: repo, ...body },
  });
}

describe("git action — unexpected errors", () => {
  test("an allow-list provider that throws an ordinary error propagates", async () => {
    await expect(
      dispatchAction({
        pm: new FakeProcessManager(),
        getAllowedDirectories: () => {
          throw new Error("allow-list offline");
        },
        body: { action: "status", repoPath: makeTempDir() },
      })
    ).rejects.toThrow("allow-list offline");
  });

  test("a repoPath under a regular file fails access with ENOTDIR and reports the raw message", async () => {
    const root = makeTempDir();
    const file = path.join(root, "plain.txt");
    writeFileSync(file, "x");
    const pm = new FakeProcessManager();

    const response = await dispatchAction({
      pm,
      getAllowedDirectories: () => [root],
      body: { action: "status", repoPath: path.join(file, "child") },
    });

    expect(response.statusCode).toBe(500);
    expect(Object.keys(response.body)).toEqual(["error"]);
    expect(String(response.body.error)).toMatch(ENOTDIR_REGEX);
    expect(pm.calls).toHaveLength(0);
  });

  test("a process manager rejecting with a non-Error is reported as an unknown error", async () => {
    const repo = makeTempDir();

    const response = await inRepo(repo, new NonErrorRejectingProcessManager(), {
      action: "status",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: "Unknown error" });
  });
});

describe("git action — empty-output git failures", () => {
  test("a push that fails with stdout only names the command and excerpts stdout", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok("feature\n"),
      { stdout: "remote said no", stderr: "", exitCode: 1 },
    ]);

    const response = await inRepo(repo, pm, { action: "push" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "git push origin feature --set-upstream failed",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "push",
        category: GitGatewayErrorCategory.GitCommandFailed,
        exitCode: 1,
        stderrExcerpt: "remote said no",
      },
    });
  });

  test("a commit that fails with no output excerpts its own message and is not read as a hook failure", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok(""),
      { stdout: "", stderr: "", exitCode: 1 },
    ]);

    const response = await inRepo(repo, pm, {
      action: "commit",
      message: "update readme",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "git commit -m update readme failed",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "commit",
        category: GitGatewayErrorCategory.GitCommandFailed,
        exitCode: 1,
        stderrExcerpt: "git commit -m update readme failed",
      },
    });
  });
});

describe("git action — output parsing", () => {
  test.each([
    { counts: "garbage\n", aheadBy: 0, behindBy: 0, isUpToDate: true },
    { counts: "0  4\n", aheadBy: 0, behindBy: 4, isUpToDate: false },
    { counts: "2\t0\n", aheadBy: 2, behindBy: 0, isUpToDate: false },
  ])(
    "rev-list counts $counts read as ahead $aheadBy / behind $behindBy",
    async ({ counts, aheadBy, behindBy, isUpToDate }) => {
      const repo = makeTempDir();
      const pm = new FakeProcessManager([
        ok(""),
        ok("feature\n"),
        ok("  origin/main\n"),
        ok(counts),
      ]);

      const response = await inRepo(repo, pm, { action: "sync-status" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        isUpToDate,
        behindBy,
        aheadBy,
        currentBranch: "feature",
        trackingBranch: "origin/main",
      });
    }
  );

  test("a failed rev-list is reported against the sync-status action", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok(""),
      ok("feature\n"),
      ok("  origin/main\n"),
      { stdout: "", stderr: "fatal: bad revision", exitCode: 128 },
    ]);

    const response = await inRepo(repo, pm, { action: "sync-status" });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "fatal: bad revision",
      code: LoopErrorCode.ProcessFailed,
      details: {
        action: "sync-status",
        category: GitGatewayErrorCategory.GitCommandFailed,
        exitCode: 128,
        stderrExcerpt: "fatal: bad revision",
      },
    });
  });

  test("porcelain lines whose path is blank or an empty quoted string are skipped but still count as changes", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok("feature\n"),
      ok(' M   \n?? ""\n M real.txt\n'),
    ]);

    const response = await inRepo(repo, pm, { action: "status" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      currentBranch: "feature",
      hasChanges: true,
      files: { modified: ["real.txt"], created: [], deleted: [], staged: [] },
    });
  });

  test("a four-character line parses, and only a path both starting and ending with a quote is unquoted", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok("feature\n"),
      ok(' M a\n?? ab"\n?? "ab\n?? "\n'),
    ]);

    const response = await inRepo(repo, pm, { action: "status" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      currentBranch: "feature",
      hasChanges: true,
      files: {
        modified: ["a"],
        created: ['ab"', '"ab', '"'],
        deleted: [],
        staged: [],
      },
    });
  });

  test("a name-status line with a blank path is skipped", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      ok("feature\n"),
      ok("M\t \nA\tnew.ts\n"),
    ]);

    const response = await inRepo(repo, pm, { action: "branch-diff" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      baseBranch: "main",
      currentBranch: "feature",
      files: { modified: [], created: ["new.ts"], deleted: [] },
      totalChanges: 1,
    });
  });
});
