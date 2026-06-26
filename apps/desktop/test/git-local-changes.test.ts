import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitLocalChangesRoutes } from "../src/server/operations/git-local-changes.js";
import { ProcessManager } from "../src/server/process-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "git-local-changes-test-")
  );
  const realDir = await fs.realpath(dir);
  tempDirs.push(realDir);
  return realDir;
}

async function createRepo(
  root: string
): Promise<{ repoPath: string; remotePath: string }> {
  const remotePath = path.join(root, "remotes", "acme", "widget.git");
  await fs.mkdir(path.dirname(remotePath), { recursive: true });
  execSync(`git init --bare -q ${shellQuote(remotePath)}`, { stdio: "pipe" });

  const repoPath = path.join(root, "repo");
  await fs.mkdir(repoPath);
  execSync("git init -q -b feature", { cwd: repoPath, stdio: "pipe" });
  execSync("git config user.email test@example.com", {
    cwd: repoPath,
    stdio: "pipe",
  });
  execSync("git config user.name Test", { cwd: repoPath, stdio: "pipe" });
  execSync("git config commit.gpgsign false", { cwd: repoPath, stdio: "pipe" });
  execSync(`git remote add origin ${shellQuote(remotePath)}`, {
    cwd: repoPath,
    stdio: "pipe",
  });
  await fs.writeFile(path.join(repoPath, "tracked.txt"), "old\n", "utf-8");
  await fs.writeFile(
    path.join(repoPath, "rename-old.txt"),
    "rename\n",
    "utf-8"
  );
  execSync(
    "git add . && git commit -q -m initial && git push -q -u origin feature",
    {
      cwd: repoPath,
      stdio: "pipe",
    }
  );
  return { repoPath, remotePath };
}

async function dispatch(
  dispatcher: OperationDispatcher,
  input: {
    method: string;
    pathname: string;
    query?: Record<string, string>;
    body?: unknown;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  let responseBody = "";
  let statusCode = 0;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(code: number) {
      statusCode = code;
    },
    setHeader() {},
    end(body?: string) {
      responseBody = body ?? "";
    },
  } as unknown as ServerResponse;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    params.set(key, value);
  }
  const rawBody = input.body === undefined ? "" : JSON.stringify(input.body);
  const handled = await dispatcher.dispatch({
    method: input.method,
    pathname: input.pathname,
    params: {},
    query: params,
    rawBody: Buffer.from(rawBody),
    body: rawBody,
    request: {} as IncomingMessage,
    response,
  });
  assert.equal(handled, true);
  return {
    status: statusCode,
    body: JSON.parse(responseBody) as Record<string, unknown>,
  };
}

function makeDispatcher(root: string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitLocalChangesRoutes(
    dispatcher,
    new ProcessManager({ getAllowedDirectories: () => [root] }),
    () => [root]
  );
  return dispatcher;
}

describe("registerGitLocalChangesRoutes", () => {
  test("lists Branch View-ready local file metadata without file content", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "tracked.txt"),
      "old\nnew\n",
      "utf-8"
    );
    await fs.writeFile(path.join(repoPath, "added.txt"), "added\n", "utf-8");
    execSync("git mv rename-old.txt rename-new.txt", {
      cwd: repoPath,
      stdio: "pipe",
    });

    const response = await dispatch(makeDispatcher(root), {
      method: "GET",
      pathname: "/api/gateway/git/local-changes",
      query: { repoPath, repoFullName: "acme/widget", headBranch: "feature" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.repoPath, repoPath);
    assert.equal(response.body.branch, "feature");
    const files = response.body.files as Array<{
      additions: number;
      path: string;
      previousPath: string | null;
      status: string;
      patch: null;
    }>;
    assert.equal(
      files.some(
        (file) => file.path === "tracked.txt" && file.status === "modified"
      ),
      true
    );
    assert.equal(
      files.some(
        (file) =>
          file.path === "added.txt" &&
          file.status === "added" &&
          file.additions === 1
      ),
      true
    );
    assert.equal(
      files.some(
        (file) =>
          file.path === "rename-new.txt" &&
          file.previousPath === "rename-old.txt"
      ),
      true
    );
    assert.equal(
      files.every((file) => file.patch === null),
      true
    );
    assert.equal(JSON.stringify(files).includes("old\\nnew"), false);
  });

  test("decodes Git-quoted status paths without treating filename arrows as renames", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "a -> b.txt"),
      "arrow old\n",
      "utf-8"
    );
    await fs.writeFile(path.join(repoPath, "café.txt"), "cafe old\n", "utf-8");
    execSync("git add . && git commit -q -m quoted-path-fixtures", {
      cwd: repoPath,
      stdio: "pipe",
    });
    await fs.writeFile(
      path.join(repoPath, "a -> b.txt"),
      "arrow new\n",
      "utf-8"
    );
    await fs.writeFile(path.join(repoPath, "café.txt"), "cafe new\n", "utf-8");

    const response = await dispatch(makeDispatcher(root), {
      method: "GET",
      pathname: "/api/gateway/git/local-changes",
      query: { repoPath, repoFullName: "acme/widget", headBranch: "feature" },
    });

    assert.equal(response.status, 200);
    const files = response.body.files as Array<{
      path: string;
      previousPath: string | null;
      status: string;
    }>;
    assert.equal(
      files.some(
        (file) =>
          file.path === "a -> b.txt" &&
          file.previousPath === null &&
          file.status === "modified"
      ),
      true
    );
    assert.equal(
      files.some(
        (file) => file.path === "café.txt" && file.status === "modified"
      ),
      true
    );
  });

  test("parses quoted rename status paths with arrow markers inside filenames", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "old -> name.txt"),
      "rename old\n",
      "utf-8"
    );
    execSync("git add . && git commit -q -m quoted-rename-fixture", {
      cwd: repoPath,
      stdio: "pipe",
    });
    execSync("git mv 'old -> name.txt' 'new -> name.txt'", {
      cwd: repoPath,
      stdio: "pipe",
    });

    const response = await dispatch(makeDispatcher(root), {
      method: "GET",
      pathname: "/api/gateway/git/local-changes",
      query: { repoPath, repoFullName: "acme/widget", headBranch: "feature" },
    });

    assert.equal(response.status, 200);
    const files = response.body.files as Array<{
      path: string;
      previousPath: string | null;
      status: string;
    }>;
    assert.equal(
      files.some(
        (file) =>
          file.path === "new -> name.txt" &&
          file.previousPath === "old -> name.txt" &&
          file.status === "renamed"
      ),
      true
    );
  });

  test("returns local working-tree diff shape and rejects path traversal", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "tracked.txt"),
      "old\nnew\n",
      "utf-8"
    );

    const response = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/diff",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        path: "tracked.txt",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.path, "tracked.txt");
    assert.equal(response.body.oldContent, "old\n");
    assert.equal(response.body.newContent, "old\nnew\n");
    assert.equal(response.body.isBinary, false);

    const traversal = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/diff",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        path: "../secret.txt",
      },
    });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.code, "invalid_path");
  });

  test("reports untracked binary local diffs without reading them as UTF-8 text", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    const binaryBytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    await fs.writeFile(path.join(repoPath, "asset.bin"), binaryBytes);

    const originalToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function guardedToString(
      ...args: Parameters<Buffer["toString"]>
    ) {
      if (this.subarray(0, 8192).includes(0)) {
        throw new Error("binary content was decoded as UTF-8");
      }
      return originalToString.apply(this, args);
    };
    let response: Awaited<ReturnType<typeof dispatch>>;
    try {
      response = await dispatch(makeDispatcher(root), {
        method: "POST",
        pathname: "/api/gateway/git/local-changes/diff",
        body: {
          repoPath,
          repoFullName: "acme/widget",
          headBranch: "feature",
          path: "asset.bin",
        },
      });
    } finally {
      Buffer.prototype.toString = originalToString;
    }

    assert.equal(response.status, 200);
    assert.equal(response.body.path, "asset.bin");
    assert.equal(response.body.isBinary, true);
    assert.equal(response.body.isNew, true);
    assert.equal(response.body.isDeleted, false);
    assert.equal(response.body.oldContent, "");
    assert.equal(response.body.newContent, "");
    assert.equal(JSON.stringify(response.body).includes("\u0000"), false);
  });

  test("preserves deleted flags for tracked binary local diffs", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "tracked.bin"),
      Buffer.from([0, 1, 2, 3, 4, 5])
    );
    execSync("git add . && git commit -q -m binary-fixture", {
      cwd: repoPath,
      stdio: "pipe",
    });
    await fs.rm(path.join(repoPath, "tracked.bin"));

    const response = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/diff",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        path: "tracked.bin",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.path, "tracked.bin");
    assert.equal(response.body.isBinary, true);
    assert.equal(response.body.isNew, false);
    assert.equal(response.body.isDeleted, true);
    assert.equal(response.body.oldContent, "");
    assert.equal(response.body.newContent, "");
  });

  test("commit-push validates branch and pushes HEAD to the requested branch", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    await fs.writeFile(
      path.join(repoPath, "tracked.txt"),
      "changed\n",
      "utf-8"
    );

    const branchMismatch = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/commit-push",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "other",
        message: "Update widget",
      },
    });
    assert.equal(branchMismatch.status, 409);
    assert.equal(branchMismatch.body.code, "branch_mismatch");

    const response = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/commit-push",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        message: "Update widget",
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.pushed, true);
    assert.equal(response.body.branch, "feature");
    assert.equal(response.body.filesCommitted, 1);
    const remoteHead = execSync("git rev-parse feature", {
      cwd: path.join(root, "remotes", "acme", "widget.git"),
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    assert.equal(response.body.commitSha, remoteHead);
  });

  test("commit-push rejects ambiguous origin push URLs before staging", async () => {
    const root = await makeTempDir();
    const { repoPath, remotePath } = await createRepo(root);
    const otherRemotePath = path.join(root, "mirrors", "acme", "widget.git");
    await fs.mkdir(path.dirname(otherRemotePath), { recursive: true });
    execSync(`git init --bare -q ${shellQuote(otherRemotePath)}`, {
      stdio: "pipe",
    });
    execSync(
      `git remote set-url --push --add origin ${shellQuote(remotePath)}`,
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    execSync(
      `git remote set-url --push --add origin ${shellQuote(otherRemotePath)}`,
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    await fs.writeFile(
      path.join(repoPath, "tracked.txt"),
      "changed\n",
      "utf-8"
    );

    const response = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/commit-push",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        message: "Update widget",
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "ambiguous_push_origin");
    assert.equal(
      execSync("git diff --cached --name-only", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim(),
      ""
    );
    assert.equal(
      execSync("git rev-list --count HEAD", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim(),
      "1"
    );
    assert.match(
      execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" }),
      /tracked\.txt/
    );
  });

  test("commit-push rejects wrong-host push URLs before staging even when repo suffix matches", async () => {
    const root = await makeTempDir();
    const { repoPath } = await createRepo(root);
    execSync(
      "git remote set-url --push origin git@evil.example:acme/widget.git",
      {
        cwd: repoPath,
        stdio: "pipe",
      }
    );
    await fs.writeFile(
      path.join(repoPath, "tracked.txt"),
      "changed\n",
      "utf-8"
    );

    const response = await dispatch(makeDispatcher(root), {
      method: "POST",
      pathname: "/api/gateway/git/local-changes/commit-push",
      body: {
        repoPath,
        repoFullName: "acme/widget",
        headBranch: "feature",
        message: "Update widget",
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "push_repo_mismatch");
    assert.equal(
      execSync("git diff --cached --name-only", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim(),
      ""
    );
    assert.equal(
      execSync("git rev-list --count HEAD", {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim(),
      "1"
    );
    assert.match(
      execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8" }),
      /tracked\.txt/
    );
  });

  test("propagates local git operation timeouts as stable route errors", async () => {
    const root = await makeTempDir();
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath);
    const dispatcher = new OperationDispatcher();
    let callCount = 0;
    const processManager = {
      exec: async () => {
        callCount += 1;
        if (callCount === 1) {
          return { stdout: "feature\n", stderr: "", exitCode: 0 };
        }
        if (callCount === 2) {
          return {
            stdout: "git@github.com:acme/widget.git\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "operation timed out",
          exitCode: 1,
          errorCode: "ETIMEDOUT",
        };
      },
    } as unknown as ProcessManager;
    registerGitLocalChangesRoutes(dispatcher, processManager, () => [root]);

    const response = await dispatch(dispatcher, {
      method: "GET",
      pathname: "/api/gateway/git/local-changes",
      query: { repoPath, repoFullName: "acme/widget", headBranch: "feature" },
    });

    assert.equal(response.status, 500);
    assert.equal(response.body.code, "git_timeout");
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
