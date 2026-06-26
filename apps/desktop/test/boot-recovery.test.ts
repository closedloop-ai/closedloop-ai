import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopSchedulerContext } from "../src/main/loop-scheduler-context.js";
import { getActiveLoopPid } from "../src/server/operations/symphony-loop.js";
import { isProcessRunning } from "../src/server/operations/symphony-utils.js";

async function waitForCondition(
  fn: () => boolean,
  timeoutMs = 5000,
  pollMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

import { afterEach, beforeEach, test } from "node:test";
import { BootRecoveryService } from "../src/main/boot-recovery.js";
import { JobStore, type LocalJob } from "../src/main/job-store.js";
import { LoopTokenStore } from "../src/main/loop-token-store.js";
import type { TelemetryEventPayload } from "../src/main/telemetry-protocol.js";
import type { WorktreeProvider } from "../src/server/operations/symphony-loop.js";
import { cleanupAdditionalWorktrees } from "../src/server/operations/symphony-loop.js";
import { createLocalJob } from "./job-store-test-utils.js";
import { createTestLoopTokenSafeStorage } from "./loop-token-test-utils.js";
import { initGitRepo, restoreEnv } from "./symphony-test-utils.js";

let tempRoot = "";
let fetchCalls: Array<{
  url: string;
  body: string;
  authHeader?: string | null;
}> = [];
let telemetryEvents: TelemetryEventPayload[] = [];

/**
 * Returns true when `url`/`method` target the loop status endpoint
 * (GET /loops/:id, excluding /events and /upload-artifacts sub-paths).
 */
function isLoopStatusRequest(url: string, method: string): boolean {
  return (
    url.includes("/loops/") &&
    !url.includes("/events") &&
    !url.includes("/upload-artifacts") &&
    method === "GET"
  );
}

/**
 * Install a fetch mock that records every request into `fetchCalls` and
 * delegates GET /loops/:id (the cloud-status endpoint) to `statusHandler`.
 * All other requests return `Response.json({ success: true })`.
 */
function installCloudStatusFetchMock(
  statusHandler: (url: string) => Response | never
): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    if (isLoopStatusRequest(url, method)) {
      return statusHandler(url);
    }
    return Response.json({ success: true });
  }) as typeof fetch;
}
/**
 * Creates a LoopSchedulerContext with a teardownLoop spy that records calls
 * into the returned `teardownCalls` array. Reused by terminal/transient
 * reattach tests and PLN-757 PoP revival tests.
 */
function createSchedulersWithTeardownSpy(): {
  schedulers: LoopSchedulerContext;
  teardownCalls: string[];
} {
  const teardownCalls: string[] = [];
  const schedulers = new LoopSchedulerContext();
  const origTeardown = schedulers.teardownLoop.bind(schedulers);
  schedulers.teardownLoop = (id: string) => {
    teardownCalls.push(id);
    origTeardown(id);
  };
  return { schedulers, teardownCalls };
}

/** Shared PoP signing deps for PLN-757 boot-recovery tests. */
const testPopDeps = {
  signDesktopRequest: async () => ({
    "X-Desktop-Signature": "test-sig",
    "X-Desktop-Timestamp": "test-ts",
    "X-Desktop-Public-Key": "test-pk",
  }),
  onDesktopPopUnavailable: () => {},
} as const;

const originalFetch = globalThis.fetch;
const originalPollMs = process.env.CLOSEDLOOP_TAILER_POLL_MS;
const originalThrottleMs = process.env.CLOSEDLOOP_TAILER_THROTTLE_MS;
const originalWatcherPollMs = process.env.CLOSEDLOOP_WATCHER_POLL_MS;

/** Fast PID watcher poll for tests (boot-recovery live-job reattach). */
const WATCHER_TEST_POLL_MS = 50;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-recovery-test-"));
  fetchCalls = [];
  telemetryEvents = [];
  process.env.CLOSEDLOOP_TAILER_POLL_MS = "20";
  process.env.CLOSEDLOOP_TAILER_THROTTLE_MS = "20";
  process.env.CLOSEDLOOP_WATCHER_POLL_MS = String(WATCHER_TEST_POLL_MS);
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv({
    CLOSEDLOOP_TAILER_POLL_MS: originalPollMs,
    CLOSEDLOOP_TAILER_THROTTLE_MS: originalThrottleMs,
    CLOSEDLOOP_WATCHER_POLL_MS: originalWatcherPollMs,
  });
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function createStore(name: string): JobStore {
  return new JobStore({ cwd: tempRoot, name });
}

function createLoopTokenStore(name: string): LoopTokenStore {
  return new LoopTokenStore({
    cwd: tempRoot,
    name,
    safeStorage: createTestLoopTokenSafeStorage(),
  });
}

function createJob(overrides?: Partial<LocalJob>): LocalJob {
  const repoDir = path.join(tempRoot, "repo");
  return createLocalJob({
    command: LoopCommand.Plan,
    localRepoPath: repoDir,
    claudeWorkDir: path.join(repoDir, "workdir"),
    ...overrides,
  });
}

test("finalizes dead CANCEL_PENDING jobs to CANCELLED without loop events", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-cancel-pending-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-cancel-pending");
  const deadJob = createJob({
    status: "CANCEL_PENDING",
    exitCode: 130,
    pid: 9_999_999,
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "CANCELLED");
  assert.ok(persisted.finalStatusPersistedAt);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);
  assert.equal(
    fetchCalls.filter((c) => c.url.includes("/loops/loop-1/events")).length,
    0
  );
});

test("finalizes dead jobs without promoting UNKNOWN status to completed", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  const loopTokenStore = createLoopTokenStore("boot-recovery-dead-loop-tokens");
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-dead");
  const deadJob = createJob({
    status: "UNKNOWN",
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "UNKNOWN");
  assert.ok(persisted.finalStatusPersistedAt);
  assert.ok(
    !fetchCalls.some(
      (c) =>
        c.url.includes("/upload-artifacts") &&
        c.authHeader === "Bearer loop-token"
    )
  );
  assert.ok(
    fetchCalls.some(
      (c) =>
        c.body.includes('"type":"error"') &&
        c.body.includes('"code":"PROCESS_STOPPED"') &&
        c.authHeader === "Bearer loop-token"
    )
  );
});

test("boot recovery uploads support bundle for failed dead jobs before terminal error event", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(path.join(claudeWorkDir, "claude-output.jsonl"), "{}\n");
  const loopTokenStore = createLoopTokenStore("boot-recovery-support-tokens");
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-support-upload");
  const deadJob = createJob({
    status: "FAILED",
    exitCode: 1,
    pid: 9_999_999,
    claudeWorkDir,
    s3StateKey: "org-1/loops/loop-1/run-1",
  });
  jobStore.upsert(deadJob);
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    if (url.includes("/upload-urls")) {
      return Response.json({
        success: true,
        data: {
          urls: [
            {
              key: "org-1/loops/loop-1/run-1/support/claude-output.jsonl",
              url: "https://closedloop-files.s3.us-east-1.amazonaws.com/claude",
            },
          ],
        },
      });
    }
    return Response.json({ success: true });
  }) as typeof fetch;

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const eventBodies = fetchCalls
    .filter((call) => call.url.endsWith("/events"))
    .map((call) => JSON.parse(call.body) as { type?: string });
  assert.deepEqual(
    eventBodies.map((body) => body.type),
    ["support_bundle_uploaded", "error"]
  );
  assert.ok(jobStore.getByLoopId("loop-1")?.supportBundleUploadedAt);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);
});

test("finalizes dead jobs using LoopTokenStore and clears token after UNKNOWN replay", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore("boot-recovery-loop-tokens");
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-dead-store");
  const deadJob = createJob({
    status: "UNKNOWN",
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "UNKNOWN");
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);
  assert.ok(
    fetchCalls.some(
      (c) =>
        c.body.includes('"type":"error"') &&
        c.authHeader === "Bearer loop-token"
    )
  );
});

test("retries cloud finalization across boots and resumes from partial progress", async () => {
  // RUNNING job with no statePath: boot-recovery resolves to FAILED (no snapshot to derive
  // COMPLETED from). The finalizer posts an error event (PROCESS_FAILED) and no upload-artifacts
  // call is made. The error event succeeds on the first attempt, so cloud finalization completes
  // on the first boot and the loop token is cleared immediately.
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  // plan.json and open-questions.md are present in claudeWorkDir but there is NO statePath on
  // the job, so the new RUNNING-no-snapshot logic defaults to FAILED regardless.
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  await fs.writeFile(path.join(claudeWorkDir, "open-questions.md"), "none");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-retry-across-boots-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-retry-across-boots");
  const deadJob = createJob({
    status: "RUNNING",
    claudeWorkDir,
    // No statePath: RUNNING-no-snapshot -> FAILED
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });

  await service.run([deadJob]);
  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");
  assert.ok(persisted.finalStatusPersistedAt);
  assert.ok(persisted.cloudFinalizedAt);
  assert.equal(persisted.recoveryAttempts, 1);
  assert.ok(persisted.completedEventPostedAt);
  // Token cleared because cloud finalization succeeded on first boot
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);
  // No upload-artifacts call for a FAILED job
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/upload-artifacts"))
      .length,
    0
  );
  // One error event with code PROCESS_FAILED
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/events")).length,
    1
  );
  assert.ok(
    fetchCalls.some(
      (entry) =>
        entry.url.endsWith("/events") &&
        entry.body.includes('"type":"error"') &&
        entry.body.includes('"code":"PROCESS_FAILED"') &&
        entry.authHeader === "Bearer loop-token"
    )
  );
  service[Symbol.dispose]();
});

test("gives up after three retryable failures and stops future attempts", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore("boot-recovery-retry-cap-tokens");
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    return new Response("still down", { status: 502 });
  }) as typeof fetch;

  const jobStore = createStore("boot-recovery-retry-cap");
  const deadJob = createJob({
    status: "UNKNOWN",
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });

  await service.run([deadJob]);
  await service.run([]);
  await service.run([]);

  let persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.recoveryAttempts, 3);
  assert.ok(persisted.cloudFinalizedAt);
  assert.match(persisted.lastRecoveryError ?? "", /Exceeded retry cap/);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);
  const attemptsBeforeExtraRun = fetchCalls.length;

  await service.run([]);
  persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(fetchCalls.length, attemptsBeforeExtraRun);
  service[Symbol.dispose]();
});

test("skips dead job finalization when loop token is missing", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-dead-missing-token"
  );

  const jobStore = createStore("boot-recovery-dead-missing-token");
  const deadJob = createJob({
    status: "UNKNOWN",
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.finalStatusPersistedAt, undefined);
  assert.equal(fetchCalls.length, 0);
});

test("starts dead job finalization in the background", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-background-dead-finalize-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-background-dead-finalize");
  const deadJob = createJob({
    status: "UNKNOWN",
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  let releaseFetch: (() => void) | null = null;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  // Let the cloud status check (GET /loops/:id) pass immediately; only gate
  // event POSTs so that persistFinalJobStatus() runs before we assert.
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    if (isLoopStatusRequest(url, method)) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    await fetchGate;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });

  let completed = false;
  const background = service.startDeadJobFinalization([deadJob]).then(() => {
    completed = true;
  });
  await sleep(20);
  assert.equal(completed, false);
  assert.ok(jobStore.getByLoopId("loop-1")?.finalStatusPersistedAt);
  assert.equal(jobStore.getByLoopId("loop-1")?.cloudFinalizedAt, undefined);
  const unblockFetch = releaseFetch;
  assert.ok(unblockFetch);
  unblockFetch();
  await background;

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.ok(persisted.finalStatusPersistedAt);
  service[Symbol.dispose]();
});

test("dispose stops queued dead-job finalization after in-flight request", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const firstWorkDir = path.join(repoDir, "workdir-1");
  const secondWorkDir = path.join(repoDir, "workdir-2");
  await fs.mkdir(firstWorkDir, { recursive: true });
  await fs.mkdir(secondWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(firstWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  await fs.writeFile(
    path.join(secondWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-dispose-dead-finalize-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token-1" });
  loopTokenStore.setLoopToken("loop-2", { token: "loop-token-2" });

  const jobStore = createStore("boot-recovery-dispose-dead-finalize");
  const deadJobOne = createJob({
    status: "UNKNOWN",
    claudeWorkDir: firstWorkDir,
  });
  const deadJobTwo = createJob({
    id: "loop-2",
    loopId: "loop-2",
    status: "UNKNOWN",
    claudeWorkDir: secondWorkDir,
  });
  jobStore.upsert(deadJobOne);
  jobStore.upsert(deadJobTwo);

  let releaseFetch: (() => void) | null = null;
  // Resolves when the first event POST (not the status-check GET) starts, so
  // dispose() is called while exactly one loop's cloud call is in-flight.
  const firstEventPostStarted = new Promise<void>((resolve) => {
    globalThis.fetch = (async (
      input: URL | RequestInfo,
      init?: RequestInit
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      fetchCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        authHeader: headers.get("Authorization"),
      });
      // Status checks resolve immediately so finalization can reach the event POST.
      if (isLoopStatusRequest(url, method)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      resolve();
      await new Promise<void>((innerResolve) => {
        releaseFetch = innerResolve;
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
  });

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });

  const completion = service.startDeadJobFinalization([deadJobOne, deadJobTwo]);
  await firstEventPostStarted;
  service[Symbol.dispose]();
  const unblockFetch = releaseFetch;
  assert.ok(unblockFetch);
  unblockFetch();
  await completion;

  const finalizedOne = jobStore.getByLoopId("loop-1");
  const finalizedTwo = jobStore.getByLoopId("loop-2");
  assert.ok(finalizedOne?.finalStatusPersistedAt);
  assert.equal(finalizedTwo?.finalStatusPersistedAt, undefined);
  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/events")).length,
    1
  );
});

test("reattaches to live jobs and persists jsonl offsets", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");
  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-live-offset-loop-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-live-offset");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4011",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  await fs.appendFile(
    jsonlPath,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered output"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n'
  );
  await sleep(100);

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.ok((persisted.lastObservedJsonlOffset ?? 0) > 0);
  assert.ok(
    fetchCalls.some(
      (entry) =>
        entry.url.endsWith("/loops/loop-1/events") &&
        entry.authHeader === "Bearer loop-token"
    )
  );
  service[Symbol.dispose]();
});

test("live reattach does not persist jsonl offset past incomplete trailing line", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");
  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-partial-jsonl-loop-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-partial-jsonl");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4011",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  const incomplete =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"par';
  await fs.appendFile(jsonlPath, incomplete);
  await sleep(120);

  let persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(
    persisted.lastObservedJsonlOffset ?? 0,
    0,
    "partial JSONL tail must not advance persisted offset"
  );

  const rest = 'tial"}]}}\n';
  await fs.appendFile(jsonlPath, rest);
  await sleep(120);

  persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.ok(
    (persisted.lastObservedJsonlOffset ?? 0) > 0,
    "expected offset after a complete newline-delimited record and successful POST"
  );
  assert.ok(
    fetchCalls.some(
      (entry) =>
        entry.url.endsWith("/loops/loop-1/events") &&
        entry.authHeader === "Bearer loop-token"
    )
  );
  service[Symbol.dispose]();
});

test("skips live job reattach when loop token is missing", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-live-missing-token"
  );

  const jobStore = createStore("boot-recovery-live-missing-token");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4011",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  await fs.appendFile(
    jsonlPath,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"should not be tailed"}]}}\n'
  );
  await sleep(100);

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.lastObservedJsonlOffset, 0);
  assert.equal(fetchCalls.length, 0);
  service[Symbol.dispose]();
});

test("finalizes recovered live job as FAILED when process is externally killed", async () => {
  // Job with no statePath reattached as live, then killed externally via SIGTERM.
  // boot-recovery RUNNING-no-snapshot -> FAILED, so the finalizer posts an error event
  // (PROCESS_FAILED) and makes no upload-artifacts call.
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-live-kill-loop-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const child = spawn("bash", ["-lc", "sleep 5"], { detached: false });
  assert.ok(child.pid);

  const jobStore = createStore("boot-recovery-live-kill");
  const liveJob = createJob({
    pid: child.pid!,
    status: "RUNNING",
    claudeWorkDir,
    // No statePath: RUNNING-no-snapshot -> FAILED
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4012",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  // Kill the child to simulate an external termination
  process.kill(child.pid!, "SIGTERM");

  // Wait for boot-recovery to detect process exit and finalize to FAILED
  await waitForCondition(
    () => jobStore.getByLoopId("loop-1")?.status === "FAILED",
    5000
  );

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");
  // No upload-artifacts for a FAILED job
  assert.equal(
    fetchCalls.filter((entry) => entry.url.includes("/upload-artifacts"))
      .length,
    0
  );
  // Error event with code PROCESS_FAILED should have been posted
  assert.ok(
    fetchCalls.some(
      (entry) =>
        entry.url.endsWith("/loops/loop-1/events") &&
        entry.body.includes('"type":"error"') &&
        entry.body.includes('"code":"PROCESS_FAILED"') &&
        entry.authHeader === "Bearer loop-token"
    )
  );
  service[Symbol.dispose]();
});

test("preserves COMPLETED status when terminal snapshot is available during boot-recovery", async () => {
  // RUNNING job with statePath pointing to state.json containing {"status":"COMPLETED"}.
  // After the short-lived process exits, boot-recovery reads the snapshot, resolves to COMPLETED,
  // uploads artifacts, and posts a completed event — no error event should be emitted.
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const statePath = path.join(claudeWorkDir, "state.json");
  await fs.writeFile(statePath, JSON.stringify({ status: "COMPLETED" }));

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-live-completed-snapshot-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const child = spawn("bash", ["-lc", "sleep 0.1"], { detached: false });
  assert.ok(child.pid);

  const jobStore = createStore("boot-recovery-live-completed-snapshot");
  const liveJob = createJob({
    pid: child.pid!,
    status: "RUNNING",
    claudeWorkDir,
    statePath,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4013",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  // Wait for boot-recovery to detect process exit and finalize to COMPLETED
  await waitForCondition(
    () => jobStore.getByLoopId("loop-1")?.status === "COMPLETED",
    5000
  );

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "COMPLETED");
  assert.equal(persisted.exitCode ?? 0, 0);

  // upload-artifacts should have been called for a COMPLETED job
  assert.ok(
    fetchCalls.some((c) => c.url.includes("/upload-artifacts")),
    "expected /upload-artifacts call for COMPLETED job"
  );

  // A completed-type event should have been posted
  const completedEventCall = fetchCalls.find((c) =>
    c.body.includes('"type":"completed"')
  );
  assert.ok(completedEventCall, "expected type:completed event to be posted");
  const completedEvent = JSON.parse(completedEventCall.body) as {
    result?: { exitCode?: number };
  };
  assert.equal(completedEvent.result?.exitCode, 0);

  // No error event should have been emitted
  assert.ok(
    !fetchCalls.some((c) => c.body.includes('"type":"error"')),
    "expected no error event for COMPLETED job"
  );

  service[Symbol.dispose]();
});

test("replays zero-token EXECUTE recovery as NO_WORK_PRODUCED instead of a completed event", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const statePath = path.join(claudeWorkDir, "state.json");
  await fs.writeFile(statePath, JSON.stringify({ status: "COMPLETED" }));
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })}\n`,
    "utf-8"
  );

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-execute-no-work-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-execute-no-work");
  const deadJob = createJob({
    command: LoopCommand.Execute,
    status: "RUNNING",
    claudeWorkDir,
    statePath,
  });
  jobStore.upsert(deadJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4014",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");
  assert.equal(persisted.exitCode, 0);
  assert.equal(persisted.executeFinalizationStatus, undefined);
  assert.ok(persisted.cloudFinalizedAt);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);

  assert.equal(
    fetchCalls.filter((entry) => entry.url.endsWith("/upload-artifacts"))
      .length,
    0
  );
  assert.ok(
    fetchCalls.some(
      (entry) =>
        entry.url.endsWith("/loops/loop-1/events") &&
        entry.body.includes('"type":"error"') &&
        entry.body.includes('"code":"NO_WORK_PRODUCED"') &&
        entry.body.includes(
          '"message":"EXECUTE loop completed with 0 tokens -- no work was done"'
        )
    ),
    "expected NO_WORK_PRODUCED error event for zero-token EXECUTE recovery"
  );
  assert.ok(
    !fetchCalls.some((entry) => entry.body.includes('"type":"completed"')),
    "expected no completed event for zero-token EXECUTE recovery"
  );
});

test("boot-recovery replays terminal user-visible runner failure", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-terminal-runner-failure-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const persistedAt = new Date().toISOString();
  const jobStore = createStore("boot-recovery-terminal-runner-failure");
  jobStore.upsert(
    createJob({
      command: LoopCommand.Execute,
      status: "FAILED",
      exitCode: 1,
      claudeWorkDir,
      completedAt: persistedAt,
      finalStatusPersistedAt: persistedAt,
      userVisibleLoopFailure: {
        code: "RUNNER_ERROR",
        message: "Claude rate limit reached.",
        result: { subcode: "CLAUDE_RATE_LIMIT" },
      },
    })
  );

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4014",
    loopTokenStore,
  });
  await service.run([]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");
  assert.ok(persisted.cloudFinalizedAt);
  assert.equal(persisted.recoveryAttempts, 1);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);

  const eventCall = fetchCalls.find((entry) =>
    entry.url.endsWith("/loops/loop-1/events")
  );
  assert.ok(eventCall, "expected recovered runner failure event");
  const body = JSON.parse(eventCall.body) as Record<string, unknown>;
  assert.equal(body.type, "error");
  assert.equal(body.code, "RUNNER_ERROR");
  assert.equal(body.message, "Claude rate limit reached.");
  assert.deepEqual(body.result, { subcode: "CLAUDE_RATE_LIMIT" });
});

test("replays EXECUTE completion from persisted execution-result artifacts during boot-recovery", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    })}\n`,
    "utf-8"
  );
  await fs.writeFile(
    path.join(claudeWorkDir, "execution-result.json"),
    JSON.stringify({
      schemaVersion: 2,
      results: [
        {
          status: "success",
          fullName: "owner/repo",
          prUrl: "https://github.com/owner/repo/pull/123",
          prNumber: 123,
          branchName: "feat/recovered-execute",
          baseBranch: "main",
          hasChanges: true,
          commitSha: "abc123",
        },
      ],
    })
  );

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-execute-artifact-existing-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const persistedAt = new Date().toISOString();
  const jobStore = createStore("boot-recovery-execute-artifact-existing");
  const finalizedJob = createJob({
    command: LoopCommand.Execute,
    status: "COMPLETED",
    finalStatusPersistedAt: persistedAt,
    completedAt: persistedAt,
    claudeWorkDir,
  });
  jobStore.upsert(finalizedJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4014",
    loopTokenStore,
  });
  await service.run([]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "COMPLETED");
  assert.ok(persisted.cloudFinalizedAt);
  assert.equal(persisted.recoveryAttempts, 1);
  assert.equal(persisted.finalizationSource, "boot-recovery");
  assert.equal(persisted.executeFinalizationStatus, "success");
  assert.equal(persisted.executeFinalizationPath, "artifact-existing");
  assert.equal(
    persisted.executeFinalizationReason,
    "existing execution-result.json reused"
  );
  assert.equal(persisted.executeFinalizationPreExecutionResultPresent, true);
  assert.equal(persisted.executeFinalizationPostExecutionResultPresent, true);
  assert.equal(loopTokenStore.getLoopToken("loop-1"), null);

  const uploadCall = fetchCalls.find((entry) =>
    entry.url.endsWith("/upload-artifacts")
  );
  assert.ok(
    uploadCall,
    "expected /upload-artifacts call for recovered EXECUTE job"
  );
  const uploadBody = JSON.parse(uploadCall.body) as {
    metadata?: Record<string, unknown>;
    artifacts?: { executionResult?: Record<string, unknown> };
  };
  assert.equal(uploadBody.metadata?.finalizationSource, "boot-recovery");
  assert.equal(uploadBody.metadata?.executeFinalizationStatus, "success");
  assert.equal(
    uploadBody.metadata?.executeFinalizationPath,
    "artifact-existing"
  );
  const executionResultV2 = uploadBody.artifacts?.executionResult as
    | {
        schemaVersion?: number;
        results?: Array<{ branchName?: string }>;
      }
    | undefined;
  assert.equal(executionResultV2?.schemaVersion, 2);
  assert.equal(
    executionResultV2?.results?.[0]?.branchName,
    "feat/recovered-execute"
  );

  const completedEventCall = fetchCalls.find((entry) =>
    entry.body.includes('"type":"completed"')
  );
  assert.ok(completedEventCall, "expected type:completed event to be posted");
  const completedEvent = JSON.parse(completedEventCall.body) as {
    result?: Record<string, unknown>;
  };
  assert.equal(completedEvent.result?.finalizationSource, "boot-recovery");
  assert.equal(completedEvent.result?.executeFinalizationStatus, "success");
  assert.equal(
    completedEvent.result?.executeFinalizationPath,
    "artifact-existing"
  );
  assert.equal(completedEvent.result?.branchName, "feat/recovered-execute");
});

test("sweepOrphanedTokens removes tokens for finalized and unknown loops, keeps active", async () => {
  const jobStore = createStore("boot-recovery-sweep");
  const loopTokenStore = createLoopTokenStore("boot-recovery-sweep-tokens");

  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  // (a) Cloud-finalized terminal job — token should be swept
  const finalizedJob = createJob({
    id: "loop-finalized",
    loopId: "loop-finalized",
    status: "COMPLETED",
    claudeWorkDir,
    cloudFinalizedAt: new Date().toISOString(),
    finalStatusPersistedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
  jobStore.upsert(finalizedJob);
  loopTokenStore.setLoopToken("loop-finalized", { token: "token-finalized" });

  // (b) Loop ID not in job store at all — token should be swept
  loopTokenStore.setLoopToken("loop-unknown", { token: "token-unknown" });

  // (c) Still-running job — token must be preserved
  const runningJob = createJob({
    id: "loop-active",
    loopId: "loop-active",
    status: "RUNNING",
    pid: process.pid,
    claudeWorkDir,
  });
  jobStore.upsert(runningJob);
  loopTokenStore.setLoopToken("loop-active", { token: "token-active" });

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4010",
    loopTokenStore,
  });
  await service.run([]);
  service[Symbol.dispose]();

  assert.equal(loopTokenStore.getLoopToken("loop-finalized"), null);
  assert.equal(loopTokenStore.getLoopToken("loop-unknown"), null);
  assert.deepEqual(loopTokenStore.getLoopToken("loop-active"), {
    token: "token-active",
  });
});

function makeSimpleRemoveProvider(): WorktreeProvider {
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
      return null;
    },
    branchExists: async () => false,
  };
}

async function runAdditionalCleanup(dir: string): Promise<void> {
  await cleanupAdditionalWorktrees(
    [{ dir, repoPath: dir }],
    "test-loop",
    makeSimpleRemoveProvider()
  );
}

test("cleanupAdditionalWorktrees removes worktree with no code changes", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-clean-"));
  try {
    await initGitRepo(repoRoot);
    await runAdditionalCleanup(repoRoot);
    assert.ok(!existsSync(repoRoot), "expected clean worktree to be removed");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "staged changes",
    setup: async (repoRoot: string) => {
      await fs.writeFile(path.join(repoRoot, "work.txt"), "work in progress");
      execFileSync("git", ["add", "work.txt"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    },
  },
  {
    name: "committed-only changes on a symphony branch",
    setup: async (repoRoot: string) => {
      execFileSync("git", ["checkout", "-b", "symphony/test-loop"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
      await fs.writeFile(path.join(repoRoot, "feature.txt"), "committed work");
      execFileSync("git", ["add", "feature.txt"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
      execFileSync("git", ["commit", "-m", "wip"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    },
  },
] as const) {
  test(`cleanupAdditionalWorktrees retains worktree with ${scenario.name}`, async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cleanup-retain-")
    );
    try {
      await initGitRepo(repoRoot);
      await scenario.setup(repoRoot);
      await runAdditionalCleanup(repoRoot);
      assert.ok(existsSync(repoRoot), "expected worktree to be retained");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
}

test("cleanupAdditionalWorktrees retains worktree when git status fails unexpectedly", async () => {
  const nonRepoDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cleanup-nonrepo-")
  );
  try {
    const sentinel = path.join(nonRepoDir, "user-work.txt");
    await fs.writeFile(sentinel, "do not delete");
    await runAdditionalCleanup(nonRepoDir);
    assert.ok(existsSync(nonRepoDir), "expected worktree to be retained");
    assert.ok(
      existsSync(sentinel),
      "expected user files to remain on git error"
    );
  } finally {
    await fs.rm(nonRepoDir, { recursive: true, force: true });
  }
});

test("reattachLiveJob transitions to TIMED_OUT when cloud reports TIMED_OUT", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  const worktreeDir = path.join(tempRoot, "worktree");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.mkdir(worktreeDir, { recursive: true });

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-reattach-timed-out-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-reattach-timed-out");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    worktreeDir,
  });
  jobStore.upsert(liveJob);

  installCloudStatusFetchMock(() => Response.json({ status: "TIMED_OUT" }));

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4020",
    loopTokenStore,
  });
  await service.reattachLiveJobs();
  await sleep(100);

  assert.equal(
    fetchCalls.length,
    1,
    "expected exactly one fetch call (GET status check)"
  );
  assert.ok(
    fetchCalls[0].url.includes("/loops/loop-1") &&
      !fetchCalls[0].url.includes("/events") &&
      !fetchCalls[0].url.includes("/upload-artifacts"),
    "expected GET to /loops/loop-1 status endpoint"
  );

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(persisted.status, "TIMED_OUT");
  assert.equal(
    persisted.liveActivity,
    "Loop timed out — restart from the loop list.",
    "expected TIMED_OUT liveActivity message"
  );
  assert.ok(persisted.cloudFinalizedAt, "expected cloudFinalizedAt to be set");
  assert.equal(
    loopTokenStore.getLoopToken("loop-1"),
    null,
    "expected loop token cleared"
  );
  assert.ok(
    existsSync(worktreeDir),
    "expected worktreeDir to remain on disk after TIMED_OUT"
  );
  service[Symbol.dispose]();
});

test("reattachLiveJob starts tailer when cloud reports RUNNING", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-reattach-running-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-reattach-running");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  installCloudStatusFetchMock(() => Response.json({ status: "RUNNING" }));

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4021",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  // Write a complete JSONL record to trigger a tailer event POST
  await fs.appendFile(
    jsonlPath,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"recovered"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n'
  );

  await waitForCondition(
    () => fetchCalls.some((c) => c.url.includes("/loops/loop-1/events")),
    5000
  );

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.notEqual(
    persisted.status,
    "TIMED_OUT",
    "expected status not to be TIMED_OUT"
  );
  assert.ok(
    fetchCalls.some((c) => c.url.includes("/loops/loop-1/events")),
    "expected at least one POST to /events from tailer"
  );
  service[Symbol.dispose]();
});

test("reattachLiveJob continues when GET status check throws a network error", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-reattach-net-err-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-reattach-net-err");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  installCloudStatusFetchMock(() => {
    throw new Error("network failure");
  });

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4022",
    loopTokenStore,
  });
  await service.reattachLiveJobs();

  const beforeWrite = jobStore.getByLoopId("loop-1");
  assert.ok(beforeWrite);
  assert.notEqual(
    beforeWrite.status,
    "TIMED_OUT",
    "network error must not transition job to TIMED_OUT"
  );

  // Verify tailer is running: write a JSONL record and wait for it to be picked up
  await fs.appendFile(
    jsonlPath,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"net-err-test"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n'
  );

  await waitForCondition(
    () => fetchCalls.some((c) => c.url.includes("/loops/loop-1/events")),
    5000
  );

  assert.ok(
    fetchCalls.some((c) => c.url.includes("/loops/loop-1/events")),
    "expected tailer to start and POST /events after network error on status check"
  );
  service[Symbol.dispose]();
});

test("finalizeDeadJobs skips finalization and sets cloudFinalizedAt when cloud reports TIMED_OUT", async () => {
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-dead-timed-out-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-dead-timed-out");
  const deadJob = createJob({
    status: "RUNNING",
    pid: 9_999_999,
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  installCloudStatusFetchMock(() => Response.json({ status: "TIMED_OUT" }));

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4023",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.ok(
    persisted.cloudFinalizedAt,
    "expected cloudFinalizedAt to be set on TIMED_OUT"
  );
  assert.equal(
    loopTokenStore.getLoopToken("loop-1"),
    null,
    "expected loop token cleared"
  );
  assert.equal(
    fetchCalls.filter((c) => c.url.includes("/events")).length,
    0,
    "expected zero POST /events calls for TIMED_OUT job"
  );
  assert.equal(
    fetchCalls.filter((c) => c.url.includes("/upload-artifacts")).length,
    0,
    "expected zero POST /upload-artifacts calls for TIMED_OUT job"
  );
  assert.equal(
    persisted.finalStatusPersistedAt,
    undefined,
    "finalStatusPersistedAt must NOT be set for cloud-TIMED_OUT jobs"
  );
});

test("reattachLiveJob starts refresh scheduler for recovered loop", async () => {
  // Set skew to 0 and expiresAt in the near past so the scheduler fires
  // immediately (delay = max(expiresAt - skew - now, 0) = 0).
  const savedSkewEnv = process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS;
  process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = "0";

  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-scheduler-start-tokens"
  );
  // expiresAt in the past → scheduler fires immediately with skew=0
  const expiresAt = Date.now() - 1000;
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token", expiresAt });

  const jobStore = createStore("boot-recovery-scheduler-start");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4030",
    loopTokenStore,
  });
  try {
    await service.reattachLiveJobs();

    // Wait for the scheduler to fire and call /refresh-token
    await waitForCondition(
      () => fetchCalls.some((c) => c.url.includes("/refresh-token")),
      3000
    );

    assert.ok(
      fetchCalls.some((c) => c.url.includes("/loops/loop-1/refresh-token")),
      "expected refresh scheduler to start and POST to /refresh-token"
    );
  } finally {
    service[Symbol.dispose]();
    if (savedSkewEnv === undefined) {
      delete process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS;
    } else {
      process.env.CLOSEDLOOP_TOKEN_REFRESH_SKEW_MS = savedSkewEnv;
    }
  }
});

test("reattachLiveJob starts heartbeat scheduler for recovered loop", async () => {
  // Use a very short heartbeat interval so the scheduler fires quickly.
  const savedHeartbeatEnv = process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS;
  process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = "50";

  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-heartbeat-start-tokens"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "loop-token" });

  const jobStore = createStore("boot-recovery-heartbeat-start");
  const liveJob = createJob({
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: () => {} },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4031",
    loopTokenStore,
  });
  try {
    await service.reattachLiveJobs();

    // Wait for the heartbeat scheduler to fire
    await waitForCondition(
      () => fetchCalls.some((c) => c.url.includes("/heartbeat")),
      3000
    );

    assert.ok(
      fetchCalls.some((c) => c.url.includes("/loops/loop-1/heartbeat")),
      "expected heartbeat scheduler to start and POST to /heartbeat"
    );
  } finally {
    service[Symbol.dispose]();
    if (savedHeartbeatEnv === undefined) {
      delete process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.CLOSEDLOOP_HEARTBEAT_INTERVAL_MS = savedHeartbeatEnv;
    }
  }
});

// ---------------------------------------------------------------------------
// T-4.3: Table-driven boot-recovery tests for terminal / transient / live
// status-check responses on the reattachLiveJob path.
//
// Each case drives a live job (pid = process.pid) through reattachLiveJobs()
// with a mocked GET /loops/:id status endpoint returning the prescribed
// HTTP status or body. Shared assertions:
//   Terminal  → job has cloudFinalizedAt, schedulers.teardownLoop() called,
//               registerRecoveredLoop NOT called (getActiveLoopPid returns null)
//   Transient → job NOT finalized, registerRecoveredLoop IS called,
//               tailer starts and POSTs events
// ---------------------------------------------------------------------------

// Each test case uses a unique loopId to avoid cross-test pollution of the
// module-level `runningLoops` map in symphony-loop.ts. The map is only cleared
// when `unregisterLoop` is called (e.g. when the watcher detects process exit),
// so reusing "loop-1" across tests would cause `getActiveLoopPid` to return a
// stale value from an earlier test. Unique IDs ensure clean assertions.
// Each case is keyed by a single discriminator; the loopId, store name, token
// store name, and workdir are all derived from `key` in the test body so the
// per-row fixture carries no redundant identity triplet.
const reattachStatusCases = [
  {
    key: "401",
    name: "reattachLiveJob does not reattach on HTTP 401 (unauthorized after failed refresh-retry)",
    // The status endpoint returns 401, which triggers a token refresh attempt.
    // The refresh endpoint also returns 401 (or any non-success), so the refresh
    // fails and the result stays `unauthorized` — terminal disposition.
    statusHandler: () => new Response("Unauthorized", { status: 401 }),
    port: 4040,
    disposition: "terminal" as const,
  },
  {
    key: "404",
    name: "reattachLiveJob does not reattach on HTTP 404 (loop not found)",
    statusHandler: () => new Response("Not Found", { status: 404 }),
    port: 4041,
    disposition: "terminal" as const,
  },
  {
    key: "410",
    name: "reattachLiveJob does not reattach on HTTP 410 (loop gone)",
    statusHandler: () => new Response("Gone", { status: 410 }),
    port: 4042,
    disposition: "terminal" as const,
  },
  {
    key: "5xx",
    name: "reattachLiveJob conservatively reattaches on 5xx transient error from status check",
    // 502 from the status-check endpoint — cloud may recover; do not terminalize.
    statusHandler: () => new Response("Bad Gateway", { status: 502 }),
    port: 4043,
    disposition: "transient" as const,
  },
] as const;

for (const tc of reattachStatusCases) {
  test(tc.name, async () => {
    const { key } = tc;
    const loopId = `loop-reattach-${key}`;
    const repoDir = path.join(tempRoot, "repo");
    const claudeWorkDir = path.join(repoDir, `workdir-${key}`);
    await fs.mkdir(claudeWorkDir, { recursive: true });
    const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
    await fs.writeFile(jsonlPath, "");

    const loopTokenStore = createLoopTokenStore(
      `boot-recovery-reattach-${key}-tokens`
    );
    loopTokenStore.setLoopToken(loopId, { token: "loop-token" });

    const jobStore = createStore(`boot-recovery-reattach-${key}`);
    const liveJob = createJob({
      id: loopId,
      loopId,
      pid: process.pid,
      status: "RUNNING",
      claudeWorkDir,
      jsonlPath,
      lastObservedJsonlOffset: 0,
    });
    jobStore.upsert(liveJob);

    const { schedulers, teardownCalls } = createSchedulersWithTeardownSpy();

    // installCloudStatusFetchMock delegates GET /loops/:id to the handler;
    // all other requests (refresh-token, events) return success.
    installCloudStatusFetchMock(tc.statusHandler);

    const service = new BootRecoveryService({
      jobStore,
      telemetry: { emit: (event) => telemetryEvents.push(event) },
      getApiKey: () => "test-key",
      getApiOrigin: () => `http://127.0.0.1:${tc.port}`,
      loopTokenStore,
      schedulers,
    });
    await service.reattachLiveJobs();
    // Allow any background microtasks to settle.
    await sleep(100);

    const persisted = jobStore.getByLoopId(loopId);
    assert.ok(persisted, "expected job to exist in store");

    if (tc.disposition === "terminal") {
      assert.ok(
        persisted.cloudFinalizedAt,
        `expected cloudFinalizedAt to be set for terminal case (${key})`
      );
      assert.equal(
        loopTokenStore.getLoopToken(loopId),
        null,
        `expected loop token cleared for terminal case (${key})`
      );
      assert.ok(
        teardownCalls.includes(loopId),
        `expected schedulers.teardownLoop("${loopId}") to be called for terminal case (${key})`
      );
      // registerRecoveredLoop was NOT called — the loopId must be absent from
      // the module-level runningLoops map (getActiveLoopPid returns null).
      assert.equal(
        getActiveLoopPid(loopId),
        null,
        `expected registerRecoveredLoop NOT called for terminal case (${key})`
      );
    } else {
      // Transient: job must NOT be finalized; tailer must be running.
      assert.equal(
        persisted.cloudFinalizedAt,
        undefined,
        `expected cloudFinalizedAt NOT set for transient case (${key})`
      );
      // registerRecoveredLoop should have been called (conservative reattach).
      assert.notEqual(
        getActiveLoopPid(loopId),
        null,
        `expected registerRecoveredLoop called for transient case (${key})`
      );

      // Verify the tailer is running by writing a JSONL record and waiting for the POST.
      await fs.appendFile(
        jsonlPath,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"transient-test"}],"usage":{"input_tokens":1,"output_tokens":1}}}\n'
      );
      await waitForCondition(
        () => fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/events`)),
        5000
      );
      assert.ok(
        fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/events`)),
        `expected tailer to POST /events for transient case (${key})`
      );
    }

    service[Symbol.dispose]();
  });
}

test("AC-004: per-request provider resolution uses token at call time, not at construction time", async () => {
  // Verifies that getToken() is resolved on every fetch call so that a token
  // rotation between the artifact-upload and the completed-event POST results
  // in different Authorization headers for each request.
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );
  await fs.writeFile(path.join(claudeWorkDir, "open-questions.md"), "none");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-per-request-token"
  );
  loopTokenStore.setLoopToken("loop-1", { token: "token-before-upload" });

  const jobStore = createStore("boot-recovery-per-request");
  const deadJob = createJob({
    status: "RUNNING",
    claudeWorkDir,
    // No statePath so RUNNING-no-snapshot resolves to FAILED (no upload-artifacts call).
    // To exercise both upload-artifacts and completed-event, we need a COMPLETED snapshot.
    statePath: path.join(claudeWorkDir, "state.json"),
  });
  await fs.writeFile(
    path.join(claudeWorkDir, "state.json"),
    JSON.stringify({ status: "COMPLETED" })
  );
  jobStore.upsert(deadJob);

  // Intercept fetch: when the upload-artifacts call is captured, rotate the token
  // in loopTokenStore so the subsequent completed-event call picks up the new value.
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    if (url.includes("/upload-artifacts")) {
      // Rotate the token after the upload-artifacts call is captured.
      loopTokenStore.setLoopToken("loop-1", { token: "token-after-upload" });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4015",
    loopTokenStore,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  const uploadCall = fetchCalls.find((c) =>
    c.url.includes("/upload-artifacts")
  );
  assert.ok(uploadCall, "expected upload-artifacts fetch call");
  assert.equal(
    uploadCall.authHeader,
    "Bearer token-before-upload",
    "artifact upload must use token resolved at upload time"
  );

  const completedEventCall = fetchCalls.find((c) =>
    c.body.includes('"type":"completed"')
  );
  assert.ok(completedEventCall, "expected completed-event fetch call");
  assert.equal(
    completedEventCall.authHeader,
    "Bearer token-after-upload",
    "completed-event POST must use token resolved at post time (per-request resolution)"
  );
});

// AC-007 regression: RUNNING job with dead PID at boot must be finalized as UNKNOWN.
//
// Flow mirrors what app.ts does at startup:
//   1. reconcileJobStore() detects the dead PID and maps the job to UNKNOWN.
//   2. The reconciled UNKNOWN job is passed to BootRecoveryService.run().
//   3. finalizeDeadJobs() picks it up, posts an error event, sets
//      finalStatusPersistedAt, and clears the loop token.
//   4. reattachLiveJobs() never registers the loop (process was already dead),
//      so getActiveLoopPid returns null — the job is NOT presented as active.
//
// Uses a unique loopId ("loop-ac007") to avoid cross-test pollution of the
// module-level runningLoops map in symphony-loop.ts (same precaution taken by
// the reattachStatusCases suite; see comment at line ~1590).
test("AC-007 regression: RUNNING job with dead PID at boot is finalized as UNKNOWN and not presented as active", async () => {
  const loopId = "loop-ac007";
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore("boot-recovery-ac007-tokens");
  loopTokenStore.setLoopToken(loopId, { token: "loop-token" });

  const jobStore = createStore("boot-recovery-ac007");
  // Seed the job as RUNNING with a dead PID (9_999_999 is guaranteed not to exist).
  const runningJob = createJob({
    id: loopId,
    loopId,
    status: "RUNNING",
    pid: 9_999_999,
    claudeWorkDir,
  });
  jobStore.upsert(runningJob);

  // Simulate reconcileJobStore(): detect the dead PID and transition to UNKNOWN.
  // reconcile() returns the jobs it moved to terminal state, matching what app.ts
  // passes as the `deadJobs` argument to BootRecoveryService.run(). Uses the same
  // production liveness predicate (isProcessRunning) rather than a hand-rolled
  // process.kill probe, so the regression tracks the real predicate.
  const deadJobs = jobStore.reconcile((job) => {
    if (isProcessRunning(job.pid!)) {
      return job;
    }
    const now = new Date().toISOString();
    return { ...job, status: "UNKNOWN", updatedAt: now, completedAt: now };
  });

  // Verify the reconciliation produced exactly one UNKNOWN job.
  assert.equal(
    deadJobs.length,
    1,
    "expected reconcileJobStore to produce one dead job"
  );
  assert.equal(
    deadJobs[0].status,
    "UNKNOWN",
    "expected reconciled job status to be UNKNOWN"
  );

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "test-key",
    getApiOrigin: () => "http://127.0.0.1:4024",
    loopTokenStore,
  });
  await service.run(deadJobs);
  service[Symbol.dispose]();

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted, "expected job to exist in store after boot recovery");

  // AC-007a: job status remains UNKNOWN (not promoted to a different terminal status).
  assert.equal(
    persisted.status,
    "UNKNOWN",
    "expected status to remain UNKNOWN after finalization"
  );

  // AC-007b: finalStatusPersistedAt is set — the job was finalized.
  assert.ok(
    persisted.finalStatusPersistedAt,
    "expected finalStatusPersistedAt to be set"
  );

  // AC-007c: loop token is deleted — not lingering after finalization.
  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "expected loop token to be cleared"
  );

  // AC-007d: an error event was posted to the cloud with PROCESS_STOPPED code.
  assert.ok(
    fetchCalls.some(
      (c) =>
        c.body.includes('"type":"error"') &&
        c.body.includes('"code":"PROCESS_STOPPED"') &&
        c.authHeader === "Bearer loop-token"
    ),
    "expected error event with PROCESS_STOPPED code to be posted"
  );

  // AC-007e: job is NOT presented as active — getActiveLoopPid returns null
  // because reattachLiveJobs() never called registerRecoveredLoop (the process was dead).
  assert.equal(
    getActiveLoopPid(loopId),
    null,
    "expected dead-PID-at-boot loop to not be registered as active"
  );
});

// ---------------------------------------------------------------------------
// PLN-757: Boot-recovery PoP heartbeat revival for DESKTOP_MANAGED loops
//
// T-3.1: Runner JWT 401 + successful PoP revival → loop revived, token persisted
// T-3.2: Runner JWT 401 + PoP heartbeat returns 410 → loop finalized terminal
// T-3.3: Runner JWT 401 + USER_CREATED provenance → no PoP attempted, terminal
// ---------------------------------------------------------------------------

/**
 * Returns true when `url`/`method` target the heartbeat endpoint
 * (POST /loops/:id/heartbeat).
 */
function isHeartbeatRequest(url: string, method: string): boolean {
  return url.includes("/heartbeat") && method === "POST";
}

/**
 * Returns true when `url`/`method` target the refresh-token endpoint
 * (POST /loops/:id/refresh-token).
 */
function isRefreshTokenRequest(url: string, method: string): boolean {
  return url.includes("/refresh-token") && method === "POST";
}

/**
 * Install a fetch mock that returns 401 on GET /loops/:id (status check),
 * 401 on POST /loops/:id/refresh-token (refresh also fails), and delegates
 * POST /loops/:id/heartbeat to `heartbeatHandler`. All other requests return
 * success.
 */
function installPopRevivalFetchMock(
  heartbeatHandler: (url: string) => Response
): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      authHeader: headers.get("Authorization"),
    });
    if (isLoopStatusRequest(url, method)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (isRefreshTokenRequest(url, method)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (isHeartbeatRequest(url, method)) {
      return heartbeatHandler(url);
    }
    return Response.json({ success: true });
  }) as typeof fetch;
}

test("T-3.1 PLN-757: DESKTOP_MANAGED loop revived via PoP heartbeat on boot (runner JWT 401)", async () => {
  const loopId = "loop-pop-revival-success";
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir-pop-success");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-pop-revival-success-tokens"
  );
  loopTokenStore.setLoopToken(loopId, { token: "stale-jwt" });

  const jobStore = createStore("boot-recovery-pop-revival-success");
  const liveJob = createJob({
    id: loopId,
    loopId,
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  // PoP heartbeat succeeds with revival fields: fresh token, jti, expiresAt
  installPopRevivalFetchMock(() =>
    Response.json({
      success: true,
      data: {
        revived: true,
        token: "fresh-runner-jwt",
        jti: "fresh-jti-001",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })
  );

  const schedulers = new LoopSchedulerContext();

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "managed-api-key",
    getApiOrigin: () => "http://127.0.0.1:4050",
    loopTokenStore,
    schedulers,
    // DESKTOP_MANAGED provenance with PoP deps present
    getApiKeyProvenance: () => "DESKTOP_MANAGED",
    ...testPopDeps,
  });
  await service.reattachLiveJobs();
  await sleep(100);

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted, "expected job to exist in store");

  // AC-001: Loop is NOT finalized as UNKNOWN — it was revived and reattached.
  assert.equal(
    persisted.cloudFinalizedAt,
    undefined,
    "expected cloudFinalizedAt NOT set — loop was revived, not finalized"
  );
  assert.notEqual(
    persisted.status,
    "UNKNOWN",
    "expected status to NOT be UNKNOWN after PoP revival"
  );

  // AC-003: Revival token persisted to the loop token store.
  const tokenMeta = loopTokenStore.getLoopToken(loopId);
  assert.ok(tokenMeta, "expected revival token to be persisted");
  assert.equal(
    tokenMeta.token,
    "fresh-runner-jwt",
    "expected fresh runner JWT in token store"
  );
  assert.equal(
    tokenMeta.jti,
    "fresh-jti-001",
    "expected fresh jti in token store"
  );
  assert.ok(tokenMeta.expiresAt, "expected expiresAt in token store");

  // AC-004: PoP heartbeat was attempted (heartbeat endpoint was called).
  assert.ok(
    fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/heartbeat`)),
    "expected PoP heartbeat to have been attempted"
  );

  // Loop was reattached (registerRecoveredLoop was called).
  assert.notEqual(
    getActiveLoopPid(loopId),
    null,
    "expected loop to be registered as active after PoP revival"
  );

  service[Symbol.dispose]();
});

test("T-3.2 PLN-757: DESKTOP_MANAGED loop finalized terminal when PoP heartbeat returns 410", async () => {
  const loopId = "loop-pop-revival-410";
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir-pop-410");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-pop-revival-410-tokens"
  );
  loopTokenStore.setLoopToken(loopId, { token: "stale-jwt" });

  const jobStore = createStore("boot-recovery-pop-revival-410");
  const liveJob = createJob({
    id: loopId,
    loopId,
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  // PoP heartbeat returns 410 (revival refused / cap reached)
  installPopRevivalFetchMock(() => new Response("Gone", { status: 410 }));

  const { schedulers, teardownCalls } = createSchedulersWithTeardownSpy();

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "managed-api-key",
    getApiOrigin: () => "http://127.0.0.1:4051",
    loopTokenStore,
    schedulers,
    getApiKeyProvenance: () => "DESKTOP_MANAGED",
    ...testPopDeps,
  });
  await service.reattachLiveJobs();
  await sleep(100);

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted, "expected job to exist in store");

  // AC-002: Loop IS finalized as terminal (PoP heartbeat returned 410).
  assert.ok(
    persisted.cloudFinalizedAt,
    "expected cloudFinalizedAt to be set — PoP heartbeat returned terminal 410"
  );

  // Token deleted from store.
  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "expected loop token cleared after terminal PoP heartbeat"
  );

  // Schedulers torn down.
  assert.ok(
    teardownCalls.includes(loopId),
    `expected schedulers.teardownLoop("${loopId}") to be called for terminal PoP case`
  );

  // PoP heartbeat was attempted.
  assert.ok(
    fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/heartbeat`)),
    "expected PoP heartbeat to have been attempted before terminal finalization"
  );

  // Loop is NOT presented as active.
  assert.equal(
    getActiveLoopPid(loopId),
    null,
    "expected loop NOT to be registered as active after terminal PoP heartbeat"
  );

  service[Symbol.dispose]();
});

test("T-3.3 PLN-757: USER_CREATED loop — no PoP heartbeat attempted, terminal classification preserved", async () => {
  const loopId = "loop-user-created-401";
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir-user-created");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
  await fs.writeFile(jsonlPath, "");

  const loopTokenStore = createLoopTokenStore(
    "boot-recovery-user-created-401-tokens"
  );
  loopTokenStore.setLoopToken(loopId, { token: "stale-jwt" });

  const jobStore = createStore("boot-recovery-user-created-401");
  const liveJob = createJob({
    id: loopId,
    loopId,
    pid: process.pid,
    status: "RUNNING",
    claudeWorkDir,
    jsonlPath,
    lastObservedJsonlOffset: 0,
  });
  jobStore.upsert(liveJob);

  // Status check returns 401, refresh also returns 401 — should go terminal
  // with no PoP heartbeat attempted.
  installPopRevivalFetchMock(() => {
    // This heartbeat handler should never be called for USER_CREATED loops.
    throw new Error(
      "PoP heartbeat should NOT be called for USER_CREATED loops"
    );
  });

  const { schedulers, teardownCalls } = createSchedulersWithTeardownSpy();

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "user-api-key",
    getApiOrigin: () => "http://127.0.0.1:4052",
    loopTokenStore,
    schedulers,
    // USER_CREATED provenance — no PoP channel
    getApiKeyProvenance: () => "USER_CREATED",
    ...testPopDeps,
  });
  await service.reattachLiveJobs();
  await sleep(100);

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted, "expected job to exist in store");

  // AC-005: Existing terminal classification preserved for USER_CREATED.
  assert.ok(
    persisted.cloudFinalizedAt,
    "expected cloudFinalizedAt to be set — USER_CREATED 401 is always terminal"
  );

  // Token deleted from store.
  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "expected loop token cleared for terminal USER_CREATED loop"
  );

  // Schedulers torn down.
  assert.ok(
    teardownCalls.includes(loopId),
    `expected schedulers.teardownLoop("${loopId}") to be called`
  );

  // No heartbeat request should have been made (only status check and refresh).
  assert.ok(
    !fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/heartbeat`)),
    "expected NO PoP heartbeat for USER_CREATED provenance"
  );

  // Loop is NOT presented as active.
  assert.equal(
    getActiveLoopPid(loopId),
    null,
    "expected loop NOT to be registered as active"
  );

  service[Symbol.dispose]();
});

// ---------------------------------------------------------------------------
// PR#256: transient PoP heartbeat must not tear down a still-running live loop,
// and the dead-job path must never attempt PoP revival.
//
// T-3.4: Runner JWT 401 + PoP heartbeat returns a *transient* error (5xx, or a
//        network/timeout failure) → live loop is NOT finalized, token retained,
//        loop reattached conservatively, schedulers NOT torn down.
// T-3.5: Dead-PID DESKTOP_MANAGED loop routed through finalizeDeadJobs → PoP
//        heartbeat is NEVER attempted (revival suppressed for dead jobs) and
//        the job is finalized as terminal/UNKNOWN.
// ---------------------------------------------------------------------------

// Table-driven over the two transient heartbeat shapes (CLAUDE.md test harness
// convention). Each case supplies the heartbeat handler that produces the
// transient signal; assertions are identical (conservative reattach).
const transientPopHeartbeatCases: ReadonlyArray<{
  key: string;
  heartbeatHandler: () => Response;
}> = [
  {
    key: "5xx",
    // 503 → postLoopHeartbeat returns { kind: "http", status: 503 } →
    // classifyLoopStatus(503) = transient/server_error.
    heartbeatHandler: () =>
      new Response("Service Unavailable", { status: 503 }),
  },
  {
    key: "network",
    // A thrown fetch → postLoopHeartbeat returns { kind: "network" } →
    // classifyLoopStatus(null) = transient/network_error.
    heartbeatHandler: () => {
      throw new Error("simulated network failure");
    },
  },
];

for (const tc of transientPopHeartbeatCases) {
  test(`T-3.4 PR#256: DESKTOP_MANAGED live loop reattaches conservatively on transient PoP heartbeat (${tc.key})`, async () => {
    const loopId = `loop-pop-transient-${tc.key}`;
    const repoDir = path.join(tempRoot, "repo");
    const claudeWorkDir = path.join(repoDir, `workdir-pop-transient-${tc.key}`);
    await fs.mkdir(claudeWorkDir, { recursive: true });
    const jsonlPath = path.join(claudeWorkDir, "claude-output.jsonl");
    await fs.writeFile(jsonlPath, "");

    const loopTokenStore = createLoopTokenStore(
      `boot-recovery-pop-transient-${tc.key}-tokens`
    );
    loopTokenStore.setLoopToken(loopId, { token: "stale-jwt" });

    const jobStore = createStore(`boot-recovery-pop-transient-${tc.key}`);
    const liveJob = createJob({
      id: loopId,
      loopId,
      pid: process.pid,
      status: "RUNNING",
      claudeWorkDir,
      jsonlPath,
      lastObservedJsonlOffset: 0,
    });
    jobStore.upsert(liveJob);

    installPopRevivalFetchMock(tc.heartbeatHandler);

    const { schedulers, teardownCalls } = createSchedulersWithTeardownSpy();

    const service = new BootRecoveryService({
      jobStore,
      telemetry: { emit: (event) => telemetryEvents.push(event) },
      getApiKey: () => "managed-api-key",
      getApiOrigin: () => "http://127.0.0.1:4053",
      loopTokenStore,
      schedulers,
      getApiKeyProvenance: () => "DESKTOP_MANAGED",
      ...testPopDeps,
    });
    await service.reattachLiveJobs();
    await sleep(100);

    const persisted = jobStore.getByLoopId(loopId);
    assert.ok(persisted, "expected job to exist in store");

    // Live loop must NOT be finalized on a transient PoP blip.
    assert.equal(
      persisted.cloudFinalizedAt,
      undefined,
      `expected cloudFinalizedAt NOT set on transient PoP heartbeat (${tc.key})`
    );
    assert.notEqual(
      persisted.status,
      "UNKNOWN",
      `expected status NOT UNKNOWN on transient PoP heartbeat (${tc.key})`
    );

    // Token retained — a future heartbeat cycle can retry the revival.
    assert.ok(
      loopTokenStore.getLoopToken(loopId),
      `expected loop token retained on transient PoP heartbeat (${tc.key})`
    );

    // PoP heartbeat WAS attempted (the fetch is recorded even when the
    // network-case handler throws inside the mock).
    assert.ok(
      fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/heartbeat`)),
      `expected PoP heartbeat to have been attempted (${tc.key})`
    );

    // Conservative reattach: schedulers NOT torn down, loop registered active.
    assert.ok(
      !teardownCalls.includes(loopId),
      `expected schedulers.teardownLoop NOT called on transient PoP heartbeat (${tc.key})`
    );
    assert.notEqual(
      getActiveLoopPid(loopId),
      null,
      `expected loop reattached (registered active) on transient PoP heartbeat (${tc.key})`
    );

    service[Symbol.dispose]();
  });
}

test("T-3.5 PR#256: dead-PID DESKTOP_MANAGED loop never attempts PoP revival and finalizes terminal", async () => {
  const loopId = "loop-pop-dead-no-revival";
  const repoDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(repoDir, "workdir-pop-dead");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ ok: true })
  );

  const loopTokenStore = createLoopTokenStore("boot-recovery-pop-dead-tokens");
  loopTokenStore.setLoopToken(loopId, { token: "stale-jwt" });

  const jobStore = createStore("boot-recovery-pop-dead");
  const deadJob = createJob({
    id: loopId,
    loopId,
    status: "RUNNING",
    pid: 9_999_999, // dead PID → routed through finalizeDeadJobs
    claudeWorkDir,
  });
  jobStore.upsert(deadJob);

  // Heartbeat handler throws if hit — it must never be called for a dead job
  // because PoP revival is suppressed on the dead-finalization path (PR#256).
  installPopRevivalFetchMock(() => {
    throw new Error("PoP heartbeat must NOT be attempted for a dead-PID loop");
  });

  const service = new BootRecoveryService({
    jobStore,
    telemetry: { emit: (event) => telemetryEvents.push(event) },
    getApiKey: () => "managed-api-key",
    getApiOrigin: () => "http://127.0.0.1:4054",
    loopTokenStore,
    // DESKTOP_MANAGED + PoP deps present: revival WOULD fire if the dead path
    // built provenance context — it must not.
    getApiKeyProvenance: () => "DESKTOP_MANAGED",
    ...testPopDeps,
  });
  await service.run([deadJob]);
  service[Symbol.dispose]();

  // PRIMARY INVARIANT (Comment 1): the heartbeat endpoint is NEVER called for a
  // dead-PID loop — PoP revival is suppressed on the finalizeDeadJobs path, so
  // the resurrect-then-finalize race cannot occur.
  assert.ok(
    !fetchCalls.some((c) => c.url.includes(`/loops/${loopId}/heartbeat`)),
    "expected NO PoP heartbeat for a dead-PID loop"
  );

  // Supporting evidence the dead job took the terminal path (classified
  // unauthorized → terminal without revival), not the revived-active path:
  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted, "expected job to exist in store");
  // finalizeDeadJobs ran its finalization attempt (recoveryAttempts incremented)
  // rather than treating the loop as revived/active.
  assert.equal(
    persisted.recoveryAttempts,
    1,
    "expected dead-job finalization to have run (recoveryAttempts incremented)"
  );
  // Terminal classification cleared the loop token (finalizeAsTerminal).
  assert.equal(
    loopTokenStore.getLoopToken(loopId),
    null,
    "expected loop token cleared after terminal dead-job classification"
  );
  // The dead loop is never registered as active — no live runner was adopted.
  assert.equal(
    getActiveLoopPid(loopId),
    null,
    "expected dead-PID loop NOT registered as active"
  );
});
