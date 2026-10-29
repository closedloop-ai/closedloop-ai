/**
 * @file live-sync-harness-iss12097.test.ts
 * @description ISS-12097 (whitlockk review) — regression coverage for the
 * harness's fake dashboard runtime. `live-sync-harness-iss11285.test.ts`'s
 * subprocess cases all stop at the owner check or run `--verdict`, so none
 * of them reach `createDesktopSyncLanes` and call through the fake runtime
 * `getDashboardRuntime` returns. This builds a store with one owned session
 * and runs the drain phase against a stub API that answers only
 * `POST /compute-targets/register` (503 to everything else, same repro the
 * PR description used). That is enough for the harness to reach
 * `lanes.agentSessionSync.start()`, which calls
 * `isInitialSessionProjectionReady()` for real: before the fix, the fake
 * runtime had no such method and that call threw
 * `TypeError: ... isInitialSessionProjectionReady is not a function`; after
 * the fix the lanes start and the stub actually receives sync traffic.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimRehearsalOwnerIdentity,
  injectMissingSourceFixture,
  openRehearsalDb,
} from "../scripts/rehearsal-build-store.js";

const RE_RUNTIME_METHOD_MISSING =
  /isInitialSessionProjectionReady is not a function/;

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(DESKTOP_DIR, "scripts", "live-sync-harness.ts");

/**
 * The harness drains against a stub API running IN THIS PROCESS, so the
 * child must be spawned with the async `spawn`, never `spawnSync`:
 * `spawnSync` blocks this process's event loop until the child exits, which
 * starves the stub server and deadlocks every request the harness makes to
 * it. `runHarness` below kills the child itself once this fires, so a
 * genuine hang fails the case instead of the suite's own timeout.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 90_000;

/**
 * Long enough for the fixed lanes to clear the register call and reach a
 * sync attempt against the stub — the same budget the PR description's
 * manual repro used.
 */
const DRAIN_BUDGET_MS = "4000";

const REGISTERED_COMPUTE_TARGET_ID = "11111111-1111-4111-8111-111111111111";
const REGISTER_PATH = "/compute-targets/register";

type RecordedRequest = { method: string; url: string };

let workDir = "";
let stubServer: http.Server | null = null;
let stubPort = 0;
let recordedRequests: RecordedRequest[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "live-sync-harness-iss12097-"));
  recordedRequests = [];
});

afterEach(async () => {
  rmSync(workDir, { force: true, recursive: true });
  await stopStub();
});

/** Drains the request and answers `register`; 503s everything else. */
async function answerStubRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  recordedRequests.push({ method: req.method ?? "", url: req.url ?? "" });
  if (req.method === "POST" && req.url === REGISTER_PATH) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        success: true,
        data: { id: REGISTERED_COMPUTE_TARGET_ID },
      })
    );
    return;
  }
  res.statusCode = 503;
  res.end();
}

function startStub(): Promise<void> {
  stubServer = http.createServer((req, res) => {
    answerStubRequest(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  return new Promise<void>((resolve, reject) => {
    stubServer?.listen(0, "127.0.0.1", () => resolve());
    stubServer?.once("error", reject);
  }).then(() => {
    const address = stubServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind the stub-API test server");
    }
    stubPort = address.port;
  });
}

function stopStub(): Promise<void> {
  if (!stubServer) {
    return Promise.resolve();
  }
  const server = stubServer;
  stubServer = null;
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A store with one session an owner identity has claimed, reusing the exact
 * rehearsal helpers rather than hand-rolling the `sessions` schema: the
 * fixture insert plus the owner-claim UPDATE are the same two steps
 * `rehearsal-build-store.ts`'s own `main()` runs, minus the golden-corpus
 * import this test does not need.
 */
async function buildOwnedStore(storeDir: string): Promise<void> {
  const db = await openRehearsalDb(storeDir);
  try {
    await db.whenBootMaintenanceSettled();
    await injectMissingSourceFixture(db);
    await claimRehearsalOwnerIdentity(db);
  } finally {
    await db.close();
  }
}

type HarnessRun = { status: number | null; stdout: string; stderr: string };

function runHarness(reportFile: string, storeDir: string): Promise<HarnessRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CL_AUTH_API_ORIGIN: `http://127.0.0.1:${stubPort}`,
    CLOSEDLOOP_API_KEY: "sk_live_iss12097",
  };
  Reflect.deleteProperty(env, "CL_RELAY_ORIGIN");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT_PATH,
        "--store",
        storeDir,
        "--report",
        reportFile,
        "--budget-ms",
        DRAIN_BUDGET_MS,
      ],
      { cwd: DESKTOP_DIR, env }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, SPAWN_TIMEOUT_MS);
    // Required so a spawn failure rejects instead of hanging the case —
    // see AGENTS.md → Test Practices on child_process.spawn test helpers.
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`the harness did not run: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe("live-sync-harness drain phase against the stub-API repro", () => {
  it("clears the owner check and calls through the fake runtime's isInitialSessionProjectionReady without crashing", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    await startStub();
    const storeDir = join(workDir, "store");
    await buildOwnedStore(storeDir);
    const reportFile = join(workDir, "report.json");

    const run = await runHarness(reportFile, storeDir);

    expect(run.stderr).not.toMatch(RE_RUNTIME_METHOD_MISSING);
    expect(run.status).toBe(0);
    expect(
      recordedRequests.some(
        (r) => r.method === "POST" && r.url === REGISTER_PATH
      )
    ).toBe(true);
    // The register call alone does not prove the lanes started: with the
    // bug, the harness crashes before issuing any other request. A sync
    // attempt against a lane endpoint is the evidence the fake runtime's
    // gate actually let production code run.
    expect(recordedRequests.some((r) => r.url !== REGISTER_PATH)).toBe(true);
    expect(() => readFileSync(reportFile)).not.toThrow();
  });
});
