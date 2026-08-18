/**
 * ISS-5872 — "completed" must mean "produced".
 *
 * A loop that exits 0 without writing the artifact it exists to produce used
 * to finalize as COMPLETED with `error: null`. The harness DETECTED the gap —
 * it computed the missing-artifact list, logged it as a warning, and discarded
 * it — so terminality was decided purely from the absence of an exception.
 * Observed live on loop 019fee5a (PLAN against PLN-1688), which took the
 * JobStore path these tests drive.
 *
 * The legacy no-JobStore path is covered from the gateway in
 * `symphony-loop-shared-contract.test.ts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import { JobStore, type LocalJob } from "../src/main/jobs/job-store.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { finalizeLoopFromRuntime } from "../src/main/loop/loop-finalizer.js";

let tempRoot = "";
let fetchCalls: Array<{ url: string; body: string }> = [];
/** Per-test hook: return an HTTP status for a URL, or undefined for the 200 default. */
let fetchStatusFor: (url: string) => number | undefined = () => undefined;
/** Per-test hook: observed as each request is issued, before it resolves. */
let onFetch: (url: string) => void = () => {
  // no-op unless a test is watching the ordering of cloud calls
};
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "missing-artifacts-test-")
  );
  fetchCalls = [];
  fetchStatusFor = () => undefined;
  onFetch = () => {
    // reset to the no-op default for tests that do not watch ordering
  };
  gatewayLog.clear();
  globalThis.fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
    });
    onFetch(url);
    const status = fetchStatusFor(url) ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify({ success: status < 400 }), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  gatewayLog.clear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function createStore(name: string): JobStore {
  return new JobStore({ cwd: tempRoot, name });
}

function createBaseJob(overrides?: Partial<LocalJob>): LocalJob {
  return {
    id: "loop-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-1",
    command: LoopCommand.Plan,
    localRepoPath: path.join(tempRoot, "repo"),
    claudeWorkDir: path.join(tempRoot, "repo", "workdir"),
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const PROCESS_FAILED_CODE = /"code":"PROCESS_FAILED"/;
const OPEN_QUESTIONS_BODY = /what should the plan cover\?/;

const finalizerDeps = (jobStore: JobStore) => ({
  jobStore,
  telemetry: { emit: () => {} },
  getToken: () => "token",
  apiBaseUrl: "http://127.0.0.1:12345",
  isProcessRunning: () => false,
});

test("finalizeLoopFromRuntime fails a PLAN that produced no plan.json instead of completing it", async () => {
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  // The run did real work — investigation artifacts exist — and stopped before
  // writing the plan. This is exactly the shape of loop 019fee5a.
  await fs.writeFile(
    path.join(claudeWorkDir, "open-questions.md"),
    "what should the plan cover?"
  );
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [],
        usage: { input_tokens: 900, output_tokens: 400 },
      },
    })}\n`
  );

  const jobStore = createStore("finalizer-missing-plan");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(
    persisted.status,
    "FAILED",
    "a PLAN with no plan.json must not persist as COMPLETED"
  );
  assert.deepEqual(persisted.missingRequiredArtifacts, ["plan.json"]);

  const terminalBodies = fetchCalls
    .filter((call) => call.url.includes("/events"))
    .map((call) => call.body);
  assert.equal(terminalBodies.length, 1, "expected exactly one terminal event");
  const terminal = JSON.parse(terminalBodies[0] ?? "{}") as {
    type?: string;
    code?: string;
    message?: string;
  };
  assert.equal(terminal.type, "error");
  assert.equal(terminal.code, LoopErrorCode.MissingRequiredArtifacts);
  assert.ok(
    terminal.message?.includes("plan.json"),
    `error message must name the missing artifact, got: ${terminal.message ?? "<none>"}`
  );
  // AC2: the error is never null on a non-success terminal state.
  assert.ok(
    terminal.message !== undefined && terminal.message.length > 0,
    "a non-success terminal state must carry a non-empty error message"
  );
});

test("finalizeLoopFromRuntime completes an EXECUTE with no execution-result.json (no-changes runs are legitimate)", async () => {
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  // Non-zero token usage keeps the separate 0-token ghost-loop guard out of the
  // way, so this test isolates the missing-artifact decision.
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: { content: [], usage: { input_tokens: 100, output_tokens: 50 } },
    })}\n`
  );

  const jobStore = createStore("finalizer-execute-no-changes");
  const job = createBaseJob({
    claudeWorkDir,
    status: "COMPLETED",
    command: LoopCommand.Execute,
    executeFinalizationStatus: "no-changes",
  });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.ok(persisted);
  assert.equal(
    persisted.status,
    "COMPLETED",
    "EXECUTE writes execution-result.json only after a successful commit AND push, so a no-changes run must still complete"
  );
  assert.equal(persisted.missingRequiredArtifacts, undefined);
});

test("finalizeLoopFromRuntime keeps PROCESS_FAILED for a PLAN that failed with an exit code", async () => {
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const jobStore = createStore("finalizer-failed-precedence");
  // No plan.json either, but this job failed for its own reason: the missing
  // bundle must not relabel a real process failure.
  const job = createBaseJob({
    claudeWorkDir,
    status: "FAILED",
    exitCode: 1,
  });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.missingRequiredArtifacts, undefined);
  const errorBody =
    fetchCalls.find((call) => call.url.includes("/events"))?.body ?? "";
  assert.match(errorBody, PROCESS_FAILED_CODE);
});

test("finalizeLoopFromRuntime does not re-adjudicate a run whose terminal status was already persisted", async () => {
  // Live-exit deletes the temp workdir and removes the worktree right after
  // finalization, so a retry pass sees no evidence at all. Re-deciding then
  // would flip a genuine success to FAILED and tell the cloud an artifact it
  // already holds was never produced.
  const claudeWorkDir = path.join(tempRoot, "repo", "gone-workdir");

  const jobStore = createStore("finalizer-already-persisted");
  const job = createBaseJob({
    claudeWorkDir,
    status: "COMPLETED",
    command: LoopCommand.Decompose,
    finalStatusPersistedAt: new Date().toISOString(),
  });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "boot-recovery", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "COMPLETED");
  assert.equal(persisted?.missingRequiredArtifacts, undefined);
  const events = fetchCalls.filter((call) => call.url.includes("/events"));
  assert.ok(
    events.every((call) => !call.body.includes("MISSING_REQUIRED_ARTIFACTS")),
    "a cleaned-up workdir must not be reported as an unproduced artifact"
  );
});

test("finalizeLoopFromRuntime treats a zero-byte required artifact as unproduced", async () => {
  // The live incident left PLN-1688 "at version 1 with 0 bytes" — an empty file
  // satisfies a bare existence check and hands back a done-and-empty artifact.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(path.join(claudeWorkDir, "plan.json"), "");

  const jobStore = createStore("finalizer-empty-plan");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  assert.equal(jobStore.getByLoopId("loop-1")?.status, "FAILED");
});

test("finalizeLoopFromRuntime uploads partial artifacts before failing for a missing deliverable", async () => {
  // The run's investigation output is the operator's only clue about how far it
  // got, so the downgrade must not discard it.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "open-questions.md"),
    "what should the plan cover?"
  );

  const jobStore = createStore("finalizer-partial-upload");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const upload = fetchCalls.find((call) =>
    call.url.includes("/upload-artifacts")
  );
  assert.ok(upload, "partial artifacts must still be uploaded");
  assert.match(upload.body, OPEN_QUESTIONS_BODY);
  assert.equal(jobStore.getByLoopId("loop-1")?.status, "FAILED");
});

test("finalizeLoopFromRuntime does not accept a same-named file from the repo checkout as the run's output", async () => {
  // A PLAN uploads plan.json from the claude work directory and nowhere else,
  // so a stale root plan.json left in the checkout by an earlier run proves
  // nothing about this run. Accepting it would upload no plan and still
  // complete — the exact false success this guard exists to remove.
  const worktreeDir = path.join(tempRoot, "repo");
  const claudeWorkDir = path.join(worktreeDir, "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(worktreeDir, "plan.json"),
    JSON.stringify({ tasks: ["left over from an earlier run"] })
  );

  const jobStore = createStore("finalizer-stale-checkout-plan");
  const job = createBaseJob({
    claudeWorkDir,
    worktreeDir,
    status: "COMPLETED",
  });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(
    persisted?.status,
    "FAILED",
    "a plan.json outside the command's output directory must not count as produced"
  );
  assert.deepEqual(persisted?.missingRequiredArtifacts, ["plan.json"]);
  const upload = fetchCalls.find((call) =>
    call.url.includes("/upload-artifacts")
  );
  assert.ok(
    !upload?.body.includes("left over from an earlier run"),
    "the checkout's stale plan must never be uploaded as this run's output"
  );
});

test("finalizeLoopFromRuntime completes a GENERATE_PRD whose prd.md lands in the worktree", async () => {
  // The PRD commands are the ones that genuinely write into the checkout, so
  // narrowing the search to a single directory must follow that per-command
  // choice rather than always looking in the claude work directory.
  const worktreeDir = path.join(tempRoot, "prd-repo");
  const claudeWorkDir = path.join(tempRoot, "prd-workdir");
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(path.join(worktreeDir, "prd.md"), "# The PRD");

  const jobStore = createStore("finalizer-prd-worktree");
  const job = createBaseJob({
    claudeWorkDir,
    worktreeDir,
    status: "COMPLETED",
    command: LoopCommand.GeneratePrd,
  });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "COMPLETED");
  assert.equal(persisted?.missingRequiredArtifacts, undefined);
});

test("finalizeLoopFromRuntime enforces the sibling commands, not just PLAN", async () => {
  // The guard reads the shared ResultBundle manifest rather than branching per
  // command, so this proves the enforcement generalizes past PLAN's shape.
  // Limited to the commands `LocalJobCommand` can represent — EVALUATE_* and
  // REQUEST_PRD_CHANGES never reach the JobStore path, and are covered through
  // the gateway in symphony-loop-shared-contract.test.ts instead.
  const cases = [
    { command: LoopCommand.Decompose, file: "features.json" },
    { command: LoopCommand.GeneratePrd, file: "prd.md" },
    { command: LoopCommand.RequestChanges, file: "plan.json" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const claudeWorkDir = path.join(tempRoot, `repo-${index}`, "workdir");
    await fs.mkdir(claudeWorkDir, { recursive: true });
    const jobStore = createStore(`finalizer-sibling-${index}`);
    const job = createBaseJob({
      claudeWorkDir,
      status: "COMPLETED",
      command: testCase.command,
    });
    jobStore.upsert(job);
    fetchCalls = [];

    await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

    assert.equal(
      jobStore.getByLoopId("loop-1")?.status,
      "FAILED",
      `${testCase.command} must not complete without ${testCase.file}`
    );
    const errorBody =
      fetchCalls.find((call) => call.url.includes("/events"))?.body ?? "";
    assert.ok(
      errorBody.includes(testCase.file),
      `${testCase.command} error must name ${testCase.file}, got: ${errorBody}`
    );
  }
});

test("finalizeLoopFromRuntime treats a truncated required JSON artifact as unproduced", async () => {
  // Non-empty is not enough: every reader of a *.json bundle file parses it
  // through a JSON.parse that swallows its error and yields nothing, so a
  // truncated plan.json uploads no plan at all and would otherwise complete.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "plan.json"),
    '{"content":"half a pl'
  );

  const jobStore = createStore("finalizer-truncated-plan");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "FAILED");
  assert.deepEqual(persisted?.missingRequiredArtifacts, ["plan.json"]);
});

test("finalizeLoopFromRuntime persists the downgrade before it makes any cloud call", async () => {
  // Live-exit normally persists its final status last. If a crash landed
  // between cloudFinalizedAt being stored and that persist, the job would stay
  // locally RUNNING with a cloud marker: boot reconciliation promotes a dead
  // RUNNING job to COMPLETED and recovery then skips it, so the desktop would
  // show COMPLETED for a run the cloud was told had FAILED.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const jobStore = createStore("finalizer-persist-before-cloud");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  let statusAtFirstCloudCall: string | undefined;
  let persistedAtFirstCloudCall: string | undefined;
  onFetch = () => {
    if (statusAtFirstCloudCall) {
      return;
    }
    const snapshot = jobStore.getByLoopId("loop-1");
    statusAtFirstCloudCall = snapshot?.status;
    persistedAtFirstCloudCall = snapshot?.finalStatusPersistedAt;
  };

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  assert.ok(fetchCalls.length > 0, "the finalizer must have called the cloud");
  assert.equal(
    statusAtFirstCloudCall,
    "FAILED",
    "the downgrade must be on disk before the first cloud request is issued"
  );
  assert.ok(
    persistedAtFirstCloudCall,
    "finalStatusPersistedAt must be stamped before the cloud call, so recovery can find the job"
  );
});

test("finalizeLoopFromRuntime keeps a downgraded run retryable when its partial upload fails", async () => {
  // The error event succeeding is not enough to call the loop finalized: the
  // partials are the investigation output the operator was downgraded FOR, and
  // recovery skips any job carrying cloudFinalizedAt.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "open-questions.md"),
    "what should the plan cover?"
  );
  fetchStatusFor = (url) =>
    url.includes("/upload-artifacts") ? 503 : undefined;

  const jobStore = createStore("finalizer-partial-upload-retryable");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  const outcome = await finalizeLoopFromRuntime(
    job,
    "live-exit",
    finalizerDeps(jobStore)
  );

  assert.equal(
    outcome.cloudFinalized,
    false,
    "a lost partial upload must not mark the loop cloud-finalized"
  );
  assert.equal(outcome.retryableFailure, true);
  const persisted = jobStore.getByLoopId("loop-1");
  assert.equal(persisted?.status, "FAILED");
  assert.equal(
    persisted?.cloudFinalizedAt,
    undefined,
    "recovery selects on the absence of this marker, so it must stay unset"
  );
  assert.ok(
    persisted?.finalStatusPersistedAt,
    "recovery also requires finalStatusPersistedAt to pick the job up"
  );
  assert.ok(
    fetchCalls.some((call) => call.url.includes("/events")),
    "the terminal error event is still posted"
  );
});

test("finalizeLoopFromRuntime carries per-model token attribution on the downgrade event", async () => {
  // Reporting the totals without the per-model split makes the cloud price the
  // whole run against a synthetic default model, so an Opus run keeps the right
  // counts and gets the wrong cost.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeWorkDir, "claude-output.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-20250514",
        content: [],
        usage: { input_tokens: 900, output_tokens: 400 },
      },
    })}\n`
  );

  const jobStore = createStore("finalizer-tokens-by-model");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const terminal = JSON.parse(
    fetchCalls.find((call) => call.url.includes("/events"))?.body ?? "{}"
  ) as {
    code?: string;
    tokensByModel?: Record<string, { input?: number; output?: number }>;
  };
  assert.equal(terminal.code, LoopErrorCode.MissingRequiredArtifacts);
  assert.deepEqual(terminal.tokensByModel, {
    "claude-opus-4-20250514": {
      input: 900,
      output: 400,
      cacheCreation: 0,
      cacheRead: 0,
    },
  });
});

test("finalizeLoopFromRuntime omits tokensByModel entirely when the run reported no per-model usage", async () => {
  // The field is optional on a version-skewed wire contract, so absence must be
  // omission — never an empty object and never null.
  const claudeWorkDir = path.join(tempRoot, "repo", "workdir");
  await fs.mkdir(claudeWorkDir, { recursive: true });

  const jobStore = createStore("finalizer-no-tokens-by-model");
  const job = createBaseJob({ claudeWorkDir, status: "COMPLETED" });
  jobStore.upsert(job);

  await finalizeLoopFromRuntime(job, "live-exit", finalizerDeps(jobStore));

  const body =
    fetchCalls.find((call) => call.url.includes("/events"))?.body ?? "{}";
  assert.ok(
    !Object.hasOwn(JSON.parse(body) as object, "tokensByModel"),
    `an absent per-model split must be omitted, got: ${body}`
  );
});
