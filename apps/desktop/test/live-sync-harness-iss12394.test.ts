/**
 * @file live-sync-harness-iss12394.test.ts
 * @description ISS-12394 — drain-phase paths the other harness suites never
 * reach: a stub API that ACCEPTS every sync request, so the session lane
 * reports caught up and every driven lane reaches `drained`; and a register
 * answer the harness cannot parse.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncLane, SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { DesktopAgentSessionsSyncErrorCode } from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimRehearsalOwnerIdentity,
  injectMissingSourceFixture,
  openRehearsalDb,
} from "../scripts/rehearsal-build-store.js";
import {
  SyncLaneDrainState,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

const RE_REGISTER_UNREADABLE =
  /POST \/compute-targets\/register answered 500 with a body the harness could not read, so the sync lanes have no owned compute target to send under: null/;
const RE_DRAIN_FINISHED =
  /drain finished: sessionLaneDrained=true delivered=1 in \d+ms/;
const RE_VERDICT_PASS =
  /\[live-sync-harness\] drained 1 session\(s\) in \d+ms with no rejected batch, dead letter or failed tick/;

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(DESKTOP_DIR, "scripts", "live-sync-harness.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 120_000;
/**
 * Past {@link SPAWN_TIMEOUT_MS}, so a pass that never breaks out early is killed
 * and `runHarness` rejects: the early break is pinned without reading a clock.
 */
const DRAIN_BUDGET_MS = "600000";

const REGISTER_PATH = "/compute-targets/register";
const SESSIONS_SYNC_PATH = "/desktop/agent-sessions/sync";
const REJECTED_FIELD_DETAIL = "session_invalid:sessions[0].name";
const SHORT_BUDGET_MS = "4000";
const REGISTERED_COMPUTE_TARGET_ID = "22222222-2222-4222-8222-222222222222";

type StubMode = "accept" | "brokenRegister" | "rejectSessions";

let workDir = "";
let stubServer: http.Server | null = null;
let stubPort = 0;
let stubMode: StubMode = "accept";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "live-sync-harness-iss12394-"));
});

afterEach(async () => {
  rmSync(workDir, { force: true, recursive: true });
  await stopStub();
});

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function answerStubRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  for await (const _chunk of req) {
    // drain the body
  }
  const url = req.url ?? "";
  if (url === REGISTER_PATH) {
    if (stubMode === "brokenRegister") {
      res.statusCode = 500;
      res.end("not json");
      return;
    }
    sendJson(res, 200, {
      success: true,
      data: { id: REGISTERED_COMPUTE_TARGET_ID },
    });
    return;
  }
  if (url.startsWith(SESSIONS_SYNC_PATH) && stubMode === "rejectSessions") {
    sendJson(res, 400, {
      success: false,
      error: "rejected",
      code: DesktopAgentSessionsSyncErrorCode.ValidationFailed,
      details: { reason: REJECTED_FIELD_DETAIL },
    });
    return;
  }
  if (url.startsWith(SESSIONS_SYNC_PATH)) {
    sendJson(res, 200, { success: true, data: { synced: true } });
    return;
  }
  sendJson(res, 200, { success: true, data: {} });
}

function startStub(mode: StubMode): Promise<void> {
  stubMode = mode;
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

function runHarness(args: string[]): Promise<HarnessRun> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CL_AUTH_API_ORIGIN: `http://127.0.0.1:${stubPort}`,
    CLOSEDLOOP_API_KEY: "sk_live_iss12394",
  };
  Reflect.deleteProperty(env, "CL_RELAY_ORIGIN");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, ...args],
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
      child.kill("SIGKILL");
      reject(
        new Error(`the harness did not exit within ${SPAWN_TIMEOUT_MS} ms`)
      );
    }, SPAWN_TIMEOUT_MS);
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

describe("live-sync-harness drain phase against an accepting stub API", () => {
  it("breaks out once every driven lane is drained, writes a clean report, and the verdict passes", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    await startStub("accept");
    const storeDir = join(workDir, "store");
    await buildOwnedStore(storeDir);
    const reportFile = join(workDir, "report.json");

    const drain = await runHarness([
      "--store",
      storeDir,
      "--report",
      reportFile,
      "--budget-ms",
      DRAIN_BUDGET_MS,
    ]);

    expect(drain.status).toBe(0);
    expect(drain.stdout).toMatch(RE_DRAIN_FINISHED);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    expect(report.sessionLaneDrained).toBe(true);
    expect(report.sessionsDelivered).toBe(1);
    expect(report.laneRemainders).toEqual([
      {
        lane: SyncLaneId.SessionMetadata,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
      {
        lane: SyncLaneId.InvocationParts,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
      {
        lane: SyncLaneId.ComponentInventory,
        state: SyncLaneDrainState.Drained,
        itemsRemaining: 0,
      },
    ]);
    const sessionTally = report.lanes.find(
      (entry: { lane: string }) => entry.lane === SyncLane.SessionMetadata
    );
    expect(sessionTally.accepted).toBeGreaterThan(0);
    expect(sessionTally.rejected).toBe(0);
    expect(report.cloud).toBeNull();

    const countsFile = join(workDir, "cloud-counts.json");
    writeFileSync(countsFile, JSON.stringify(report.corpus));
    const verdict = await runHarness([
      "--verdict",
      "--report",
      reportFile,
      "--cloud-counts",
      countsFile,
    ]);

    expect(verdict.status).toBe(0);
    expect(verdict.stdout).toMatch(RE_VERDICT_PASS);
    expect(JSON.parse(readFileSync(reportFile, "utf8")).cloud).toEqual(
      report.corpus
    );
  });

  it("fails with the status and body when register answers something it cannot parse, writing no report", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    await startStub("brokenRegister");
    const storeDir = join(workDir, "store");
    await buildOwnedStore(storeDir);
    const reportFile = join(workDir, "report.json");

    const run = await runHarness([
      "--store",
      storeDir,
      "--report",
      reportFile,
      "--budget-ms",
      DRAIN_BUDGET_MS,
    ]);

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(RE_REGISTER_UNREADABLE);
    expect(existsSync(reportFile)).toBe(false);
  });

  it("tallies a per-session 400 as a rejection carrying the reason and the server's field path, and leaves the session lane undrained", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    await startStub("rejectSessions");
    const storeDir = join(workDir, "store");
    await buildOwnedStore(storeDir);
    const reportFile = join(workDir, "report.json");

    const run = await runHarness([
      "--store",
      storeDir,
      "--report",
      reportFile,
      "--budget-ms",
      SHORT_BUDGET_MS,
    ]);

    expect(run.status).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    expect(report.sessionLaneDrained).toBe(false);
    expect(report.sessionsDelivered).toBe(0);
    expect(report.rejectedDetails).toContain(REJECTED_FIELD_DETAIL);
    const sessionTally = report.lanes.find(
      (entry: { lane: string }) => entry.lane === SyncLane.SessionMetadata
    );
    expect(sessionTally.accepted).toBe(0);
    expect(sessionTally.rejected).toBeGreaterThan(0);
    expect(sessionTally.deadLettered).toBe(0);
    expect(sessionTally.reasons).toContain(SyncReason.ValidationFailed);
    expect(report.laneRemainders).toContainEqual({
      lane: SyncLaneId.SessionMetadata,
      state: SyncLaneDrainState.Draining,
      itemsRemaining: 1,
    });
  });
});
