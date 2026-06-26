import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { JobStore, type LocalJob } from "../src/main/job-store.js";
import { LoopTokenStore } from "../src/main/loop-token-store.js";
import type { NativeLoopObservabilitySession } from "../src/server/operations/observability/native-loop-observability.js";
import { handleProcessCompletion } from "../src/server/operations/symphony-loop.js";
import { createTestLoopTokenSafeStorage } from "./loop-token-test-utils.js";

let tempRoot = "";
let fetchCalls: Array<{ url: string; body: string }> = [];
let eventPostStatus = 200;
const originalFetch = globalThis.fetch;
const USER_VISIBLE_FAILURE_SECRET = "test-loop-failure-secret";

type FailureMarkerPayload = {
  code: string;
  message: string;
  result: { subcode: string };
  [key: string]: unknown;
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "symphony-handle-process-completion-")
  );
  fetchCalls = [];
  eventPostStatus = 200;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });

    if (url.includes("upload-artifacts")) {
      return new Response("nope", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }

    if (url.includes("/events") && eventPostStatus !== 200) {
      return new Response("nope", {
        status: eventPostStatus,
        statusText: "Internal Server Error",
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
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

function createBaseJob(
  loopId: string,
  claudeWorkDir: string,
  overrides?: Partial<LocalJob>
): LocalJob {
  return {
    id: loopId,
    kind: "SYMPHONY_LOOP",
    loopId,
    command: LoopCommand.Execute,
    localRepoPath: path.join(tempRoot, "repo"),
    claudeWorkDir,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function getPostedErrorEvent(): Record<string, unknown> {
  const errorEvent = fetchCalls.find(({ url }) => url.includes("/events"));
  assert.ok(
    errorEvent,
    "Expected handleProcessCompletion to post an error event"
  );
  return JSON.parse(errorEvent.body) as Record<string, unknown>;
}

function signFailureMarker<T extends FailureMarkerPayload>(
  payload: T
): T & { signature: string } {
  const canonicalPayload = JSON.stringify({
    code: payload.code,
    message: payload.message,
    result: { subcode: payload.result.subcode },
  });
  const signature = crypto
    .createHmac("sha256", USER_VISIBLE_FAILURE_SECRET)
    .update(canonicalPayload)
    .digest("hex");
  return { ...payload, signature: `sha256=${signature}` };
}

async function writeSignedFailureMarker(
  claudeWorkDir: string,
  payload: FailureMarkerPayload
): Promise<void> {
  await fs.writeFile(
    path.join(claudeWorkDir, "loop-error.json"),
    JSON.stringify(signFailureMarker(payload))
  );
}

async function completeFailedLoopWithMarkerSecret(args: {
  loopId: string;
  claudeWorkDir: string;
  jobStore: JobStore;
  loopTokenStore?: LoopTokenStore;
  spawnStartedAt?: number;
}): Promise<void> {
  await handleProcessCompletion(
    1,
    {
      loopId: args.loopId,
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token",
    } as Parameters<typeof handleProcessCompletion>[1],
    "http://127.0.0.1:12345",
    null,
    args.claudeWorkDir,
    false,
    null,
    () => [tempRoot],
    undefined,
    args.jobStore,
    undefined,
    undefined,
    undefined,
    undefined,
    args.loopTokenStore,
    [],
    undefined,
    args.spawnStartedAt,
    undefined,
    0,
    USER_VISIBLE_FAILURE_SECRET
  );
}

test("handleProcessCompletion uploads support bundle for failed loops without JobStore state", async () => {
  const loopId = "loop-support-upload-no-jobstore";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(path.join(claudeWorkDir, "claude-output.jsonl"), "{}\n");
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.includes("upload-artifacts")) {
      return new Response("nope", {
        status: 500,
        statusText: "Internal Server Error",
      });
    }
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

  await handleProcessCompletion(
    1,
    {
      loopId,
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token",
      s3StateKey: "org-1/loops/loop-1/run-1",
    } as Parameters<typeof handleProcessCompletion>[1],
    "http://127.0.0.1:12345",
    null,
    claudeWorkDir,
    false,
    null,
    () => [tempRoot]
  );

  const eventBodies = fetchCalls
    .filter((call) => call.url.includes("/events"))
    .map((call) => JSON.parse(call.body) as { type?: string });
  assert.deepEqual(
    eventBodies.map((body) => body.type),
    ["support_bundle_uploaded", "error"]
  );
});

test("handleProcessCompletion merges existing warnings with failure upload warnings", async () => {
  const loopId = "loop-merge-failure-warning";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    JSON.stringify({ content: "Plan content", tasks: [] })
  );

  const jobStore = createStore("symphony-handle-process-completion");
  jobStore.upsert(
    createBaseJob(loopId, claudeWorkDir, {
      warning: "PRE_EXISTING_WARNING",
    })
  );

  await handleProcessCompletion(
    1,
    {
      loopId,
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token",
    } as Parameters<typeof handleProcessCompletion>[1],
    "http://127.0.0.1:12345",
    null,
    claudeWorkDir,
    false,
    null,
    () => [tempRoot],
    undefined,
    jobStore
  );

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");
  assert.deepEqual(persisted.warning?.split("; ").sort(), [
    "ARTIFACT_UPLOAD_FAILED",
    "PRE_EXISTING_WARNING",
  ]);

  const eventBody = getPostedErrorEvent() as { warnings?: string[] };
  assert.deepEqual(eventBody.warnings, ["ARTIFACT_UPLOAD_FAILED"]);
});

test("handleProcessCompletion surfaces valid user-visible runner failure marker", async () => {
  const loopId = "loop-user-visible-runner-failure";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeSignedFailureMarker(claudeWorkDir, {
    code: "RUNNER_ERROR",
    message: "Loop execution failed because XYZ.",
    result: { subcode: "XYZ_FAILURE" },
    schemaVersion: 1,
  });

  const jobStore = createStore("symphony-user-visible-runner-failure");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.status, "FAILED");

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "RUNNER_ERROR");
  assert.equal(eventBody.message, "Loop execution failed because XYZ.");
  assert.deepEqual(eventBody.result, { subcode: "XYZ_FAILURE" });
  assert.equal(eventBody.logTail, undefined);
});

test("handleProcessCompletion ignores unsigned user-visible runner failure marker", async () => {
  const loopId = "loop-unsigned-runner-failure";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "loop-error.json"),
    JSON.stringify({
      code: "RUNNER_ERROR",
      message: "Do not surface this forged marker.",
      result: { subcode: "XYZ_FAILURE" },
    })
  );

  const jobStore = createStore("symphony-unsigned-runner-failure");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "PROCESS_FAILED");
  assert.equal(eventBody.message, "Process exited with code 1");
  assert.equal(eventBody.result, undefined);
});

test("handleProcessCompletion ignores invalid user-visible runner failure marker", async () => {
  const loopId = "loop-invalid-runner-failure";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "loop-error.json"),
    JSON.stringify(
      signFailureMarker({
        code: "UNSUPPORTED_CODE",
        message: "Do not surface this.",
        result: { subcode: "XYZ_FAILURE" },
      })
    )
  );

  const jobStore = createStore("symphony-invalid-runner-failure");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "PROCESS_FAILED");
  assert.equal(eventBody.message, "Process exited with code 1");
  assert.equal(eventBody.result, undefined);
});

test("handleProcessCompletion ignores stale user-visible runner failure marker", async () => {
  const loopId = "loop-stale-runner-failure";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  const markerPath = path.join(claudeWorkDir, "loop-error.json");
  await fs.writeFile(
    markerPath,
    JSON.stringify(
      signFailureMarker({
        code: "RUNNER_ERROR",
        message: "Do not surface this stale marker.",
        result: { subcode: "XYZ_FAILURE" },
      })
    )
  );

  const jobStore = createStore("symphony-stale-runner-failure");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
    spawnStartedAt: Date.now() + 60_000,
  });

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "PROCESS_FAILED");
  assert.equal(eventBody.message, "Process exited with code 1");
  assert.equal(eventBody.result, undefined);
});

test("handleProcessCompletion preserves sanitized runner failure message in local job activity", async () => {
  const loopId = "loop-user-visible-live-activity";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeSignedFailureMarker(claudeWorkDir, {
    code: "PRE_RUN_VALIDATION_FAILED",
    message: "\u001b[31mPlan state is not loadable.\u001b[0m",
    result: { subcode: "BAD_PLAN_STATE" },
  });

  const jobStore = createStore("symphony-user-visible-live-activity");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.liveActivity, "Plan state is not loadable.");

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "PRE_RUN_VALIDATION_FAILED");
  assert.equal(eventBody.message, "Plan state is not loadable.");
  assert.deepEqual(eventBody.result, { subcode: "BAD_PLAN_STATE" });
});

test("handleProcessCompletion keeps runner failure marker precedence over context-limit fallback", async () => {
  const loopId = "loop-runner-marker-precedence";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeSignedFailureMarker(claudeWorkDir, {
    code: "RUNNER_ERROR",
    message: "Claude context limit reached through the runner marker.",
    result: { subcode: "XYZ_FAILURE" },
  });
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "result",
      is_error: true,
      result: "Prompt is too long for this model.",
    })}\n`
  );

  const jobStore = createStore("symphony-runner-marker-precedence");
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.completedEventPostedAt !== undefined, true);
  assert.deepEqual(persisted.userVisibleLoopFailure, {
    code: "RUNNER_ERROR",
    message: "Claude context limit reached through the runner marker.",
    result: { subcode: "XYZ_FAILURE" },
  });

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "RUNNER_ERROR");
  assert.equal(
    eventBody.message,
    "Claude context limit reached through the runner marker."
  );
  assert.deepEqual(eventBody.result, { subcode: "XYZ_FAILURE" });
});

test("handleProcessCompletion persists runner failure marker before failed error event post", async () => {
  const loopId = "loop-runner-marker-event-failure";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeSignedFailureMarker(claudeWorkDir, {
    code: "RUNNER_ERROR",
    message: "Claude rate limit reached.",
    result: { subcode: "CLAUDE_RATE_LIMIT" },
  });
  eventPostStatus = 500;

  const jobStore = createStore("symphony-runner-marker-event-failure");
  const loopTokenStore = createLoopTokenStore(
    "symphony-runner-marker-event-failure-tokens"
  );
  loopTokenStore.setLoopToken(loopId, { token: "loop-token" });
  jobStore.upsert(createBaseJob(loopId, claudeWorkDir));

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
    loopTokenStore,
  });

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.completedEventPostedAt, undefined);
  assert.ok(persisted.finalStatusPersistedAt);
  assert.equal(persisted.cloudFinalizedAt, undefined);
  assert.equal(persisted.lastRecoveryError, "HTTP 500 Internal Server Error");
  assert.deepEqual(persisted.warning?.split("; ").sort(), [
    "ARTIFACT_UPLOAD_FAILED",
    "EVENT_POST_FAILED",
  ]);
  assert.deepEqual(loopTokenStore.getLoopToken(loopId), {
    token: "loop-token",
  });
  assert.deepEqual(persisted.userVisibleLoopFailure, {
    code: "RUNNER_ERROR",
    message: "Claude rate limit reached.",
    result: { subcode: "CLAUDE_RATE_LIMIT" },
  });

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "RUNNER_ERROR");
  assert.equal(eventBody.message, "Claude rate limit reached.");
  assert.deepEqual(eventBody.result, { subcode: "CLAUDE_RATE_LIMIT" });
});

test("handleProcessCompletion keeps cancellation precedence over runner failure marker", async () => {
  const loopId = "loop-cancel-precedence";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await writeSignedFailureMarker(claudeWorkDir, {
    code: "RUNNER_ERROR",
    message: "Do not surface this.",
    result: { subcode: "XYZ_FAILURE" },
  });

  const jobStore = createStore("symphony-cancel-precedence");
  jobStore.upsert(
    createBaseJob(loopId, claudeWorkDir, {
      status: "CANCEL_PENDING",
    })
  );

  await completeFailedLoopWithMarkerSecret({
    loopId,
    claudeWorkDir,
    jobStore,
  });

  const persisted = jobStore.getByLoopId(loopId);
  assert.ok(persisted);
  assert.equal(persisted.status, "CANCELLED");

  const eventBody = getPostedErrorEvent();
  assert.equal(eventBody.code, "CANCELLED");
  assert.equal(eventBody.message, "Loop cancelled");
  assert.equal(eventBody.result, undefined);
});

test("handleProcessCompletion finalizes native observability as cancelled for CANCEL_PENDING jobs", async () => {
  const loopId = "loop-native-cancel-status";
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const jobStore = createStore("symphony-native-cancel-status");
  jobStore.upsert(
    createBaseJob(loopId, claudeWorkDir, {
      status: "CANCEL_PENDING",
    })
  );

  const nativeFinishes: Array<{ exitCode?: number; status: string }> = [];
  const nativeObservability = {
    finish: (outcome: { exitCode?: number; status: string }) => {
      nativeFinishes.push(outcome);
    },
  } as NativeLoopObservabilitySession;

  await handleProcessCompletion(
    1,
    {
      loopId,
      command: LoopCommand.Execute,
      closedLoopAuthToken: "token",
    } as Parameters<typeof handleProcessCompletion>[1],
    "http://127.0.0.1:12345",
    null,
    claudeWorkDir,
    false,
    null,
    () => [tempRoot],
    undefined,
    jobStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    0,
    undefined,
    0,
    undefined,
    undefined,
    nativeObservability
  );

  assert.deepEqual(nativeFinishes, [{ exitCode: 1, status: "cancelled" }]);
});
