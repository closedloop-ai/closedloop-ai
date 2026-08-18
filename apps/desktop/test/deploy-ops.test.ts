/**
 * ISS-5299 — Branch coverage for apps/desktop/src/server/operations/deploy.ts
 *
 * Covers the 49 uncovered branches listed in .closedloop-ai/uncovered-branches.json:
 * validation arms (400/403) for the health, status, check-existing, and detect routes;
 * all five determineStatus() outcomes; all isProcessAlive() arms; detectFramework /
 * resolveStartCommand / detectDefaultPort / resolveInstallCommand decision paths driven
 * by FS-fixture package.json variants; persistDeploymentConfig when a matching repo
 * entry already exists; and both branches of resolveWorktreeParent (env-var configured
 * vs default dirname).
 *
 * Exists as a separate file — not appended to deploy-outbound-policy.test.ts — because
 * AGENTS.md prohibits growing any grandfathered suite and that file is on the shrink-only
 * grandfather list in biome.jsonc.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerDeployRoutes } from "../src/server/operations/deploy.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

// createGitOpTempDirs registers its own afterEach for directory cleanup.
const { makeTempDir } = createGitOpTempDirs("iss5299-deploy-");

const originalFetch = globalThis.fetch;
// Map<envKey, previous value | undefined> — restored per-key in afterEach.
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, prev] of savedEnv) {
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = prev;
    }
  }
  savedEnv.clear();
});

// ─── Shared helpers ─────────────────────────────────────────────────────────

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key]);
  }
  process.env[key] = value;
}

/**
 * Build a fresh OperationDispatcher with all deploy routes registered.
 * allowedDir is the only directory the security layer will permit.
 * symphonyDir is where repos.json / config lives (defaults to <allowedDir>/.symphony).
 */
function makeDispatcher(
  allowedDir: string,
  symphonyDir?: string
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerDeployRoutes(
    dispatcher,
    () => [allowedDir],
    () => symphonyDir ?? path.join(allowedDir, ".symphony")
  );
  return dispatcher;
}

/**
 * Create the directory layout the status route expects:
 *   baseTmpDir/
 *     myrepo/           ← the "repo" (repoPath query param)
 *     myrepo-ISS-1/     ← the derived worktree
 *       .closedloop-ai/work/
 *
 * Returns paths that callers can pre-populate with deploy state files.
 */
async function makeStatusDirs(baseTmpDir: string): Promise<{
  repoDir: string;
  worktreeDir: string;
  workDir: string;
}> {
  const repoDir = path.join(baseTmpDir, "myrepo");
  const worktreeDir = path.join(baseTmpDir, "myrepo-ISS-1");
  const workDir = path.join(worktreeDir, ".closedloop-ai", "work");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  return { repoDir, worktreeDir, workDir };
}

/** Fire GET /api/gateway/deploy/status/ISS-1 with an optional pid query param. */
function doStatusRequest(
  dispatcher: OperationDispatcher,
  repoDir: string,
  pid?: string
) {
  const query: Record<string, string> = { repo: repoDir };
  if (pid !== undefined) {
    query.pid = pid;
  }
  return dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/deploy/status/ISS-1",
    query,
    body: "",
  });
}

// ─── POST /api/gateway/deploy/health — validation (lines 203, 209, 240) ────

test("health route returns 400 for invalid JSON body", async () => {
  const dispatcher = makeDispatcher(os.tmpdir());
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/health",
    body: "not-valid-json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("health route returns 400 when url field is absent from body", async () => {
  const dispatcher = makeDispatcher(os.tmpdir());
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/health",
    body: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "url is required");
});

test("health route returns alive:false with null statusCode when fetch throws", async () => {
  const dispatcher = makeDispatcher(os.tmpdir());
  globalThis.fetch = (
    _input: string | URL | Request,
    _init?: RequestInit
  ): Promise<Response> => Promise.reject(new Error("connection refused"));
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/health",
    body: JSON.stringify({ url: "http://app.localhost:19998/" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alive, false);
  assert.equal(res.body.statusCode, null);
});

// ─── GET /api/gateway/deploy/status/:ticketId — validation (lines 395, 403, 421) ─

test("status route returns 400 when repo query param is absent", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/deploy/status/ISS-1",
    body: "",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repo query param is required");
});

test("status route returns 403 when repo is outside the allowed directories", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/deploy/status/ISS-1",
    query: { repo: path.join(os.tmpdir(), "not-in-sandbox") },
    body: "",
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

test("status route returns 403 when derived worktreeDir is outside allowed directories", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "myrepo");
  await fs.mkdir(repoDir, { recursive: true });
  // Route worktree parent to homedir — outside tmpDir → assertPathAllowed throws.
  setEnv("SYMPHONY_WORKTREE_PARENT_DIR", os.homedir());
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ─── GET /api/gateway/deploy/status/:ticketId — determineStatus() ───────────
//   lines 433, 446, 448, 455, 456, 457, 458, 866, 869, 872, 875

test("status route reports failed when deploy-exit.json exists", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  await fs.writeFile(
    path.join(workDir, "deploy-exit.json"),
    JSON.stringify({ exitCode: 1, failedCommand: "npm run deploy" })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "failed");
  // error field is populated when exitInfo is present (line 458 true branch).
  assert.ok(
    typeof res.body.error === "string" && res.body.error.includes("1"),
    `expected error message with exit code; got: ${res.body.error}`
  );
});

test("status route reports completed when deploy-result.json has a url", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  await fs.writeFile(
    path.join(workDir, "deploy-result.json"),
    JSON.stringify({ url: "http://localhost:3000", serviceId: "svc-99" })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "completed");
  // line 456 — deployResult?.url is returned
  assert.equal(res.body.deployedUrl, "http://localhost:3000");
  // line 457 — deployResult?.serviceId is returned
  assert.equal(res.body.serviceId, "svc-99");
});

test("status route reports running when the given pid belongs to an alive process", async () => {
  const tmpDir = makeTempDir();
  const { repoDir } = await makeStatusDirs(tmpDir);
  // Our own PID is guaranteed alive. isProcessAlive(process.pid) → true.
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir, String(process.pid));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "running");
  // line 455 — pid parsed from pidRaw
  assert.equal(res.body.pid, process.pid);
});

test("status route reports completed when a log file exists and the process is gone", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  await fs.writeFile(path.join(workDir, "deploy.log"), "deploy output here");
  const dispatcher = makeDispatcher(tmpDir);
  // Nonexistent PID: process.kill throws ESRCH → processAlive=false.
  // logs=truthy and pidStr=truthy → "completed" (line 875).
  const res = await doStatusRequest(dispatcher, repoDir, "99999999");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "completed");
});

test("status route reports not-started when no files and no pid are present", async () => {
  const tmpDir = makeTempDir();
  const { repoDir } = await makeStatusDirs(tmpDir);
  const dispatcher = makeDispatcher(tmpDir);
  // All determineStatus inputs are falsy/null — reaches the else branch.
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "not-started");
  // line 455 false branch — no pidRaw → pid:null
  assert.equal(res.body.pid, null);
  // line 456/457/458 — optional chaining on null deployResult returns undefined
  assert.equal(res.body.deployedUrl, undefined);
  assert.equal(res.body.error, undefined);
});

// ─── GET /api/gateway/deploy/status/:ticketId — isProcessAlive() (line 886) ─

test("status route treats a NaN pid string as a dead process", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  await fs.writeFile(path.join(workDir, "deploy.log"), "some output");
  const dispatcher = makeDispatcher(tmpDir);
  // parseInt("not-a-number") = NaN → isProcessAlive returns false.
  // logs+pidStr both truthy → status="completed", not "running".
  const res = await doStatusRequest(dispatcher, repoDir, "not-a-number");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "completed");
});

// ─── readJsonFile edge cases (lines 916) ────────────────────────────────────

test("status route treats whitespace-only deploy-result.json as no url", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  // Whitespace content → trim() → "" → readJsonFile returns null (line 916 empty branch).
  await fs.writeFile(path.join(workDir, "deploy-result.json"), "   ");
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deployedUrl, undefined);
  assert.equal(res.body.status, "not-started");
});

test("status route treats invalid JSON in deploy-result.json as no url", async () => {
  const tmpDir = makeTempDir();
  const { repoDir, workDir } = await makeStatusDirs(tmpDir);
  // Bad JSON → JSON.parse throws → readJsonFile catch returns null.
  await fs.writeFile(path.join(workDir, "deploy-result.json"), "{broken");
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deployedUrl, undefined);
});

// ─── resolveWorktreeParent env-var configured branch (line 657) ─────────────

test("status route uses SYMPHONY_WORKTREE_PARENT_DIR when it is set", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "myrepo");
  await fs.mkdir(repoDir, { recursive: true });
  // Point worktree parent to tmpDir so derived path myrepo-ISS-1 stays inside
  // the allowed sandbox (assertPathAllowed check passes).
  setEnv("SYMPHONY_WORKTREE_PARENT_DIR", tmpDir);
  const worktreeWorkDir = path.join(
    tmpDir,
    "myrepo-ISS-1",
    ".closedloop-ai",
    "work"
  );
  await fs.mkdir(worktreeWorkDir, { recursive: true });
  const dispatcher = makeDispatcher(tmpDir);
  const res = await doStatusRequest(dispatcher, repoDir);
  // Route succeeded — env-var branch of resolveWorktreeParent was taken.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "not-started");
});

// ─── POST /api/gateway/deploy/check-existing — validation (lines 470, 477) ──

test("check-existing returns 400 for invalid JSON body", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/check-existing",
    body: "bad-json",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("check-existing returns 400 when worktreePath is absent from body", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/check-existing",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repoPath and worktreePath are required");
});

// ─── check-existing — detectDeployment null → no port (lines 495, 505) ──────

test("check-existing returns active:false when no package.json is found in worktree", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "repo");
  const worktreeDir = path.join(tmpDir, "worktree");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(worktreeDir, { recursive: true });
  // No package.json → detectDeployment returns null → !null?.port → active:false.
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/check-existing",
    body: JSON.stringify({ repoPath: repoDir, worktreePath: worktreeDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.active, false);
});

test("check-existing returns active:false when port is detected but not listening", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "portrepo");
  const worktreeDir = path.join(tmpDir, "portworktree");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(worktreeDir, { recursive: true });
  // Port extracted from script text — not listening → active:false (line 505 false branch).
  await fs.writeFile(
    path.join(worktreeDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "PORT=19997 node server.js" },
      dependencies: { axios: "^1.0.0" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/check-existing",
    body: JSON.stringify({ repoPath: repoDir, worktreePath: worktreeDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.active, false);
});

// ─── POST /api/gateway/deploy/detect — validation (lines 525, 531, 539) ─────

test("detect returns 400 for invalid JSON body", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: "{broken",
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid JSON body");
});

test("detect returns 400 when repoPath is absent from body", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({}),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repoPath is required");
});

test("detect returns 400 when repoPath is an empty string (asString null branch)", async () => {
  // asString("") → "".trim() is falsy → returns null → same 400.
  // This covers line 1126: the `? value : null` null branch of asString.
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: "" }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "repoPath is required");
});

test("detect returns 403 when repoPath is outside the allowed directories", async () => {
  const tmpDir = makeTempDir();
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: "/etc/hosts" }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "directory not allowed");
});

// ─── POST /api/gateway/deploy/detect — detectDeployment() branches ───────────
//   lines 713, 728, 733, 734, 738, 746, 749, 751, 548

test("detect returns detected:false when package.json is absent from the repo", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "nopkg");
  await fs.mkdir(repoDir, { recursive: true });
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  // line 713 branch → null → line 548 → detected:false
  assert.equal(res.body.detected, false);
});

test("detect returns detected:false when package.json has no scripts", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "noscripts");
  await fs.mkdir(repoDir, { recursive: true });
  // line 733 — scripts ?? {} → {}, resolveStartCommand returns null (line 734)
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ dependencies: { next: "^14.0.0" } })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, false);
});

test("detect returns detected:false when package.json contains invalid JSON", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "badjson");
  await fs.mkdir(repoDir, { recursive: true });
  // execSync("cat ...") returns invalid JSON → JSON.parse throws → catch (line 751) → null
  await fs.writeFile(path.join(repoDir, "package.json"), "{broken");
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, false);
});

test("detect handles package.json with devDependencies but no dependencies key", async () => {
  // line 728: ...(packageJson.dependencies ?? {}) — the {} fallback branch
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "devdepsonly");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "^5.0.0" },
      // No "dependencies" key at all.
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.framework, "vite");
});

// ─── detectFramework / resolveStartCommand / resolveInstallCommand ───────────
//   lines 761, 779, 796, 799, 804

test("detect identifies next framework and uses pnpm dev when pnpm-lock.yaml is present", async () => {
  // resolveInstallCommand line 761 (pnpm branch); resolveStartCommand line 796
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "nextapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, "pnpm-lock.yaml"), "");
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "^14.0.0" },
      packageManager: "pnpm@8.15.0",
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.framework, "next");
  assert.equal(cfg.command, "pnpm dev"); // resolveStartCommand → pnpm-lock → "pnpm dev"
  assert.equal(cfg.installCommand, "pnpm install"); // resolveInstallCommand → line 761
  assert.equal(cfg.type, "next");
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.healthCheckUrl, "http://localhost:3000");
});

test("detect identifies vite framework and assigns default port 5173", async () => {
  // detectFramework line 779 (vite); detectDefaultPort line 831 (vite → 5173)
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "viteapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "^5.0.0" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.framework, "vite");
  assert.equal(cfg.port, 5173);
  assert.equal(cfg.type, "vite");
});

test("detect uses yarn dev when yarn.lock is present", async () => {
  // resolveStartCommand line 799 (yarn.lock branch); resolveInstallCommand yarn branch
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "yarnapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, "yarn.lock"), "");
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "^14.0.0" },
      packageManager: "yarn@3.6.0",
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.command, "yarn dev");
  assert.equal(cfg.installCommand, "yarn install");
});

test("detect uses start script when no dev script is present", async () => {
  // resolveStartCommand line 804 (scripts.start branch)
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "expressapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { start: "node app.js" },
      dependencies: { express: "^4.18.0" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.framework, "express");
  assert.ok(
    (cfg.command as string).includes("start"),
    `expected command with 'start'; got: ${cfg.command}`
  );
});

// ─── detectDefaultPort explicit port from script text (line 831 false branch) ─

test("detect extracts an explicit port number from the dev script text", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "portapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "next dev --port 4444" },
      dependencies: { next: "^14.0.0" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.port, 4444);
  assert.equal(cfg.healthCheckUrl, "http://localhost:4444");
});

// ─── detectFramework — remaining variants ─────────────────────────────────────

test("detect identifies react-scripts (CRA) framework", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "craapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { start: "react-scripts start" },
      dependencies: { "react-scripts": "5.0.1" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  assert.equal(cfg.framework, "cra");
});

test("detect falls back to node type when no known framework is in dependencies", async () => {
  // line 746: framework ?? "node" — the "node" fallback branch
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "nodeapp");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "node server.js" },
      dependencies: { axios: "^1.6.0" },
    })
  );
  const dispatcher = makeDispatcher(tmpDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);
  const cfg = res.body.config as Record<string, unknown>;
  // detectFramework({axios: ...}) → undefined → framework ?? "node" = "node"
  assert.equal(cfg.type, "node");
  assert.equal(cfg.framework, undefined);
});

// ─── persistDeploymentConfig — saves when repo entry exists (line 853) ───────

test("detect persists deployment config into repos.json when repo is already registered", async () => {
  const tmpDir = makeTempDir();
  const repoDir = path.join(tmpDir, "savedrepo");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: { next: "^14.0.0" },
    })
  );

  // Pre-populate repos.json so repoEntry is found and persistDeploymentConfig saves.
  const symphonyDir = path.join(tmpDir, ".symphony");
  const configDir = path.join(symphonyDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "repos.json"),
    JSON.stringify({
      repos: [{ path: repoDir, addedAt: new Date().toISOString() }],
      settings: {},
    })
  );

  const dispatcher = makeDispatcher(tmpDir, symphonyDir);
  const res = await dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: "/api/gateway/deploy/detect",
    body: JSON.stringify({ repoPath: repoDir }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.detected, true);

  // Verify the config was written back (line 853 branch taken — repoEntry exists).
  const saved = JSON.parse(
    await fs.readFile(path.join(configDir, "repos.json"), "utf-8")
  ) as { repos: Array<{ deployment?: { command?: string } }> };
  assert.ok(
    saved.repos[0].deployment?.command !== undefined,
    "expected deployment.command to be saved in repos.json"
  );
});
