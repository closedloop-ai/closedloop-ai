/**
 * ISS-11282 — branch coverage for git-local-changes.ts: a missing repo path,
 * a valid caller-supplied previousPath, the symlinked-repo path-escape
 * fallback, untracked line counting without a trailing newline, the remote URL
 * shapes that parse to no owner/repo, and the git failure message fallbacks.
 * All git I/O goes through FakeProcessManager; no child process is spawned.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  GitLocalChangesRoute,
  registerGitLocalChangesRoutes,
} from "../src/server/operations/git-local-changes.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss11282-glc-");

const REPO_FULL_NAME = "acme/widget";
const HEAD_BRANCH = "feature";

const OK_BRANCH: ExecResult = {
  stdout: `${HEAD_BRANCH}\n`,
  stderr: "",
  exitCode: 0,
};
const OK_REMOTE: ExecResult = {
  stdout: `git@github.com:${REPO_FULL_NAME}.git\n`,
  stderr: "",
  exitCode: 0,
};

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function makeDispatcher(
  allowedDir: string,
  pm: FakeProcessManager
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitLocalChangesRoutes(dispatcher, pm.asProcessManager(), () => [
    allowedDir,
  ]);
  return dispatcher;
}

function list(allowedDir: string, repoPath: string, pm: FakeProcessManager) {
  return dispatchOperation({
    dispatcher: makeDispatcher(allowedDir, pm),
    method: "GET",
    pathname: GitLocalChangesRoute.List,
    query: {
      repoPath,
      repoFullName: REPO_FULL_NAME,
      headBranch: HEAD_BRANCH,
    },
  });
}

function diff(
  allowedDir: string,
  repoPath: string,
  pm: FakeProcessManager,
  extra: Record<string, unknown>
) {
  return dispatchOperation({
    dispatcher: makeDispatcher(allowedDir, pm),
    method: "POST",
    pathname: GitLocalChangesRoute.Diff,
    body: JSON.stringify({
      repoPath,
      repoFullName: REPO_FULL_NAME,
      headBranch: HEAD_BRANCH,
      ...extra,
    }),
  });
}

describe("git local changes — repo validation", () => {
  test("an allowed repoPath that does not exist is a 404 repo_not_found before any git call", async () => {
    const allowed = makeTempDir();
    const pm = new FakeProcessManager();

    const response = await list(allowed, path.join(allowed, "missing"), pm);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: "repository not found",
      code: "repo_not_found",
    });
    expect(pm.calls).toHaveLength(0);
  });

  test.each([
    ["an https URL with no owner/repo path", "https://github.com/"],
    ["a file URL with a single path segment", "file:///widget"],
  ])(
    "origin as %s resolves to no repo and is a repo_mismatch",
    async (_label, remoteUrl) => {
      const repo = makeTempDir();
      const pm = new FakeProcessManager([OK_BRANCH, ok(`${remoteUrl}\n`)]);

      const response = await list(repo, repo, pm);

      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual({
        error: "origin remote does not match requested repoFullName",
        code: "repo_mismatch",
        details: {
          actualRepoFullName: null,
          expectedRepoFullName: REPO_FULL_NAME,
        },
      });
    }
  );

  test("an scp-style origin must have a host before its first colon", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      OK_BRANCH,
      ok(`:x:${REPO_FULL_NAME}\n`),
    ]);

    const response = await list(repo, repo, pm);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "origin remote does not match requested repoFullName",
      code: "repo_mismatch",
      details: {
        actualRepoFullName: `:x:${REPO_FULL_NAME}`,
        expectedRepoFullName: REPO_FULL_NAME,
      },
    });
  });

  test("a git:// push remote falls through to scp parsing, so its host reads as 'git' and the push is refused", async () => {
    const repo = makeTempDir();
    const gitUrl = `git://github.com/${REPO_FULL_NAME}.git\n`;
    const pm = new FakeProcessManager([OK_BRANCH, ok(gitUrl), ok(gitUrl)]);

    const response = await dispatchOperation({
      dispatcher: makeDispatcher(repo, pm),
      method: "POST",
      pathname: GitLocalChangesRoute.CommitPush,
      body: JSON.stringify({
        repoPath: repo,
        repoFullName: REPO_FULL_NAME,
        headBranch: HEAD_BRANCH,
        message: "commit",
      }),
    });

    // pins current behavior; looks odd because a git:// URL on github.com is
    // not a URL protocol the parser recognizes, so the scp regex takes "git" as
    // the host and the canonical-host check rejects a github.com remote.
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "origin push remote must be the canonical requested GitHub repo",
      code: "push_repo_mismatch",
      details: {
        actualRepoFullName: REPO_FULL_NAME,
        actualHost: "git",
        expectedRepoFullName: REPO_FULL_NAME,
      },
    });
    expect(pm.calls).toHaveLength(3);
  });

  test.each([
    {
      label: "trimmed stdout when stderr is only whitespace",
      result: { stdout: "  stdout detail \n", stderr: "  \n", exitCode: 128 },
      expectedError: "stdout detail",
    },
    {
      label: "a generic message when both streams are empty",
      result: { stdout: "", stderr: "", exitCode: 128 },
      expectedError: "git command failed",
    },
    {
      label: "stderr, not a timeout, for a non-timeout spawn error code",
      result: {
        stdout: "",
        stderr: "spawn git ENOENT",
        exitCode: 128,
        errorCode: "ENOENT",
      },
      expectedError: "spawn git ENOENT",
    },
  ])(
    "a failed branch lookup reports $label",
    async ({ result, expectedError }) => {
      const repo = makeTempDir();
      const pm = new FakeProcessManager([result]);

      const response = await list(repo, repo, pm);

      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({
        error: expectedError,
        code: "branch_lookup_failed",
        details: { exitCode: 128 },
      });
    }
  );

  test.each([
    ["http", `http://github.com/${REPO_FULL_NAME}.git`],
    ["https", `https://github.com/${REPO_FULL_NAME}.git`],
    ["ssh", `ssh://git@github.com/${REPO_FULL_NAME}.git`],
    ["file", `file:///srv/${REPO_FULL_NAME}.git`],
  ])(
    "a %s origin that names the repo passes the push-remote check",
    async (_scheme, remoteUrl) => {
      const repo = makeTempDir();
      const pm = new FakeProcessManager([
        OK_BRANCH,
        ok(`${remoteUrl}\n`),
        ok(`${remoteUrl}\n`),
        ok(""),
        ok(""),
      ]);

      const response = await dispatchOperation({
        dispatcher: makeDispatcher(repo, pm),
        method: "POST",
        pathname: GitLocalChangesRoute.CommitPush,
        body: JSON.stringify({
          repoPath: repo,
          repoFullName: REPO_FULL_NAME,
          headBranch: HEAD_BRANCH,
          message: "commit",
        }),
      });

      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual({
        error: "no local changes to commit",
        code: "no_local_changes",
      });
    }
  );

  test.each([
    ["a Windows-style path", String.raw`C:\repos\acme\widget`],
    ["a local path with trailing slashes", "/srv/acme/widget//"],
  ])(
    "an origin given as %s resolves to the requested repo",
    async (_label, remoteUrl) => {
      const repo = makeTempDir();
      const pm = new FakeProcessManager([
        OK_BRANCH,
        ok(`${remoteUrl}\n`),
        ok(""),
        ok(""),
      ]);

      const response = await list(repo, repo, pm);

      expect(response.statusCode).toBe(200);
      expect(response.body.files).toEqual([]);
    }
  );
});

describe("git local changes — list and diff content", () => {
  test("an untracked file without a trailing newline counts its last line as an addition", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "notes.txt"), "a\nb\nc");
    const pm = new FakeProcessManager([
      OK_BRANCH,
      OK_REMOTE,
      ok("?? notes.txt\n"),
      ok(""),
    ]);

    const response = await list(repo, repo, pm);

    expect(response.statusCode).toBe(200);
    expect(response.body.files).toEqual([
      {
        path: "notes.txt",
        previousPath: null,
        status: "added",
        additions: 3,
        deletions: 0,
        patch: null,
      },
    ]);
  });

  test("a valid caller previousPath wins over the status line's rename source for the HEAD read", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "new.txt"), "new content\n");
    const pm = new FakeProcessManager([
      OK_BRANCH,
      OK_REMOTE,
      ok("R  status-old.txt -> new.txt\n"),
      ok("1\t1\tnew.txt\n"),
      ok("old content\n"),
    ]);

    const response = await diff(repo, repo, pm, {
      path: "new.txt",
      previousPath: "body-old.txt",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      path: "new.txt",
      oldContent: "old content\n",
      newContent: "new content\n",
      isNew: false,
      isDeleted: false,
      isBinary: false,
    });
    expect(pm.calls[4]?.args).toEqual(["show", "HEAD:body-old.txt"]);
  });

  test("a file missing from disk under a symlinked repo path is refused as a path escape", async () => {
    const root = makeTempDir();
    const realRepo = path.join(root, "real");
    mkdirSync(realRepo);
    const linkedRepo = path.join(root, "linked");
    symlinkSync(realRepo, linkedRepo);
    const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);

    const response = await diff(root, linkedRepo, pm, { path: "gone.txt" });

    // pins current behavior; looks odd because a deleted file inside the repo
    // is compared lexically (via the symlink) against the realpath'd repo root,
    // so any path that no longer exists on disk reads as outside the repo.
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "path escapes repository",
      code: "path_escape",
    });
    expect(pm.calls).toHaveLength(2);
  });

  test("a path that normalizes to the repo root itself is rejected", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE]);

    const response = await diff(repo, repo, pm, { path: "." });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "path must stay inside the repository",
      code: "invalid_path",
    });
    expect(pm.calls).toHaveLength(2);
  });

  test("the same missing file under the real repo path passes the path check and reaches git status", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([OK_BRANCH, OK_REMOTE, ok("")]);

    const response = await diff(repo, repo, pm, { path: "gone.txt" });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: "file has no local changes",
      code: "no_local_changes",
    });
    expect(pm.calls[2]?.args).toEqual([
      "status",
      "--porcelain=v1",
      "--renames",
      "--",
      "gone.txt",
    ]);
  });
});
