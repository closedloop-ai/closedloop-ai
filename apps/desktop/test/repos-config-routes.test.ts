import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerReposConfigRoutes } from "../src/server/operations/repos-config.js";
import { SymphonyDirNotConfiguredError } from "../src/server/operations/symphony-utils.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

/**
 * ISS-7346 — the four `/api/gateway/repos` routes had no suite of their own;
 * only `repos-config-utils.ts` beneath them was covered.
 */

const REPOS_ROUTE = "/api/gateway/repos";
const GET = "GET";
const POST = "POST";
const DELETE = "DELETE";
const PATCH = "PATCH";

const { makeTempDir } = createGitOpTempDirs("repos-config-routes-");

function newDispatcher(getSymphonyDir: () => string): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerReposConfigRoutes(dispatcher, getSymphonyDir);
  return dispatcher;
}

function dispatchRepos(
  getSymphonyDir: () => string,
  input: {
    method: string;
    body?: string;
    query?: Record<string, string>;
  }
): Promise<Awaited<ReturnType<typeof dispatchOperation>>> {
  return dispatchOperation({
    dispatcher: newDispatcher(getSymphonyDir),
    method: input.method,
    pathname: REPOS_ROUTE,
    body: input.body,
    query: input.query,
  });
}

async function readConfig(symphonyDir: string): Promise<{
  repos: { path: string; description?: string }[];
  settings: Record<string, unknown>;
}> {
  return JSON.parse(
    await fs.readFile(path.join(symphonyDir, "config", "repos.json"), "utf-8")
  );
}

/** A real directory that `addRepo` will accept. */
async function makeRepoDir(name = "widget"): Promise<string> {
  const repoPath = path.join(makeTempDir(), name);
  await fs.mkdir(repoPath, { recursive: true });
  return repoPath;
}

describe(`${GET} ${REPOS_ROUTE}`, () => {
  test("reports an empty config before anything is added", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, { method: GET });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.repos, []);
    assert.deepEqual(response.body.settings, {});
  });

  test("answers 500 with the failure message when the config cannot be read", async () => {
    const response = await dispatchRepos(
      () => {
        throw new Error("symphony dir exploded");
      },
      { method: GET }
    );

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.error,
      "Failed to list repos: symphony dir exploded"
    );
  });

  test("rethrows the onboarding error so the dispatcher answers 503", async () => {
    const response = await dispatchRepos(
      () => {
        throw new SymphonyDirNotConfiguredError();
      },
      { method: GET }
    );

    assert.equal(response.statusCode, 503);
  });
});

describe(`${POST} ${REPOS_ROUTE}`, () => {
  test("adds a repository and echoes the stored record", async () => {
    const symphonyDir = makeTempDir();
    const repoPath = await makeRepoDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: JSON.stringify({ path: repoPath, description: "the widget repo" }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    const stored = await readConfig(symphonyDir);
    assert.equal(stored.repos.length, 1);
    assert.equal(stored.repos[0].description, "the widget repo");
  });

  test("rejects a malformed JSON body", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: "{ not json",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Invalid JSON body");
  });

  test("requires a string path", async () => {
    const symphonyDir = makeTempDir();

    for (const body of [{}, { path: 7 }, { path: null }]) {
      const response = await dispatchRepos(() => symphonyDir, {
        method: POST,
        body: JSON.stringify(body),
      });

      assert.equal(response.statusCode, 400);
      assert.equal(
        response.body.error,
        "path is required and must be a string"
      );
    }
  });

  test("surfaces the underlying rejection for a path that does not exist", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: JSON.stringify({ path: "/nonexistent/iss-7346-repo" }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Path does not exist");
  });

  test("rejects a path that is a file rather than a directory", async () => {
    const symphonyDir = makeTempDir();
    const filePath = path.join(makeTempDir(), "not-a-dir");
    await fs.writeFile(filePath, "", "utf-8");

    const response = await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: JSON.stringify({ path: filePath }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Path must be a directory");
  });

  test("rejects a repository that is already configured", async () => {
    const symphonyDir = makeTempDir();
    const repoPath = await makeRepoDir();
    const body = JSON.stringify({ path: repoPath });

    await dispatchRepos(() => symphonyDir, { method: POST, body });
    const second = await dispatchRepos(() => symphonyDir, {
      method: POST,
      body,
    });

    assert.equal(second.statusCode, 400);
    assert.equal(second.body.error, "Repository already configured");
  });

  test("stores an added repo without a description when none was given", async () => {
    const symphonyDir = makeTempDir();
    const repoPath = await makeRepoDir();

    await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: JSON.stringify({ path: repoPath, description: 42 }),
    });

    const stored = await readConfig(symphonyDir);
    assert.equal(Object.hasOwn(stored.repos[0], "description"), false);
  });
});

describe(`${DELETE} ${REPOS_ROUTE}`, () => {
  test("removes a configured repository", async () => {
    const symphonyDir = makeTempDir();
    const repoPath = await makeRepoDir();
    await dispatchRepos(() => symphonyDir, {
      method: POST,
      body: JSON.stringify({ path: repoPath }),
    });

    const response = await dispatchRepos(() => symphonyDir, {
      method: DELETE,
      query: { path: repoPath },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual((await readConfig(symphonyDir)).repos, []);
  });

  test("requires a path query parameter", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: DELETE,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "path query parameter is required");
  });

  test("reports a repository that was never configured", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: DELETE,
      query: { path: path.join(os.tmpdir(), "iss-7346-never-added") },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Repository not found");
  });
});

describe(`${PATCH} ${REPOS_ROUTE}`, () => {
  test("persists the worktree parent directory", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: PATCH,
      body: JSON.stringify({ worktreeParentDir: "/tmp/worktrees" }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      (await readConfig(symphonyDir)).settings.worktreeParentDir,
      "/tmp/worktrees"
    );
  });

  test("persists the confirmation flag, including when it is false", async () => {
    const symphonyDir = makeTempDir();

    await dispatchRepos(() => symphonyDir, {
      method: PATCH,
      body: JSON.stringify({ worktreeParentDirConfirmed: false }),
    });

    assert.equal(
      (await readConfig(symphonyDir)).settings.worktreeParentDirConfirmed,
      false
    );
  });

  test("rejects a malformed JSON body", async () => {
    const symphonyDir = makeTempDir();

    const response = await dispatchRepos(() => symphonyDir, {
      method: PATCH,
      body: "{ not json",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error, "Invalid JSON body");
  });

  test("rejects a body carrying no recognised setting", async () => {
    const symphonyDir = makeTempDir();

    for (const body of [
      {},
      { unrelated: "value" },
      { worktreeParentDir: 7 },
      { worktreeParentDirConfirmed: "yes" },
    ]) {
      const response = await dispatchRepos(() => symphonyDir, {
        method: PATCH,
        body: JSON.stringify(body),
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error, "No settings to update");
    }
  });

  test("merges an update into settings rather than replacing them", async () => {
    const symphonyDir = makeTempDir();

    await dispatchRepos(() => symphonyDir, {
      method: PATCH,
      body: JSON.stringify({ worktreeParentDir: "/tmp/worktrees" }),
    });
    await dispatchRepos(() => symphonyDir, {
      method: PATCH,
      body: JSON.stringify({ worktreeParentDirConfirmed: true }),
    });

    assert.deepEqual((await readConfig(symphonyDir)).settings, {
      worktreeParentDir: "/tmp/worktrees",
      worktreeParentDirConfirmed: true,
    });
  });
});

describe(`${REPOS_ROUTE} — failure handling on the writing routes`, () => {
  const writes: [string, string, string][] = [
    [POST, JSON.stringify({ path: "/tmp/x" }), "Failed to add repo"],
    [
      PATCH,
      JSON.stringify({ worktreeParentDir: "/tmp/w" }),
      "Failed to update settings",
    ],
  ];

  for (const [method, body, prefix] of writes) {
    test(`${method} answers 500 naming the failure`, async () => {
      const response = await dispatchRepos(
        () => {
          throw new Error("symphony dir exploded");
        },
        { method, body }
      );

      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error, `${prefix}: symphony dir exploded`);
    });

    test(`${method} names a non-Error throw as an unknown error`, async () => {
      const response = await dispatchRepos(
        () => {
          // biome-ignore lint/style/useThrowOnlyError: driving the non-Error branch
          throw "not an error object";
        },
        { method, body }
      );

      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error, `${prefix}: Unknown error`);
    });

    test(`${method} rethrows the onboarding error so the dispatcher answers 503`, async () => {
      const response = await dispatchRepos(
        () => {
          throw new SymphonyDirNotConfiguredError();
        },
        { method, body }
      );

      assert.equal(response.statusCode, 503);
    });
  }

  test(`${DELETE} answers 500 naming the failure`, async () => {
    const response = await dispatchRepos(
      () => {
        throw new Error("symphony dir exploded");
      },
      { method: DELETE, query: { path: "/tmp/x" } }
    );

    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.error,
      "Failed to remove repo: symphony dir exploded"
    );
  });

  test(`${DELETE} rethrows the onboarding error so the dispatcher answers 503`, async () => {
    const response = await dispatchRepos(
      () => {
        throw new SymphonyDirNotConfiguredError();
      },
      { method: DELETE, query: { path: "/tmp/x" } }
    );

    assert.equal(response.statusCode, 503);
  });

  test(`${GET} names a non-Error throw as an unknown error`, async () => {
    const response = await dispatchRepos(
      () => {
        // biome-ignore lint/style/useThrowOnlyError: driving the non-Error branch
        throw "not an error object";
      },
      { method: GET }
    );

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error, "Failed to list repos: Unknown error");
  });
});
