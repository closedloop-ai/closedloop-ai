/**
 * ISS-5299 Wave 2 (part 2) — Deploy + learnings overflow branch coverage.
 * Split from gateway-platform-ops.test.ts to stay under the 1 000-line ceiling.
 *
 * Targeted uncovered branches in deploy.ts:
 *   — line 504: repos.json deployment config used when no in-memory entry (repoEntry?.deployment)
 *   — line 511: port IS listening → active=true
 *   — line 767: resolveInstallCommand — npm branch
 *   — lines 805/808: resolveStartCommand — yarn.lock present → "yarn start"
 *
 * Targeted uncovered branches in learnings.ts (overflow from file 1):
 *   — line 286: process-learnings pending dir empty → status=skipped
 *   — line 518: pending-learnings catch with non-Error throw → String(err) branch
 *   — line 743: parseToon patterns[ prefix → candidateLine = lines[1]
 *   — process-all-learnings GET: status=none (absent file) and file-read paths
 *
 * SKIPPED (unreachable or environment-dependent):
 *   — "throw error" re-throw paths in catch blocks (only DirectoryNotAllowedError ever thrown)
 *   — port ternary false branch (detectDefaultPort always returns a number)
 *   — scripts ?? {} false branch (early return before reaching that line)
 *   — persistDeploymentConfig repo.path === repoPath branch (expandHome is deterministic)
 *   — health-poll catch (background async, no public entry point)
 *   — triggerSuccessRateComputation deep branches (require installed claude plugins)
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerDeployRoutes } from "../src/server/operations/deploy.js";
import { registerLearningsRoutes } from "../src/server/operations/learnings.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import { restoreEnvVars, saveEnvVars } from "./symphony-test-utils.js";

// ── module-level regex constants (Biome useTopLevelRegex) ─────────────────────
const RE_NONE = /^none$/;
const RE_SKIPPED = /skipped/;

const { makeTempDir } = createGitOpTempDirs("iss5299-gw-deploy-");

function makeDeployDispatcher(
  allowedDir: string,
  symphonyDir?: string
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerDeployRoutes(
    d,
    () => [allowedDir],
    () => symphonyDir ?? path.join(allowedDir, ".symphony")
  );
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gateway/deploy/check-existing — deployment-config + port branches
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/deploy/check-existing — deployment-config + port branches", () => {
  test("uses repos.json deployment config and returns active=false when port is not listening (line 504)", async () => {
    const tmpDir = makeTempDir();
    const repoDir = path.join(tmpDir, "myrepo");
    const worktreeDir = path.join(tmpDir, "myrepo-ISS-1");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    const symphonyDir = path.join(tmpDir, ".symphony");
    const configDir = path.join(symphonyDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "repos.json"),
      JSON.stringify({
        repos: [
          {
            path: repoDir,
            addedAt: new Date().toISOString(),
            deployment: { port: 19_999, framework: "node" },
          },
        ],
        settings: {},
      }),
      "utf-8"
    );
    const d = makeDeployDispatcher(tmpDir, symphonyDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/deploy/check-existing",
      body: JSON.stringify({
        repoPath: repoDir,
        worktreePath: worktreeDir,
      }),
    });
    assert.equal(res.statusCode, 200);
    // Port 19999 is almost certainly not listening — active=false
    assert.equal(res.body.active, false);
  });

  test("returns active=true when repos.json deployment config port IS listening (line 511)", {
    timeout: 10_000,
  }, async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (server.address() as net.AddressInfo).port;
    try {
      const tmpDir = makeTempDir();
      const repoDir = path.join(tmpDir, "myrepo");
      const worktreeDir = path.join(tmpDir, "myrepo-ISS-1");
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(worktreeDir, { recursive: true });
      const symphonyDir = path.join(tmpDir, ".symphony");
      const configDir = path.join(symphonyDir, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        path.join(configDir, "repos.json"),
        JSON.stringify({
          repos: [
            {
              path: repoDir,
              addedAt: new Date().toISOString(),
              deployment: { port, framework: "node" },
            },
          ],
          settings: {},
        }),
        "utf-8"
      );
      const d = makeDeployDispatcher(tmpDir, symphonyDir);
      const res = await dispatchOperation({
        dispatcher: d,
        method: "POST",
        pathname: "/api/gateway/deploy/check-existing",
        body: JSON.stringify({
          repoPath: repoDir,
          worktreePath: worktreeDir,
        }),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.active, true);
      assert.equal(res.body.url, `http://localhost:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gateway/deploy/detect — resolveInstallCommand and resolveStartCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/gateway/deploy/detect — resolveInstallCommand and resolveStartCommand branches", () => {
  test("uses npm install when packageManager starts with 'npm' (line 767)", async () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { dev: "node server.js" },
        packageManager: "npm@9.0.0",
      }),
      "utf-8"
    );
    const d = makeDeployDispatcher(tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/deploy/detect",
      body: JSON.stringify({ repoPath: tmpDir }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
    assert.equal(
      (res.body.config as { installCommand: string }).installCommand,
      "npm install"
    );
  });

  test("returns 'yarn start' when package.json has start script and yarn.lock exists (lines 805/808)", async () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { start: "node server.js" },
        dependencies: { express: "^4.18.0" },
      }),
      "utf-8"
    );
    // yarn.lock present, pnpm-lock.yaml absent
    writeFileSync(path.join(tmpDir, "yarn.lock"), "", "utf-8");
    const d = makeDeployDispatcher(tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/deploy/detect",
      body: JSON.stringify({ repoPath: tmpDir }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, true);
    assert.equal(
      (res.body.config as { startCommand: string }).startCommand,
      "yarn start",
      "should use yarn start when yarn.lock is present and no pnpm-lock.yaml"
    );
  });

  test("returns detected=false when package.json has no start or dev script", async () => {
    const tmpDir = makeTempDir();
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
      "utf-8"
    );
    const d = makeDeployDispatcher(tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/deploy/detect",
      body: JSON.stringify({ repoPath: tmpDir }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.detected, false);
  });
});

// ── learnings dispatcher factory (shared by learnings overflow tests) ──────────

function makeLearningsDispatcher(
  allowedDirs: string[],
  symphonyDir: string
): OperationDispatcher {
  const d = new OperationDispatcher();
  registerLearningsRoutes(
    d,
    () => allowedDirs,
    () => symphonyDir
  );
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET /api/gateway/symphony/process-all-learnings
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/process-all-learnings", () => {
  test("returns status=none when batch-processing-status.json is absent", async () => {
    const tmpDir = makeTempDir();
    const homeDir = makeTempDir();
    const origHomeEnv = saveEnvVars(["HOME"]);
    process.env.HOME = homeDir;
    try {
      const d = makeLearningsDispatcher([tmpDir], tmpDir);
      const res = await dispatchOperation({
        dispatcher: d,
        method: "GET",
        pathname: "/api/gateway/symphony/process-all-learnings",
      });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.body.status), RE_NONE);
    } finally {
      restoreEnvVars(origHomeEnv);
    }
  });

  test("reads and returns batch status when file exists", async () => {
    const tmpDir = makeTempDir();
    const homeDir = makeTempDir();
    const origHomeEnv = saveEnvVars(["HOME"]);
    process.env.HOME = homeDir;
    try {
      const statusDir = path.join(homeDir, ".closedloop-ai", "learnings");
      mkdirSync(statusDir, { recursive: true });
      writeFileSync(
        path.join(statusDir, "batch-processing-status.json"),
        JSON.stringify({ status: "completed", worktreeCount: 2 }),
        "utf-8"
      );
      const d = makeLearningsDispatcher([tmpDir], tmpDir);
      const res = await dispatchOperation({
        dispatcher: d,
        method: "GET",
        pathname: "/api/gateway/symphony/process-all-learnings",
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, "completed");
      assert.equal(res.body.worktreeCount, 2);
    } finally {
      restoreEnvVars(origHomeEnv);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — GET pending-learnings — outer catch with non-Error throw
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/symphony/pending-learnings — non-Error throw in catch (line 518)", () => {
  test("returns 500 with 'Unknown error' when getSymphonyDir throws a non-Error", async () => {
    const d = new OperationDispatcher();
    registerLearningsRoutes(
      d,
      () => [],
      () => {
        // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw to cover String(err) branch
        throw "not-an-error-string";
      }
    );
    const res = await dispatchOperation({
      dispatcher: d,
      method: "GET",
      pathname: "/api/gateway/symphony/pending-learnings",
    });
    assert.equal(res.statusCode, 500);
    assert.ok(
      String(res.body.error).includes("Unknown error"),
      "non-Error throw should produce 'Unknown error' message"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// learnings.ts — parseToon patterns[ prefix + process-learnings skipped
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/gateway/learnings — parseToon patterns[ prefix (line 743)", () => {
  test("extracts candidateLine from lines[1] when lines[0] starts with 'patterns['", async () => {
    const homeDir = makeTempDir();
    const origHomeEnv = saveEnvVars(["HOME"]);
    process.env.HOME = homeDir;
    try {
      const toonContent =
        'patterns[0,0,"pattern"]\ngeneral,context,"CSV Summary Here"\n\nplain-text chunk';
      const toonPath = path.join(
        homeDir,
        ".closedloop-ai",
        "learnings",
        "org-patterns.toon"
      );
      mkdirSync(path.dirname(toonPath), { recursive: true });
      writeFileSync(toonPath, toonContent, "utf-8");
      const d = makeLearningsDispatcher([], homeDir);
      const res = await dispatchOperation({
        dispatcher: d,
        method: "GET",
        pathname: "/api/gateway/learnings",
      });
      assert.equal(res.statusCode, 200);
      const patterns = res.body.patterns as Array<{
        summary: string;
        id: string;
      }>;
      assert.equal(patterns.length, 2);
      assert.equal(
        patterns[0]?.summary,
        "CSV Summary Here",
        "CSV match should extract the quoted summary field"
      );
      assert.equal(patterns[1]?.summary, "plain-text chunk");
    } finally {
      restoreEnvVars(origHomeEnv);
    }
  });

  test("POST process-learnings: pending dir exists but is empty → status=skipped (line 286)", async () => {
    const tmpDir = makeTempDir();
    const worktreeDir = path.join(tmpDir, "my-repo-AI-100");
    const pendingDir = path.join(
      worktreeDir,
      ".closedloop-ai",
      "work",
      ".learnings",
      "pending"
    );
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(path.join(pendingDir, "not-json.txt"), "ignore me");
    const d = makeLearningsDispatcher([tmpDir], tmpDir);
    const res = await dispatchOperation({
      dispatcher: d,
      method: "POST",
      pathname: "/api/gateway/symphony/process-learnings",
      body: JSON.stringify({
        ticketId: "AI-100",
        repoPath: path.join(tmpDir, "my-repo"),
        waitForExtraction: false,
      }),
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body.status), RE_SKIPPED);
  });
});
