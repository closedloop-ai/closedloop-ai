import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import type { TelemetryEventPayload } from "../src/main/telemetry-protocol.js";
import {
  clearActiveAgents,
  getActiveAgents,
  isNativeLoop,
} from "../src/server/operations/observability/active-agents-registry.js";
import { createNativeLoopObservabilitySession } from "../src/server/operations/observability/native-loop-observability.js";

const tempPathsToClean: string[] = [];
const loopsToClean: string[] = [];

afterEach(async () => {
  for (const loopId of loopsToClean.splice(0)) {
    clearActiveAgents(loopId);
  }
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

function makeClock(stepMs = 1000): () => string {
  let t = Date.parse("2026-06-10T00:00:00.000Z");
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

function collectEmitter(events: TelemetryEventPayload[]): {
  emit(event: TelemetryEventPayload): void;
} {
  return { emit: (event) => events.push(event) };
}

/** Emitter whose every emit throws — models a telemetry transport failure. */
function throwingEmitter(): { emit(event: TelemetryEventPayload): void } {
  return {
    emit() {
      throw new Error("telemetry transport down");
    },
  };
}

/**
 * Returns a path that is a regular file, so `path.join(workDir, "perf.jsonl")`
 * makes `appendFileSync` throw `ENOTDIR` — models the un-watched sink failing.
 */
async function makeWorkDirThatIsAFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-obs-sink-"));
  tempPathsToClean.push(dir);
  const filePath = path.join(dir, "not-a-directory");
  await fs.writeFile(filePath, "");
  return filePath;
}

async function makeWorkDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-obs-"));
  tempPathsToClean.push(dir);
  return dir;
}

const CLAUDE_RECORDS: Record<string, unknown>[] = [
  { type: "system", subtype: "init", session_id: "sess_1" },
  {
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
    },
  },
  {
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          is_error: false,
          content: "ok",
        },
      ],
    },
  },
  {
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_task",
          name: "Task",
          input: { subagent_type: "code-reviewer", description: "Review" },
        },
      ],
    },
  },
];

test("native Claude loop emits run/tool/spawn/agent + iteration and feeds the active-agents registry (AC-001/004/005)", async () => {
  const claudeWorkDir = await makeWorkDir();
  const events: TelemetryEventPayload[] = [];
  const loopId = "loop_claude_1";
  loopsToClean.push(loopId);

  const session = createNativeLoopObservabilitySession({
    loopId,
    command: "EXECUTE",
    harness: LoopHarness.Claude,
    repo: "closedloop-ai/symphony-alpha",
    branch: "symphony/pln-853",
    claudeWorkDir,
    traceContext: { loopId, jobId: loopId },
    telemetryEmitter: collectEmitter(events),
    now: makeClock(),
  });

  assert.equal(isNativeLoop(loopId), true);
  session.start();

  for (const record of CLAUDE_RECORDS) {
    session.onRecord(record);
  }

  // Subagent is open after its Task tool_use, before the tool_result.
  const running = getActiveAgents(loopId);
  assert.equal(running.length, 1);
  assert.equal(running[0]?.agentType, "code-reviewer");
  assert.equal(running[0]?.agentName, "Review");

  // Close the subagent.
  session.onRecord({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_task",
          is_error: false,
          content: "done",
        },
      ],
    },
  });
  assert.equal(getActiveAgents(loopId).length, 0);

  session.finish({ exitCode: 0, status: "completed" });

  const categories = events.map((e) => e.category);
  assert.ok(categories.includes("loop.perf.run"), "run emitted");
  assert.ok(categories.includes("loop.perf.tool"), "tool emitted");
  assert.ok(categories.includes("loop.perf.spawn"), "spawn emitted");
  assert.ok(categories.includes("loop.perf.agent"), "agent emitted");
  assert.ok(categories.includes("loop.perf.iteration"), "iteration emitted");

  // No retired signals are synthesized for native loops (AC-006).
  assert.ok(!categories.includes("loop.perf.phase"));
  assert.ok(!categories.includes("loop.perf.pipeline_step"));
  assert.ok(!categories.includes("loop.perf.skill"));

  // perf.jsonl sink mirrors the emitted raw events (un-watched; D-006).
  const perfJsonl = readFileSync(
    path.join(claudeWorkDir, "perf.jsonl"),
    "utf-8"
  );
  const lines = perfJsonl
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const perfEvents = lines.map((l) => l.event);
  assert.ok(perfEvents.includes("run"));
  assert.ok(perfEvents.includes("iteration"));
  // Every native-emitted record carries the harness discriminator (D-007).
  assert.ok(lines.every((l) => l.harness === LoopHarness.Claude));

  // Registry cleared on finish regardless of outcome.
  assert.equal(isNativeLoop(loopId), false);
});

test("native Codex loop produces tools + token delta and an empty active-agents feed (AC-002/005)", async () => {
  const claudeWorkDir = await makeWorkDir();
  const events: TelemetryEventPayload[] = [];
  const loopId = "loop_codex_1";
  loopsToClean.push(loopId);

  const session = createNativeLoopObservabilitySession({
    loopId,
    command: "EXECUTE",
    harness: LoopHarness.Codex,
    claudeWorkDir,
    traceContext: { loopId, jobId: loopId },
    telemetryEmitter: collectEmitter(events),
    now: makeClock(),
  });
  session.start();

  session.onRecord({
    type: "item.started",
    item: { id: "item_0", type: "command_execution", command: "pnpm test" },
  });
  session.onRecord({
    type: "item.completed",
    item: { id: "item_0", type: "command_execution", exit_code: 0 },
  });
  const tokenDelta = session.onRecord({
    type: "turn.completed",
    usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 250 },
  });

  assert.deepEqual(tokenDelta, {
    inputTokens: 1000,
    outputTokens: 250,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 400,
  });

  session.finish({ exitCode: 0, status: "completed" });

  const categories = events.map((e) => e.category);
  assert.ok(categories.includes("loop.perf.run"));
  assert.ok(categories.includes("loop.perf.tool"));
  assert.ok(categories.includes("loop.perf.iteration"));
  // Codex never produces spawn/agent (AC-002).
  assert.ok(!categories.includes("loop.perf.spawn"));
  assert.ok(!categories.includes("loop.perf.agent"));
  // Active-agents feed is empty (not errored) for Codex (AC-005).
  assert.equal(getActiveAgents(loopId).length, 0);
});

/**
 * AC-008: a telemetry failure must never throw out of the session or stall the
 * loop. The two distinct failure surfaces — the telemetry transport emit and
 * the un-watched perf.jsonl sink — are exercised independently. In both cases
 * ingest must still run (the active-agents registry is populated and cleared),
 * proving the fault is isolated to the side effects, not the stream processing.
 */
const FAULT_SCENARIOS: {
  id: string;
  name: string;
  build(): Promise<{
    telemetryEmitter: { emit(event: TelemetryEventPayload): void };
    claudeWorkDir: string;
  }>;
}[] = [
  {
    id: "loop_fault_emit",
    name: "telemetry transport emit throws",
    async build() {
      return {
        telemetryEmitter: throwingEmitter(),
        claudeWorkDir: await makeWorkDir(),
      };
    },
  },
  {
    id: "loop_fault_sink",
    name: "perf.jsonl append throws (ENOTDIR)",
    async build() {
      return {
        telemetryEmitter: collectEmitter([]),
        claudeWorkDir: await makeWorkDirThatIsAFile(),
      };
    },
  },
];

for (const scenario of FAULT_SCENARIOS) {
  test(`native Claude loop survives when ${scenario.name} (AC-008)`, async () => {
    const { telemetryEmitter, claudeWorkDir } = await scenario.build();
    const loopId = scenario.id;
    loopsToClean.push(loopId);

    const session = createNativeLoopObservabilitySession({
      loopId,
      command: "EXECUTE",
      harness: LoopHarness.Claude,
      claudeWorkDir,
      traceContext: { loopId, jobId: loopId },
      telemetryEmitter,
      now: makeClock(),
    });

    // None of the lifecycle entry points may propagate the fault.
    assert.doesNotThrow(() => session.start());
    for (const record of CLAUDE_RECORDS) {
      assert.doesNotThrow(() => session.onRecord(record));
    }

    // Stream processing still ran despite the side-effect failure: the open
    // subagent from the Task tool_use was recorded (fault isolated to emit/sink).
    assert.equal(getActiveAgents(loopId).length, 1);

    assert.doesNotThrow(() =>
      session.finish({ exitCode: 0, status: "completed" })
    );

    // Registry is always released so a faulting loop cannot leak state.
    assert.equal(isNativeLoop(loopId), false);
    assert.equal(getActiveAgents(loopId).length, 0);
  });
}
