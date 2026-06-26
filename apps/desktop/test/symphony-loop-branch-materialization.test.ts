import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { additionalRepoDisambiguator } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";
import { createFakeRunLoopScript } from "./symphony-test-utils.js";

const execFileAsync = promisify(execFile);

type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

const serversToClose: DesktopGatewayServer[] = [];
const apiServersToClose: http.Server[] = [];
const tempPathsToClean: string[] = [];
const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SYMPHONY_WORKTREE_PARENT_DIR: process.env.SYMPHONY_WORKTREE_PARENT_DIR,
  CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE:
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE,
};

afterEach(async () => {
  restoreEnv("HOME", originalEnv.HOME);
  restoreEnv("PATH", originalEnv.PATH);
  restoreEnv(
    "SYMPHONY_WORKTREE_PARENT_DIR",
    originalEnv.SYMPHONY_WORKTREE_PARENT_DIR
  );
  restoreEnv(
    "CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE",
    originalEnv.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE
  );
  resetShellPathCache();

  for (const server of serversToClose.splice(0)) {
    await server.stop();
  }
  for (const server of apiServersToClose.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function startBranchApi(options?: {
  failBranchArtifact?: number;
  failBody?: string;
  hangBranchArtifact?: boolean;
}): Promise<{
  port: number;
  requests: RecordedRequest[];
  waitForRequest: (
    urlSubstring: string,
    timeoutMs?: number
  ) => Promise<RecordedRequest>;
  server: http.Server;
}> {
  const requests: RecordedRequest[] = [];
  const waiters: Array<{
    urlSubstring: string;
    resolve: (request: RecordedRequest) => void;
  }> = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (recorded.url.includes(waiters[i].urlSubstring)) {
          waiters[i].resolve(recorded);
          waiters.splice(i, 1);
        }
      }

      if (recorded.url.includes("/branch-artifact")) {
        if (options?.hangBranchArtifact) {
          return;
        }
        if (options?.failBranchArtifact) {
          res.statusCode = options.failBranchArtifact;
          res.setHeader("content-type", "text/plain");
          res.end(options.failBody ?? "injected failure");
          return;
        }
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true }));
    })().catch((err) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  apiServersToClose.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind branch API server");
  }

  function waitForRequest(
    urlSubstring: string,
    timeoutMs = 20_000
  ): Promise<RecordedRequest> {
    const existing = requests.find((request) =>
      request.url.includes(urlSubstring)
    );
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<RecordedRequest>((resolve, reject) => {
      const entry = { urlSubstring, resolve };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(entry);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for ${urlSubstring}`));
      }, timeoutMs);
      waiters.push({
        urlSubstring,
        resolve: (request) => {
          clearTimeout(timer);
          resolve(request);
        },
      });
    });
  }

  return { port: address.port, requests, waitForRequest, server };
}

async function createRepoWithOrigin(
  root: string,
  name: string
): Promise<{ repoPath: string; originPath: string; fullName: string }> {
  const originPath = path.join(root, `${name}.git`);
  const repoPath = path.join(root, name);
  await execFileAsync("git", ["init", "--bare", "-b", "main", originPath]);
  await execFileAsync("git", ["clone", originPath, repoPath]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoPath,
  });
  await execFileAsync("git", ["config", "user.name", "Test User"], {
    cwd: repoPath,
  });
  await fs.writeFile(path.join(repoPath, "README.md"), `# ${name}\n`);
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  await execFileAsync("git", ["push", "-u", "origin", "main"], {
    cwd: repoPath,
  });
  const fullName = `org/${name}`;
  await execFileAsync(
    "git",
    ["remote", "set-url", "origin", `git@github.com:${fullName}.git`],
    { cwd: repoPath }
  );
  await execFileAsync(
    "git",
    ["remote", "set-url", "--push", "origin", originPath],
    {
      cwd: repoPath,
    }
  );
  return { repoPath, originPath, fullName };
}

async function setupLoopRuntime(tmpDir: string): Promise<void> {
  process.env.HOME = tmpDir;
  process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
  process.env.SYMPHONY_WORKTREE_PARENT_DIR = path.join(tmpDir, "worktrees");
  await fs.mkdir(process.env.SYMPHONY_WORKTREE_PARENT_DIR, { recursive: true });
  await createFakeRunLoopScript(tmpDir, "#!/bin/sh\nexit 0\n");

  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(
    path.join(fakeBin, "claude"),
    [
      "#!/bin/sh",
      'echo \'{"type":"result","subtype":"success","result":"","is_error":false}\'',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 }
  );
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();
}

async function installFailingPushGit(tmpDir: string): Promise<void> {
  const fakeGit = path.join(tmpDir, "fake-bin", "git");
  await fs.writeFile(
    fakeGit,
    [
      "#!/bin/sh",
      'if [ "$1" = "push" ]; then',
      '  echo "fatal: https://user:secret-token@github.com/org/repo.git Bearer secret-token sk-abcdefghijklmnop" >&2',
      "  exit 1",
      "fi",
      'exec /usr/bin/git "$@"',
    ].join("\n"),
    { mode: 0o755 }
  );
  resetShellPathCache();
  setShellPathForTest();
}

async function startGateway(
  tmpDir: string,
  apiPort: number
): Promise<DesktopGatewayServer> {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [tmpDir],
    machineName: "branch-materialization-test",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    discoveryFilePath: path.join(tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${apiPort}`,
    getGatewayId: () => "test-gateway-id",
  });
  serversToClose.push(server);
  await server.start();
  return server;
}

async function postLoop(
  server: DesktopGatewayServer,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${server.getActivePort()}/api/gateway/symphony/loop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function branchMaterialization(
  entries: Array<{
    role: "primary" | "additional";
    repositoryFullName: string;
    baseBranch?: string;
    branchName: string;
  }>
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    branches: entries.map((entry) => ({
      role: entry.role,
      repositoryFullName: entry.repositoryFullName,
      baseBranch: entry.baseBranch ?? "main",
      branchName: entry.branchName,
    })),
  };
}

async function assertRemoteBranch(
  originPath: string,
  branchName: string
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["--git-dir", originPath, "rev-parse", branchName],
    { encoding: "utf8" }
  );
  return String(result.stdout).trim();
}

async function createWorktreeForBranch(
  repoPath: string,
  worktreeDir: string,
  branchName: string
): Promise<void> {
  await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "-B", branchName, worktreeDir, "main"],
    {
      cwd: repoPath,
    }
  );
}

function branchArtifactRequests(
  requests: RecordedRequest[],
  loopId: string
): RecordedRequest[] {
  return requests.filter((request) =>
    request.url.includes(`/loops/${loopId}/branch-artifact`)
  );
}

test("fresh PLAN pushes expected primary branch and records branch artifact", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-plan-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "primary-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113201";
  const branchName = "symphony/server-owned-plan-branch";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan the change",
    artifactSlug: "PLN-604",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 200, await response.text());
  const callback = await api.waitForRequest(`/loops/${loopId}/branch-artifact`);
  assert.equal(callback.method, "POST");
  assert.equal(callback.headers.authorization, "Bearer loop-token");
  const payload = JSON.parse(callback.body) as Record<string, unknown>;
  assert.deepEqual(
    {
      repositoryFullName: payload.repositoryFullName,
      branchName: payload.branchName,
      baseBranch: payload.baseBranch,
      defaultBranch: payload.defaultBranch,
    },
    {
      repositoryFullName: repo.fullName,
      branchName,
      baseBranch: "main",
      defaultBranch: "main",
    }
  );
  assert.equal(typeof payload.headSha, "string");
  assert.equal(
    await assertRemoteBranch(repo.originPath, branchName),
    payload.headSha
  );
});

test("fresh PLAN matches branch materialization repository names case-insensitively", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-plan-case-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "case-primary-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113207";
  const branchName = "symphony/server-owned-plan-branch-case";
  const declaredFullName = repo.fullName.toUpperCase();
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan the change",
    artifactSlug: "PLN-604",
    localRepoPath: repo.repoPath,
    repo: { fullName: declaredFullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 200, await response.text());
  const callback = await api.waitForRequest(`/loops/${loopId}/branch-artifact`);
  const payload = JSON.parse(callback.body) as Record<string, unknown>;
  assert.deepEqual(
    {
      repositoryFullName: payload.repositoryFullName,
      branchName: payload.branchName,
      baseBranch: payload.baseBranch,
      defaultBranch: payload.defaultBranch,
    },
    {
      repositoryFullName: declaredFullName,
      branchName,
      baseBranch: "main",
      defaultBranch: "main",
    }
  );
  assert.equal(typeof payload.headSha, "string");
  assert.equal(
    await assertRemoteBranch(repo.originPath, branchName),
    payload.headSha
  );
});

test("fresh PLAN rejects mismatched local origin before push or branch record", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "branch-repo-mismatch-")
  );
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "actual-primary-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113212";
  const declaredFullName = "org/declared-primary-repo";
  const branchName = "symphony/server-owned-mismatched-repo";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan with mismatched repo identity",
    artifactSlug: "PLN-604-mismatched-repo",
    localRepoPath: repo.repoPath,
    repo: { fullName: declaredFullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: declaredFullName, branchName },
    ]),
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /does not match local origin/);
  assert.equal(branchArtifactRequests(api.requests, loopId).length, 0);
  await assert.rejects(assertRemoteBranch(repo.originPath, branchName));
});

test("git push failure reports BranchCreateFailed without callback or secret leakage", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-push-fail-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "push-fail-repo");
  await installFailingPushGit(tmpDir);
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113213";
  const branchName = "symphony/server-owned-push-fail";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan with push failure",
    artifactSlug: "PLN-604-push-fail",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Failed to materialize PLAN branch/);
  assert.ok(!body.error.includes("secret-token"));
  assert.ok(!body.error.includes("sk-abcdefghijklmnop"));
  assert.equal(branchArtifactRequests(api.requests, loopId).length, 0);
  const event = api.requests.find((request) =>
    request.url.includes(`/loops/${loopId}/events`)
  );
  assert.ok(event, "expected BranchCreateFailed loop event");
  const eventBody = JSON.parse(event.body) as {
    code?: string;
    message?: string;
  };
  assert.equal(eventBody.code, LoopErrorCode.BranchCreateFailed);
  assert.ok(!String(eventBody.message).includes("secret-token"));
  assert.ok(!String(eventBody.message).includes("sk-abcdefghijklmnop"));
  await assert.rejects(assertRemoteBranch(repo.originPath, branchName));
});

test("fresh PLAN removes stale deterministic directory before branch record", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-stale-dir-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "stale-dir-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const artifactSlug = "PLN-604-stale-dir";
  const worktreeDir = path.join(
    process.env.SYMPHONY_WORKTREE_PARENT_DIR!,
    `${path.basename(repo.repoPath)}-loop-pln-604-stale-dir`
  );
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.writeFile(path.join(worktreeDir, "stale.txt"), "stale");

  const loopId = "00000000-0000-0000-0000-000000113209";
  const branchName = "symphony/server-owned-stale-dir-branch";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan the change",
    artifactSlug,
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 200, await response.text());
  await api.waitForRequest(`/loops/${loopId}/branch-artifact`);
  assert.equal(
    await assertRemoteBranch(repo.originPath, branchName),
    await assertRemoteBranch(repo.originPath, "main")
  );
  await assert.rejects(fs.access(path.join(worktreeDir, "stale.txt")));
});

test("fresh EXECUTE and REQUEST_CHANGES record branches; reused EXECUTE does not record again", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-execute-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "execute-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const executeLoopId = "00000000-0000-0000-0000-000000113202";
  const executeBranch = "symphony/server-owned-execute-branch";
  const executeBody = {
    loopId: executeLoopId,
    command: LoopCommand.Execute,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Execute the plan",
    artifactSlug: "PLN-604-execute",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      {
        role: "primary" as const,
        repositoryFullName: repo.fullName,
        branchName: executeBranch,
      },
    ]),
  };

  let response = await postLoop(server, executeBody);
  assert.equal(response.status, 200, await response.text());
  await api.waitForRequest(`/loops/${executeLoopId}/branch-artifact`);
  assert.equal(branchArtifactRequests(api.requests, executeLoopId).length, 1);

  const reusedLoopId = "00000000-0000-0000-0000-000000113203";
  response = await postLoop(server, {
    ...executeBody,
    loopId: reusedLoopId,
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(
    branchArtifactRequests(api.requests, reusedLoopId).length,
    0,
    "reused EXECUTE worktree must not post a new branch-artifact callback"
  );

  const requestChangesLoopId = "00000000-0000-0000-0000-000000113204";
  const requestChangesBranch = "symphony/server-owned-request-changes-branch";
  response = await postLoop(server, {
    loopId: requestChangesLoopId,
    command: LoopCommand.RequestChanges,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Amend the plan",
    artifactSlug: "PLN-604-request-changes",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      {
        role: "primary",
        repositoryFullName: repo.fullName,
        branchName: requestChangesBranch,
      },
    ]),
  });
  assert.equal(response.status, 200, await response.text());
  await api.waitForRequest(`/loops/${requestChangesLoopId}/branch-artifact`);
  assert.equal(
    await assertRemoteBranch(repo.originPath, requestChangesBranch),
    await assertRemoteBranch(repo.originPath, "main")
  );
});

test("GENERATE_PRD records expected primary branch before PRD command starts", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-prd-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "prd-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113205";
  const branchName = "symphony/server-owned-prd-branch";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.GeneratePrd,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Generate the PRD",
    artifactSlug: "PRD-604",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 200, await response.text());
  const callback = await api.waitForRequest(`/loops/${loopId}/branch-artifact`);
  const payload = JSON.parse(callback.body) as Record<string, unknown>;
  assert.equal(payload.repositoryFullName, repo.fullName);
  assert.equal(payload.branchName, branchName);
  assert.equal(payload.baseBranch, "main");
});

test("fresh GENERATE_PRD removes stale deterministic directory before branch record", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "branch-prd-stale-dir-")
  );
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "prd-stale-dir-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const artifactSlug = "PRD-604-stale-dir";
  const worktreeDir = path.join(
    process.env.SYMPHONY_WORKTREE_PARENT_DIR!,
    `${path.basename(repo.repoPath)}-loop-generate-prd-prd-604-stale-dir`
  );
  await fs.mkdir(path.join(worktreeDir, "node_modules", "pkg"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(worktreeDir, "node_modules", "pkg", "stale.txt"),
    "stale"
  );

  const loopId = "00000000-0000-0000-0000-000000113207";
  const branchName = "symphony/server-owned-prd-stale-dir-branch";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.GeneratePrd,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Generate the PRD",
    artifactSlug,
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      { role: "primary", repositoryFullName: repo.fullName, branchName },
    ]),
  });

  assert.equal(response.status, 200, await response.text());
  await api.waitForRequest(`/loops/${loopId}/branch-artifact`);
  assert.equal(
    await assertRemoteBranch(repo.originPath, branchName),
    await assertRemoteBranch(repo.originPath, "main")
  );
  await assert.rejects(
    fs.access(path.join(worktreeDir, "node_modules", "pkg", "stale.txt"))
  );
});

test("legacy PLAN payload without branch materialization uses legacy worktree setup", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-missing-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "missing-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113206";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan the change",
    artifactSlug: "PLN-604-missing",
    repo: { fullName: repo.fullName, branch: "main" },
  });

  assert.equal(response.status, 200, await response.text());
  assert.equal(
    branchArtifactRequests(api.requests, loopId).length,
    0,
    "legacy payloads without branchMaterialization must not call the new branch-artifact endpoint"
  );
});

test("EXECUTE with branch materialization fails closed instead of reusing stale legacy worktree", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "branch-legacy-exec-")
  );
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "legacy-exec-repo");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const artifactSlug = "PLN-604-legacy-exec";
  const legacyBranchName = "symphony/pln-604-legacy-exec";
  const legacyWorktreeDir = path.join(tmpDir, "legacy-exec-worktree");
  await createWorktreeForBranch(
    repo.repoPath,
    legacyWorktreeDir,
    legacyBranchName
  );

  const loopId = "00000000-0000-0000-0000-000000113210";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Execute,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Execute with stale legacy worktree present",
    artifactSlug,
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      {
        role: "primary",
        repositoryFullName: "org/different-repo",
        branchName: "symphony/server-owned-exec-branch",
      },
    ]),
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /branch materialization is not available/);
  assert.equal(branchArtifactRequests(api.requests, loopId).length, 0);
});

test("PLAN with branch materialization fails closed instead of reusing stale legacy additional worktree", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "branch-legacy-add-"));
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const primary = await createRepoWithOrigin(tmpDir, "legacy-add-primary");
  const additional = await createRepoWithOrigin(tmpDir, "legacy-add-sidecar");
  const api = await startBranchApi();
  const server = await startGateway(tmpDir, api.port);

  const artifactSlug = "PLN-604-legacy-additional";
  const worktreeKey = "pln-604-legacy-additional";
  const legacyAdditionalBranch = `symphony/${worktreeKey}-main-${additionalRepoDisambiguator(additional.repoPath)}`;
  const legacyAdditionalWorktreeDir = path.join(
    tmpDir,
    "legacy-additional-worktree"
  );
  await createWorktreeForBranch(
    additional.repoPath,
    legacyAdditionalWorktreeDir,
    legacyAdditionalBranch
  );

  const loopId = "00000000-0000-0000-0000-000000113211";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan with stale sidecar worktree present",
    artifactSlug,
    repo: { fullName: primary.fullName, branch: "main" },
    additionalRepos: [
      {
        localRepoPath: additional.repoPath,
        fullName: additional.fullName,
        branch: "main",
      },
    ],
    branchMaterialization: branchMaterialization([
      {
        role: "primary",
        repositoryFullName: primary.fullName,
        branchName: "symphony/server-owned-primary-only",
      },
    ]),
  });

  assert.equal(response.status, 500);
  const payloads = branchArtifactRequests(api.requests, loopId).map(
    (request) => JSON.parse(request.body) as Record<string, unknown>
  );
  assert.equal(
    payloads.some(
      (payload) => payload.repositoryFullName === additional.fullName
    ),
    false,
    "missing additional branchMaterialization entry must not reuse or record the legacy sidecar branch"
  );
});

test("branch artifact callback failure aborts without leaking secrets", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "branch-callback-fail-")
  );
  tempPathsToClean.push(tmpDir);
  await setupLoopRuntime(tmpDir);
  const repo = await createRepoWithOrigin(tmpDir, "callback-fail-repo");
  const api = await startBranchApi({
    failBranchArtifact: 500,
    failBody:
      "failed with Bearer secret-token and sk-abcdefghijklmnop token=secret",
  });
  const server = await startGateway(tmpDir, api.port);

  const loopId = "00000000-0000-0000-0000-000000113207";
  const response = await postLoop(server, {
    loopId,
    command: LoopCommand.Plan,
    closedLoopAuthToken: "loop-token",
    artifacts: [],
    prompt: "Plan the change",
    artifactSlug: "PLN-604-callback-fail",
    repo: { fullName: repo.fullName, branch: "main" },
    branchMaterialization: branchMaterialization([
      {
        role: "primary",
        repositoryFullName: repo.fullName,
        branchName: "symphony/server-owned-callback-fail",
      },
    ]),
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.ok(!body.error.includes("secret-token"));
  assert.ok(!body.error.includes("sk-abcdefghijklmnop"));
  assert.match(body.error, /Bearer \[REDACTED\]/);
  assert.match(body.error, /\[REDACTED_SK_KEY\]/);
});
