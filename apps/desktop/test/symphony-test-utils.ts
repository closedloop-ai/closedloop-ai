/**
 * Shared test helpers for symphony loop integration tests.
 *
 * Extracted from symphony-loop-execute.test.ts,
 * symphony-loop-cloud-failures.test.ts, and the evaluate-* test files
 * to eliminate duplication.
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { WorktreeProvider } from "../src/server/operations/symphony-loop.js";
import { DesktopGatewayServer } from "../src/server/server.js";
import {
  resetShellPathCache,
  setShellPathForTest,
} from "../src/server/shell-path.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Multi-repo PRD command set
// ---------------------------------------------------------------------------

/**
 * Peer-enabled PRD-side LoopCommands. Iterating this constant lets the
 * multi-repo test files (-contract, -spawn, -worktree) cover both
 * GENERATE_PRD and REQUEST_PRD_CHANGES from one declaration. Adding a new
 * peer-enabled PRD command becomes a one-line edit here rather than three.
 */
export const PRD_PEER_COMMANDS = [
  LoopCommand.GeneratePrd,
  LoopCommand.RequestPrdChanges,
] as const;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordedRequest = { method: string; url: string; body: string };

// ---------------------------------------------------------------------------
// Environment save/restore
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "SYMPHONY_WORKTREE_PARENT_DIR",
  "PATH",
  "HOME",
  "CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE",
  "CLOSEDLOOP_BOOTSTRAP_TIMEOUT_MS",
] as const;

export function saveEnvVars(
  keys: readonly string[]
): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return saved;
}

export function restoreEnvVars(
  saved: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function saveEnv(): Record<string, string | undefined> {
  return saveEnvVars(ENV_KEYS);
}

export function restoreEnv(saved: Record<string, string | undefined>): void {
  restoreEnvVars(saved);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export async function initGitRepo(
  repoPath: string,
  options: { allowEmpty?: boolean } = {}
): Promise<void> {
  const commitStep = options.allowEmpty
    ? "git commit --allow-empty -m initial"
    : `echo "# initial" > README.md && git add . && git commit -m initial`;
  await execFileAsync("/bin/sh", [
    "-c",
    [
      `git init -b main "${repoPath}"`,
      `cd "${repoPath}"`,
      "git config user.email test@test.com",
      "git config user.name Test",
      commitStep,
    ].join(" && "),
  ]);
  // Fail loudly if a fake git binary on PATH no-op'd init without creating
  // .git metadata. Otherwise callers that depend on real git state (e.g.,
  // `makeRecordingGitWorktreeProvider`) silently break.
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch (err) {
    throw new Error(
      `initGitRepo(${repoPath}): git init appeared to succeed but no .git ` +
        "metadata was created. A fake git binary on PATH is the most likely cause. " +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function findFileRecursive(
  dir: string,
  filename: string
): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const result = await findFileRecursive(fullPath, filename);
      if (result !== null) {
        return result;
      }
    }
  }
  return null;
}

/**
 * Poll for a file by name under `searchRoot` until found or the deadline
 * expires. Useful when a test spawns a subprocess that creates the file at
 * an a-priori-unknown path inside the search tree (e.g., a per-loop workdir).
 */
export async function findFilePolling(
  searchRoot: string,
  filename: string,
  timeoutMs = 20_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findFileRecursive(searchRoot, filename);
    if (found !== null) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${filename} under ${searchRoot} after ${timeoutMs}ms`
  );
}

export async function findSpawnArgsFile(
  searchRoot: string,
  timeoutMs = 20_000
): Promise<string> {
  return findFilePolling(searchRoot, "spawn-args.txt", timeoutMs);
}

export async function waitForFile(
  filePath: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for file ${filePath}`);
}

export function pidExists(pidPath: string): boolean {
  try {
    const pid = Number(readFileSync(pidPath, "utf-8").trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidsGone(
  pidPaths: string[],
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidPaths.every((pidPath) => !pidExists(pidPath))) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for pids to exit: ${pidPaths.join(", ")}`);
}

export async function writeBootstrapPluginRegistry(
  homeDir: string
): Promise<void> {
  const installPath = path.join(
    homeDir,
    ".claude",
    "plugins",
    "bootstrap-install"
  );
  await fs.mkdir(installPath, { recursive: true });
  const registryPath = path.join(
    homeDir,
    ".claude",
    "plugins",
    "installed_plugins.json"
  );
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      plugins: {
        "bootstrap@closedloop-ai": [
          { installPath, scope: "user", enabled: true, version: "1.0.0" },
        ],
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Mock API server
// ---------------------------------------------------------------------------

/**
 * Start a mock API server. When failUrls is provided, any request whose URL
 * contains a key from the map will receive the mapped status code and an error
 * body. All other requests receive HTTP 200.
 */
export async function startMockApiServer(
  failUrls?: Map<string, number>,
  failRequest?: (request: RecordedRequest) => number | undefined
): Promise<{
  server: http.Server;
  port: number;
  requests: RecordedRequest[];
  waitForRequest: (
    urlSubstring: string,
    timeoutMs?: number
  ) => Promise<RecordedRequest>;
}> {
  const requests: RecordedRequest[] = [];
  const waiters: Array<{
    urlSubstring: string;
    resolve: (r: RecordedRequest) => void;
  }> = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      requests.push(recorded);

      for (let i = waiters.length - 1; i >= 0; i--) {
        if (recorded.url.includes(waiters[i].urlSubstring)) {
          waiters[i].resolve(recorded);
          waiters.splice(i, 1);
        }
      }

      // Check if this request should fail
      let failStatus: number | undefined;
      if (failUrls) {
        for (const [urlSubstring, status] of failUrls) {
          if (recorded.url.includes(urlSubstring)) {
            failStatus = status;
            break;
          }
        }
      }
      failStatus ??= failRequest?.(recorded);

      if (failStatus === undefined) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } else {
        res.statusCode = failStatus;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "injected failure" }));
      }
    })().catch((err) => {
      console.error("Mock server handler error:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind mock API server");
  }

  function waitForRequest(
    urlSubstring: string,
    timeoutMs = 20_000
  ): Promise<RecordedRequest> {
    const existing = requests.find((r) => r.url.includes(urlSubstring));
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<RecordedRequest>((resolve, reject) => {
      const entry = {
        urlSubstring,
        resolve: (r: RecordedRequest) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) {
          waiters.splice(idx, 1);
        }
        reject(
          new Error(
            `Timed out waiting for request matching "${urlSubstring}" after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      waiters.push(entry);
    });
  }

  return { server, port: address.port, requests, waitForRequest };
}

// ---------------------------------------------------------------------------
// Fake plugin script
// ---------------------------------------------------------------------------

/**
 * Create the fake plugin cache structure so findPluginScript("code", "run-loop.sh")
 * finds the provided script content.
 */
/**
 * Minimal JSONL snippet that gives parseTokenUsage() non-zero tokens.
 * Without this, the 0-token EXECUTE guard (NO_WORK_PRODUCED) fires and
 * tests that expect a normal "completed" event will time out.
 */
export const FAKE_TOKEN_JSONL =
  '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5}}}';

/**
 * Fake Claude body for native-prompt integration tests that should exercise
 * fallback finalization without tripping the EXECUTE no-work guard.
 */
export const FAKE_CLAUDE_SUCCESS_WITH_TOKENS_NO_RESULT = [
  "#!/bin/sh",
  `printf '%s\\n' '${FAKE_TOKEN_JSONL}'`,
  "exit 0",
].join("\n");

/**
 * Wraps a fake run-loop.sh script body so it writes a claude-output.jsonl
 * with minimal token data before executing the original body. This prevents
 * the 0-token EXECUTE guard from converting the completed event into an error.
 * Pass `skipTokens: true` to keep the original script as-is (for tests that
 * intentionally exercise the 0-token path).
 */
export async function createFakeRunLoopScript(
  homeDir: string,
  scriptContent: string,
  opts?: { skipTokens?: boolean }
): Promise<string> {
  const scriptDir = path.join(
    homeDir,
    ".claude",
    "plugins",
    "cache",
    "closedloop-ai",
    "code",
    "1.0.0",
    "scripts"
  );
  await fs.mkdir(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, "run-loop.sh");

  let finalContent = scriptContent;
  if (!opts?.skipTokens) {
    // Inject a line that writes fake token data so parseTokenUsage() returns
    // non-zero, preventing the NO_WORK_PRODUCED guard from firing.
    const tokenLine = `mkdir -p "$CLOSEDLOOP_WORKDIR" 2>/dev/null; echo '${FAKE_TOKEN_JSONL}' >> "$CLOSEDLOOP_WORKDIR/claude-output.jsonl"\n`;
    // Insert after the shebang line
    finalContent = scriptContent.replace(/^(#!\/bin\/sh\n)/, `$1${tokenLine}`);
  }

  await fs.writeFile(scriptPath, finalContent, { mode: 0o755 });
  return scriptPath;
}

/**
 * Write a fake `gh` shell script to the given path and chmod 755.
 * Returns the absolute path to the script.
 */
export async function writeFakeGhScript(
  dir: string,
  scriptContent: string
): Promise<string> {
  const ghPath = path.join(dir, "gh");
  await fs.mkdir(path.dirname(ghPath), { recursive: true });
  await fs.writeFile(ghPath, scriptContent, { mode: 0o755 });
  return ghPath;
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

/**
 * Poll mock.requests until a request to /loops/{loopId}/events with
 * type === "completed" is found, or until the timeout elapses.
 */
export async function waitForCompletedEvent(
  requests: RecordedRequest[],
  loopId: string,
  timeoutMs = 20_000
): Promise<Record<string, unknown>> {
  const eventsUrlSubstring = `/loops/${loopId}/events`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const req of requests) {
      if (!req.url.includes(eventsUrlSubstring)) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === "completed") {
        return parsed;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for completed event for loopId=${loopId} after ${timeoutMs}ms`
  );
}

/**
 * Poll mock.requests until a terminal event (type "completed" or "error")
 * is found for the given loopId. Use this instead of waitForCompletedEvent
 * when the process may exit with a non-zero code.
 */
export async function waitForTerminalEvent(
  requests: RecordedRequest[],
  loopId: string,
  timeoutMs = 20_000
): Promise<Record<string, unknown>> {
  const eventsUrlSubstring = `/loops/${loopId}/events`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const req of requests) {
      if (!req.url.includes(eventsUrlSubstring)) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(req.body) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === "completed" || parsed.type === "error") {
        return parsed;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for terminal event for loopId=${loopId} after ${timeoutMs}ms`
  );
}

// ---------------------------------------------------------------------------
// Shared stub helpers
// ---------------------------------------------------------------------------

/** Create a fake `claude` binary in tmpDir/fake-bin and prepend it to PATH. */
export async function setupStubClaude(
  tmpDir: string,
  scriptLines?: string[]
): Promise<void> {
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const stubScript = (
    scriptLines ?? [
      "#!/bin/sh",
      'echo \'{"type":"result","subtype":"success","result":"","is_error":false}\'',
      "exit 0",
    ]
  ).join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), stubScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  // Lock shell-path resolution to the stubbed PATH so tests never fall back to
  // a developer's real login-shell PATH and accidentally spawn real Claude.
  setShellPathForTest();
}

/**
 * Create a fake `claude` binary that emits one stream-json line, then blocks
 * polling for `releaseSentinel` to appear. Tests use this to eliminate the race
 * between (a) the loop handler returning HTTP 200 after spawn and (b) the
 * post-completion cleanup that removes claudeWorkDir. The test can safely read
 * files from claudeWorkDir while the stub is blocked, then create the sentinel
 * to let the stub exit and trigger the normal completion path.
 *
 * Returns a `release()` callback that creates the sentinel file (call this
 * from the test once you've finished asserting on files in claudeWorkDir).
 */
export async function setupStubClaudeBlocking(
  tmpDir: string,
  releaseSentinel: string
): Promise<{ release: () => Promise<void> }> {
  const fakeBin = path.join(tmpDir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  // Shell-quote the sentinel path so paths with spaces or special chars work.
  const quoted = `'${releaseSentinel.replaceAll("'", "'\\''")}'`;
  const stubScript = [
    "#!/bin/sh",
    // One stream-json line so any stdout consumer (grep in buildClaudePipeline,
    // tailer, etc.) sees output before we block.
    'echo \'{"type":"result","subtype":"success","result":"","is_error":false}\'',
    // Bounded poll loop: wait up to ~10s for the test to release us. The test
    // should always release within milliseconds; the cap exists so a test bug
    // can't hang the suite indefinitely.
    "i=0",
    `while [ ! -f ${quoted} ] && [ $i -lt 500 ]; do`,
    "  sleep 0.02",
    "  i=$((i+1))",
    "done",
    "exit 0",
  ].join("\n");
  await fs.writeFile(path.join(fakeBin, "claude"), stubScript, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
  setShellPathForTest();
  return {
    release: async () => {
      await fs.writeFile(releaseSentinel, "");
    },
  };
}

// ---------------------------------------------------------------------------
// Fake WorktreeProvider factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal stub `WorktreeProvider` for tests that don't need real git.
 * `ensureWorktree` creates the directory, `removeWorktree` rm's it,
 * `findWorktreeForBranch` returns null, `branchExists` always returns true,
 * and `getCurrentBranch` returns `currentBranchLabel` verbatim.
 *
 * Tests that need real git metadata and call recording should use
 * makeRecordingGitWorktreeProvider.
 */
export function makeFakeWorktreeProvider(
  currentBranchLabel: string
): WorktreeProvider {
  return {
    async ensureWorktree(_repoPath, worktreeDir) {
      await fs.mkdir(worktreeDir, { recursive: true });
    },
    findWorktreeForBranch() {
      return null;
    },
    async removeWorktree(worktreeDir) {
      await fs.rm(worktreeDir, { recursive: true, force: true });
    },
    getCurrentBranch() {
      return currentBranchLabel;
    },
    branchExists: async () => true,
  };
}

export function makeRecordingGitWorktreeProvider(currentBranchLabel: string): {
  provider: WorktreeProvider;
  ensureWorktreeCalls: Array<{
    repoPath: string;
    worktreeDir: string;
    branchName: string;
    baseBranch: string;
  }>;
  removeCalls: Array<{
    worktreeDir: string;
    repoPath: string;
    loopId?: string;
  }>;
} {
  const ensureWorktreeCalls: Array<{
    repoPath: string;
    worktreeDir: string;
    branchName: string;
    baseBranch: string;
  }> = [];
  const removeCalls: Array<{
    worktreeDir: string;
    repoPath: string;
    loopId?: string;
  }> = [];

  const provider: WorktreeProvider = {
    async ensureWorktree(repoPath, worktreeDir, branchName, baseBranch) {
      ensureWorktreeCalls.push({
        repoPath,
        worktreeDir,
        branchName,
        baseBranch,
      });
      await fs.mkdir(worktreeDir, { recursive: true });
      await initGitRepo(worktreeDir, { allowEmpty: true });
    },
    findWorktreeForBranch() {
      return null;
    },
    async removeWorktree(worktreeDir, repoPath, loopId) {
      removeCalls.push({ worktreeDir, repoPath, loopId });
      await fs.rm(worktreeDir, { recursive: true, force: true });
    },
    getCurrentBranch() {
      return currentBranchLabel;
    },
    branchExists: async () => true,
  };

  return { provider, ensureWorktreeCalls, removeCalls };
}

// ---------------------------------------------------------------------------
// Multi-repo test harness (shared by multi-repo-worktree, -contract, -spawn)
// ---------------------------------------------------------------------------

/**
 * Shared fixture state for multi-repo integration tests. Call
 * `makeMultiRepoTestHarness()` at module scope, destructure the arrays to
 * push resources into, then wire `cleanup` into your `afterEach`.
 */
export type MultiRepoTestHarness = {
  serversToClose: DesktopGatewayServer[];
  mockServersToClose: http.Server[];
  tempPathsToClean: string[];
  /** Call from node:test afterEach to restore env, cache, servers, and temp dirs. */
  cleanup: () => Promise<void>;
};

/**
 * Build shared arrays and a cleanup function for multi-repo integration tests.
 *
 * Usage (module scope):
 *   const { serversToClose, mockServersToClose, tempPathsToClean, cleanup } =
 *     makeMultiRepoTestHarness();
 *   afterEach(cleanup);
 */
export function makeMultiRepoTestHarness(): MultiRepoTestHarness {
  const serversToClose: DesktopGatewayServer[] = [];
  const mockServersToClose: http.Server[] = [];
  const tempPathsToClean: string[] = [];
  const savedEnv = saveEnv();

  async function cleanup(): Promise<void> {
    restoreEnv(savedEnv);
    resetShellPathCache();
    for (const server of serversToClose.splice(0)) {
      await server.stop();
    }
    for (const ms of mockServersToClose.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        ms.close((err) => (err ? reject(err) : resolve()));
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
  }

  return { serversToClose, mockServersToClose, tempPathsToClean, cleanup };
}

/**
 * Create and start a DesktopGatewayServer configured for a multi-repo test.
 * Pushes the server onto `serversToClose` so the harness cleans it up.
 *
 * All three multi-repo tests (`-contract`, `-spawn`, `-worktree`) share this
 * configuration; only `machineName` and the optional `worktreeProvider` differ.
 */
export async function makeMultiRepoGateway(options: {
  tmpDir: string;
  mockPort: number;
  machineName: string;
  worktreeProvider: WorktreeProvider;
  serversToClose: DesktopGatewayServer[];
}): Promise<DesktopGatewayServer> {
  const server = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "https://app.symphony.com",
    getAllowedDirectories: () => [options.tmpDir],
    machineName: options.machineName,
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    worktreeProvider: options.worktreeProvider,
    discoveryFilePath: path.join(options.tmpDir, "electron-port"),
    getApiOrigin: () => `http://127.0.0.1:${options.mockPort}`,
    getGatewayId: () => "test-gateway-id",
  });
  options.serversToClose.push(server);
  await server.start();
  return server;
}

// ---------------------------------------------------------------------------
// Evaluate-test infrastructure (shared by evaluate-plan, evaluate-code, etc.)
// ---------------------------------------------------------------------------

/**
 * Cleanup tracker for evaluate-style integration tests.
 * Call `createEvaluateTestHarness()` at module scope, then use the returned
 * `makeTempDir`, `makeGatewayServer`, and `startEventServer` helpers.
 * Register `harness.beforeEach` and `harness.afterEach` with the test runner.
 */
export type EvaluateTestHarness = {
  /** Create a temp directory that will be cleaned up in afterEach. */
  makeTempDir: (label: string) => string;
  /** Create a gateway server pre-configured for testing. */
  makeGatewayServer: (options?: {
    allowedDirs?: string[];
    tmpDir?: string;
    getApiOrigin?: () => string;
  }) => DesktopGatewayServer;
  /** Start an event-capture HTTP server for asserting on posted loop events. */
  startEventServer: () => Promise<{
    port: number;
    waitForEvent: (
      predicate: (body: Record<string, unknown>) => boolean,
      timeoutMs?: number
    ) => Promise<Record<string, unknown>>;
    cancelWaiters: () => void;
  }>;
  /** Call from node:test beforeEach. Sets CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE=1. */
  beforeEach: () => void;
  /** Call from node:test afterEach. Restores env, stops servers, removes temp dirs. */
  afterEach: () => Promise<void>;
};

/** POST a symphony loop request to the gateway server. */
export async function postToLoopEndpoint(
  serverPort: number,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${serverPort}/api/gateway/symphony/loop`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-desktop-gateway-token": "test-token",
    },
    body: JSON.stringify(body),
  });
}

export function createEvaluateTestHarness(
  machineName: string
): EvaluateTestHarness {
  const tempPathsToClean: string[] = [];
  const serversToClose: DesktopGatewayServer[] = [];
  const eventServersToClose: http.Server[] = [];
  const eventServerCancellers: Array<() => void> = [];
  const originalPath = process.env.PATH;
  const originalRawPipeline =
    process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE;

  function makeTempDir(label: string): string {
    const dir = path.join(
      os.tmpdir(),
      `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(dir, { recursive: true });
    tempPathsToClean.push(dir);
    return dir;
  }

  function makeGatewayServer(options?: {
    allowedDirs?: string[];
    tmpDir?: string;
    getApiOrigin?: () => string;
  }): DesktopGatewayServer {
    const tmpDir = options?.tmpDir ?? makeTempDir(machineName);
    const server = new DesktopGatewayServer({
      host: "127.0.0.1",
      preferredPort: 0,
      fallbackPorts: [0],
      webAppOrigin: "https://app.symphony.com",
      getGatewayAuthToken: () => "test-token",
      getApiOrigin: options?.getApiOrigin ?? (() => "http://127.0.0.1:49152"),
      getAllowedDirectories: () => options?.allowedDirs ?? [os.tmpdir()],
      machineName,
      version: "0.1.0-test",
      capabilities: EMPTY_CAPABILITIES,
      discoveryFilePath: path.join(tmpDir, "electron-port"),
    });
    serversToClose.push(server);
    return server;
  }

  async function startEventServer(): Promise<{
    port: number;
    waitForEvent: (
      predicate: (body: Record<string, unknown>) => boolean,
      timeoutMs?: number
    ) => Promise<Record<string, unknown>>;
    cancelWaiters: () => void;
  }> {
    const collected: Record<string, unknown>[] = [];
    const waiters: Array<{
      predicate: (b: Record<string, unknown>) => boolean;
      resolve: (b: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];

    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        res.statusCode = 200;
        res.end("{}");
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        collected.push(body);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i];
          if (waiter.predicate(body)) {
            waiters.splice(i, 1);
            waiter.resolve(body);
          }
        }
      });
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Could not get server address"));
          return;
        }
        resolve(addr.port);
      });
      server.once("error", reject);
    });

    eventServersToClose.push(server);
    eventServerCancellers.push(() => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("waitForEvent cancelled during teardown"));
      }
    });

    function waitForEvent(
      predicate: (b: Record<string, unknown>) => boolean,
      timeoutMs = 10_000
    ): Promise<Record<string, unknown>> {
      const existing = collected.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) {
            waiters.splice(idx, 1);
          }
          reject(
            new Error(
              `waitForEvent timed out after ${timeoutMs}ms. Collected so far: ${JSON.stringify(collected)}`
            )
          );
        }, timeoutMs);

        const waiter = {
          predicate,
          resolve: (b: Record<string, unknown>) => {
            clearTimeout(timer);
            resolve(b);
          },
          reject,
          timer,
        };

        waiters.push(waiter);
      });
    }

    function cancelWaiters(): void {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("waitForEvent cancelled during teardown"));
      }
    }

    return { port, waitForEvent, cancelWaiters };
  }

  return {
    makeTempDir,
    makeGatewayServer,
    startEventServer,
    beforeEach() {
      process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE = "1";
    },
    async afterEach() {
      if (originalRawPipeline === undefined) {
        delete process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE;
      } else {
        process.env.CLOSEDLOOP_SYMPHONY_TEST_RAW_CLAUDE_PIPELINE =
          originalRawPipeline;
      }

      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      resetShellPathCache();

      for (const server of serversToClose.splice(0)) {
        await server.stop();
      }

      for (const cancel of eventServerCancellers.splice(0)) {
        cancel();
      }

      for (const srv of eventServersToClose.splice(0)) {
        await new Promise<void>((resolve, reject) => {
          srv.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }

      for (const p of tempPathsToClean.splice(0)) {
        await fs.rm(p, { recursive: true, force: true });
      }
    },
  };
}
