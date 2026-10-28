/**
 * ISS-11282 — branch coverage for git-diff.ts: a non-string repoPath, an
 * allow-list provider that throws or changes answer between its two checks,
 * a process manager that rejects with a non-Error, the empty-stderr message
 * fallbacks, a single-column status line, and a filePath that canonicalizes to
 * the repo root itself.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitDiffRoutes } from "../src/server/operations/git-diff.js";
import type { ExecResult } from "../src/server/process-manager.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
  FakeProcessManager,
} from "./helpers/git-gateway-op-harness.js";

const DIFF_PATH = "/api/gateway/git/diff";

const { makeTempDir } = createGitOpTempDirs("iss11282-gdiff-");

/** A process manager whose every exec rejects with a value that is not an Error. */
class NonErrorRejectingProcessManager extends FakeProcessManager {
  override exec(): Promise<ExecResult> {
    const rejection: unknown = { reason: "not an Error instance" };
    return Promise.reject(rejection);
  }
}

function dispatchDiff(input: {
  pm: FakeProcessManager;
  getAllowedDirectories: () => string[];
  body: Record<string, unknown>;
}) {
  const dispatcher = new OperationDispatcher();
  registerGitDiffRoutes(
    dispatcher,
    input.pm.asProcessManager(),
    input.getAllowedDirectories
  );
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: DIFF_PATH,
    body: JSON.stringify(input.body),
  });
}

/** Answers `first` on the first call and `rest` on every later one. */
function allowListSequence(
  first: () => string[],
  rest: () => string[]
): () => string[] {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? first() : rest();
  };
}

describe("git diff — request and allow-list guards", () => {
  test.each([
    ["repoPath", { filePath: "a.txt", repoPath: 42 }],
    ["filePath", { filePath: 5, repoPath: "/srv/repo" }],
  ])("a non-string %s is rejected as missing", async (_field, body) => {
    const pm = new FakeProcessManager();

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [],
      body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "filePath and repoPath are required",
    });
  });

  test("an allow-list provider that throws an ordinary error on the repo check propagates", async () => {
    await expect(
      dispatchDiff({
        pm: new FakeProcessManager(),
        getAllowedDirectories: () => {
          throw new Error("allow-list offline");
        },
        body: { filePath: "a.txt", repoPath: makeTempDir() },
      })
    ).rejects.toThrow("allow-list offline");
  });

  test("an existing file that the second allow-list check refuses is a 403 before any git call", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "a.txt"), "content\n");
    const pm = new FakeProcessManager();

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: allowListSequence(
        () => [repo],
        () => []
      ),
      body: { filePath: "a.txt", repoPath: repo },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "directory not allowed" });
    expect(pm.calls).toHaveLength(0);
  });

  test("an ordinary error from the second allow-list check propagates", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "a.txt"), "content\n");

    await expect(
      dispatchDiff({
        pm: new FakeProcessManager(),
        getAllowedDirectories: allowListSequence(
          () => [repo],
          () => {
            throw new Error("second check offline");
          }
        ),
        body: { filePath: "a.txt", repoPath: repo },
      })
    ).rejects.toThrow("second check offline");
  });

  test("a filePath that resolves to the repo root itself passes containment and reaches git status", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [repo],
      body: { filePath: ".", repoPath: repo },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "File has no changes" });
    expect(pm.calls[0]?.args).toEqual(["status", "--porcelain", "--", "."]);
  });
});

describe("git diff — failure messages and status parsing", () => {
  test("a process manager rejecting with a non-Error is reported as an unknown error", async () => {
    const repo = makeTempDir();

    const response = await dispatchDiff({
      pm: new NonErrorRejectingProcessManager(),
      getAllowedDirectories: () => [repo],
      body: { filePath: "a.txt", repoPath: repo },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "Failed to get diff: Unknown error",
    });
  });

  test("a base-revision show failure with empty stderr surfaces as an unknown git show error", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      { stdout: "", stderr: "", exitCode: 128 },
      { stdout: "new\n", stderr: "", exitCode: 0 },
    ]);

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [repo],
      body: { filePath: "a.txt", repoPath: repo, baseBranch: "main" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error:
        "Failed to get diff: git show failed for origin/main: unknown error",
    });
  });

  test("a working-tree status failure with empty stderr uses the generic status message", async () => {
    const repo = makeTempDir();
    const pm = new FakeProcessManager([
      { stdout: "", stderr: "", exitCode: 128 },
    ]);

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [repo],
      body: { filePath: "a.txt", repoPath: repo },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: "Failed to get diff: Failed to get file status",
    });
  });

  test("a single-column status line is a modification whose failed HEAD read discards its stdout", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "a.txt"), "working copy\n");
    const pm = new FakeProcessManager([
      { stdout: "M\n", stderr: "", exitCode: 0 },
      { stdout: "partial output", stderr: "fatal: bad object", exitCode: 128 },
    ]);

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [repo],
      body: { filePath: "a.txt", repoPath: repo },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      filePath: "a.txt",
      oldContent: "",
      newContent: "working copy\n",
      isNew: false,
      isDeleted: false,
    });
    expect(pm.calls[1]?.args).toEqual(["show", "HEAD:a.txt"]);
  });
});

describe("git diff — working-tree status shapes", () => {
  function run(
    repo: string,
    results: ExecResult[],
    body: Record<string, unknown>
  ) {
    const pm = new FakeProcessManager(results);
    return dispatchDiff({
      pm,
      getAllowedDirectories: () => [repo],
      body: { repoPath: repo, ...body },
    }).then((response) => ({ response, pm }));
  }

  test("a whitespace-only status line means the file has no changes", async () => {
    const repo = makeTempDir();

    const { response } = await run(
      repo,
      [{ stdout: "   \n", stderr: "", exitCode: 0 }],
      { filePath: "a.txt" }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "File has no changes" });
  });

  test("a non-string baseBranch is ignored and the working-tree diff runs", async () => {
    const repo = makeTempDir();

    const { response, pm } = await run(
      repo,
      [{ stdout: "", stderr: "", exitCode: 0 }],
      { filePath: "a.txt", baseBranch: 7 }
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "File has no changes" });
    expect(pm.calls[0]?.args).toEqual(["status", "--porcelain", "--", "a.txt"]);
  });

  test("an intent-to-add worktree column marks the file new without reading HEAD", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "a.txt"), "fresh\n");

    const { response, pm } = await run(
      repo,
      [{ stdout: " A a.txt\n", stderr: "", exitCode: 0 }],
      { filePath: "a.txt" }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      filePath: "a.txt",
      oldContent: "",
      newContent: "fresh\n",
      isNew: true,
      isDeleted: false,
    });
    expect(pm.calls).toHaveLength(1);
  });

  test("a staged deletion reports empty new content even when a file is back on disk", async () => {
    const repo = makeTempDir();
    writeFileSync(path.join(repo, "a.txt"), "recreated\n");

    const { response } = await run(
      repo,
      [
        { stdout: "D  a.txt\n", stderr: "", exitCode: 0 },
        { stdout: "old\n", stderr: "", exitCode: 0 },
      ],
      { filePath: "a.txt" }
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      filePath: "a.txt",
      oldContent: "old\n",
      newContent: "",
      isNew: false,
      isDeleted: true,
    });
  });

  test("a missing file under a symlinked repo path skips the containment check and reaches git", async () => {
    const root = makeTempDir();
    const realRepo = path.join(root, "real");
    mkdirSync(realRepo);
    const linkedRepo = path.join(root, "linked");
    symlinkSync(realRepo, linkedRepo);
    const pm = new FakeProcessManager([
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const response = await dispatchDiff({
      pm,
      getAllowedDirectories: () => [root],
      body: { filePath: "gone.txt", repoPath: linkedRepo },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "File has no changes" });
    expect(pm.calls[0]?.cwd).toBe(linkedRepo);
  });
});
