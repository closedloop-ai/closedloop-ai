/**
 * Unit tests for apps/desktop/src/main/loop-perf-telemetry.ts
 *
 * Covers:
 *   T-5.1  Zod schema validation — each of the 8 event types
 *   T-5.2  Streaming running-phase attribution
 *   T-5.3  Partial-line buffering across chunks
 *   T-5.4  Reconciliation catch-up read (no double emission)
 *   T-5.5  Mixed-version payload handling (legacy + v2 agent events)
 *   T-5.6  Malformed-line handling
 *   T-5.7  Orphaned-sentinel handling
 *   T-5.8  Watcher-failure resilience
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  createRunningPhaseState,
  parseAndEmitChunk,
  reconcileLoopPerfTelemetry,
  startLoopPerfTelemetryWatcher,
} from "../src/main/loop-perf-telemetry.js";
import type { TelemetryEventPayload } from "../src/main/telemetry-protocol.js";

// ---------------------------------------------------------------------------
// Shared temp-dir cleanup
// ---------------------------------------------------------------------------

const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const tempPath of tempPathsToClean.splice(0)) {
    await fs.rm(tempPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock TelemetryEmitter that collects all emitted events. */
function makeMockEmitter(): {
  emitter: { emit: (e: TelemetryEventPayload) => void };
  events: TelemetryEventPayload[];
} {
  const events: TelemetryEventPayload[] = [];
  return {
    emitter: { emit: (e) => events.push(e) },
    events,
  };
}

/** Build a Buffer from a JSONL string. */
function toChunk(jsonl: string): Buffer {
  return Buffer.from(jsonl, "utf-8");
}

/**
 * Poll `predicate()` every `intervalMs` until it returns true — then resolve —
 * or throw once `timeoutMs` elapses (fail loud; see the timeout branch below).
 * Returns `Promise<void>`. Tests use this instead of fixed sleeps for
 * fs.watch-driven assertions so fast machines resolve quickly while loaded CI
 * runners get the headroom they need.
 */
async function pollUntil(
  predicate: () => boolean,
  options: { timeoutMs: number; intervalMs?: number }
): Promise<void> {
  const interval = options.intervalMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
  // Fail loud on timeout instead of falling through: a silent return would let
  // the caller assert against stale state and surface as a confusing count
  // mismatch rather than an explicit "condition never held" error (FEA-2399).
  throw new Error(
    `pollUntil: predicate did not hold within ${options.timeoutMs}ms`
  );
}

/** Minimal trace context used by all tests. */
const TRACE = { loopId: "test-loop-1" };

// ---------------------------------------------------------------------------
// Fixture builders — one per event type
// ---------------------------------------------------------------------------

function makeRunLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "run",
    run_id: "run-1",
    started_at: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function makePhaseLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "phase",
    run_id: "run-1",
    iteration: 1,
    phase: "Phase 1",
    status: "started",
    started_at: "2026-01-01T00:00:01Z",
    ...overrides,
  });
}

function makeIterationLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "iteration",
    run_id: "run-1",
    iteration: 1,
    started_at: "2026-01-01T00:00:01Z",
    ended_at: "2026-01-01T00:00:02Z",
    duration_s: 1.0,
    status: "completed",
    ...overrides,
  });
}

function makePipelineStepLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "pipeline_step",
    run_id: "run-1",
    iteration: 1,
    step: 1,
    step_name: "lint",
    started_at: "2026-01-01T00:00:02Z",
    ended_at: "2026-01-01T00:00:03Z",
    duration_s: 1.0,
    skipped: false,
    ...overrides,
  });
}

function makeAgentLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "agent",
    run_id: "run-1",
    iteration: 1,
    agent_id: "agent-1",
    agent_type: "coder",
    agent_name: "Coder Agent",
    started_at: "2026-01-01T00:00:01Z",
    ended_at: "2026-01-01T00:00:10Z",
    duration_s: 9.0,
    ...overrides,
  });
}

function makeToolLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "tool",
    run_id: "run-1",
    iteration: 1,
    agent_id: "agent-1",
    tool_name: "bash",
    started_at: "2026-01-01T00:00:02Z",
    ended_at: "2026-01-01T00:00:03Z",
    duration_s: 1.0,
    ok: true,
    ...overrides,
  });
}

function makeSkillLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "skill",
    run_id: "run-1",
    iteration: 1,
    agent_id: "agent-1",
    tool_name: "computer",
    skill_name: "screenshot",
    started_at: "2026-01-01T00:00:03Z",
    ended_at: "2026-01-01T00:00:04Z",
    duration_s: 1.0,
    ok: true,
    ...overrides,
  });
}

function makeSpawnLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "spawn",
    run_id: "run-1",
    iteration: 1,
    parent_agent_id: "agent-0",
    started_at: "2026-01-01T00:00:01Z",
    ...overrides,
  });
}

const commandVariantFixtures: ReadonlyArray<{
  category: TelemetryEventPayload["category"];
  makeLine: (overrides?: Record<string, unknown>) => string;
}> = [
  { category: "loop.perf.run", makeLine: makeRunLine },
  { category: "loop.perf.phase", makeLine: makePhaseLine },
  { category: "loop.perf.iteration", makeLine: makeIterationLine },
  { category: "loop.perf.pipeline_step", makeLine: makePipelineStepLine },
  { category: "loop.perf.agent", makeLine: makeAgentLine },
  { category: "loop.perf.tool", makeLine: makeToolLine },
  { category: "loop.perf.skill", makeLine: makeSkillLine },
  { category: "loop.perf.spawn", makeLine: makeSpawnLine },
];

// ---------------------------------------------------------------------------
// T-5.1: Zod schema validation — all 8 event types accept valid payloads
// ---------------------------------------------------------------------------

test("T-5.1: parseAndEmitChunk emits loop.perf.run for a valid run event", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  const result = parseAndEmitChunk(toChunk(`${makeRunLine()}\n`), {
    phaseState,
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.run");
  assert.equal(events[0]?.severity, "info");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf);
  assert.equal(loopPerf.event, "run");
  if (loopPerf.event === "run") {
    assert.equal(loopPerf.runId, "run-1");
    assert.equal(loopPerf.startedAt, "2026-01-01T00:00:00Z");
    assert.equal(loopPerf.command, undefined);
    assert.equal(loopPerf.repo, undefined);
    assert.equal(loopPerf.branch, undefined);
  }
  assert.equal(result.newPriorLineBuffer, "");
});

test("T-5.1: parseAndEmitChunk emits loop.perf.phase for a valid phase event", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  parseAndEmitChunk(toChunk(`${makePhaseLine()}\n`), {
    phaseState,
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.phase");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "phase");
  assert.equal(loopPerf.phase, "Phase 1");
  assert.equal(loopPerf.status, "started");
  assert.equal(loopPerf.iteration, 1);
  assert.equal(loopPerf.command, undefined);
  assert.equal(loopPerf.startSha, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.iteration for a valid iteration event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeIterationLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.iteration");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "iteration");
  assert.equal(loopPerf.durationS, 1.0);
  assert.equal(loopPerf.status, "completed");
  assert.equal(loopPerf.claudeExitCode, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.pipeline_step for a valid pipeline_step event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makePipelineStepLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.pipeline_step");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "pipeline_step");
  assert.equal(loopPerf.stepName, "lint");
  assert.equal(loopPerf.skipped, false);
  assert.equal(loopPerf.exitCode, undefined);
});

test("PLN-750: iteration command is accepted and emitted with summary fields", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(
    toChunk(
      `${makeIterationLine({
        command: "EXECUTE",
        duration_s: 12.5,
        status: "failed",
        claude_exit_code: 1,
      })}\n`
    ),
    {
      phaseState: createRunningPhaseState(),
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    }
  );

  assert.equal(events.length, 1);
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "iteration");
  assert.equal(loopPerf.command, "EXECUTE");
  assert.equal(loopPerf.durationS, 12.5);
  assert.equal(loopPerf.status, "failed");
  assert.equal(loopPerf.claudeExitCode, 1);
});

test("PLN-750: pipeline_step command is accepted and emitted with step fields", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(
    toChunk(
      `${makePipelineStepLine({
        command: "PLAN",
        step: 8.5,
        step_name: "write_merged_patterns",
        duration_s: 2.25,
        exit_code: 0,
        skipped: true,
      })}\n`
    ),
    {
      phaseState: createRunningPhaseState(),
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    }
  );

  assert.equal(events.length, 1);
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "pipeline_step");
  assert.equal(loopPerf.command, "PLAN");
  assert.equal(loopPerf.step, 8.5);
  assert.equal(loopPerf.stepName, "write_merged_patterns");
  assert.equal(loopPerf.durationS, 2.25);
  assert.equal(loopPerf.exitCode, 0);
  assert.equal(loopPerf.skipped, true);
});

test("PLN-750: all command-bearing variants preserve safe unknown command strings", () => {
  const { emitter, events } = makeMockEmitter();
  const command = "FUTURE_UNKNOWN_COMMAND";
  const chunk = commandVariantFixtures
    .map(({ makeLine }) => `${makeLine({ command })}\n`)
    .join("");

  parseAndEmitChunk(toChunk(chunk), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, commandVariantFixtures.length);
  for (const event of events) {
    const loopPerf = event.diagnostics?.loopPerf;
    assert.ok(loopPerf && loopPerf.event !== "parse_failure");
    assert.equal(loopPerf.command, command);
  }
});

test("PLN-750: absent and null commands are omitted for every command-bearing variant", () => {
  for (const command of [undefined, null]) {
    const { emitter, events } = makeMockEmitter();
    const chunk = commandVariantFixtures
      .map(
        ({ makeLine }) =>
          `${makeLine(command === undefined ? {} : { command })}\n`
      )
      .join("");

    parseAndEmitChunk(toChunk(chunk), {
      phaseState: createRunningPhaseState(),
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    });

    assert.equal(events.length, commandVariantFixtures.length);
    for (const event of events) {
      const loopPerf = event.diagnostics?.loopPerf;
      assert.ok(loopPerf && loopPerf.event !== "parse_failure");
      assert.ok(!("command" in loopPerf), "command must be omitted, not null");
    }
  }
});

test("PLN-750: command sanitizer applies consistently to every command-bearing variant", () => {
  const unsafeCases: ReadonlyArray<{
    command: string;
    expected?: string;
    maxBytes?: number;
  }> = [
    { command: "token=secret-value", expected: "[redacted]" },
    { command: '{"password":"hunter2"}', expected: "[redacted]" },
    { command: '{"access_token":"secret-value"}', expected: "[redacted]" },
    { command: '{"refresh_token":"secret-value"}', expected: "[redacted]" },
    { command: "GITHUB_TOKEN=secret-value", expected: "[redacted]" },
    { command: "OPENAI_API_KEY=secret-value", expected: "[redacted]" },
    { command: "--access-token secret-value", expected: "[redacted]" },
    { command: "API-KEY: abc123", expected: "[redacted]" },
    { command: "Authorization: Bearer secret-token", expected: "[redacted]" },
    { command: "\u001b[31mEXECUTE\u001b[0m", expected: "EXECUTE" },
    { command: "\u0000\u001b[31m\u001b[0m" },
    { command: "A".repeat(120), maxBytes: 64 },
  ];

  for (const unsafeCase of unsafeCases) {
    const { emitter, events } = makeMockEmitter();
    const chunk = commandVariantFixtures
      .map(({ makeLine }) => `${makeLine({ command: unsafeCase.command })}\n`)
      .join("");

    parseAndEmitChunk(toChunk(chunk), {
      phaseState: createRunningPhaseState(),
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    });

    assert.equal(events.length, commandVariantFixtures.length);
    for (const event of events) {
      const loopPerf = event.diagnostics?.loopPerf;
      assert.ok(loopPerf && loopPerf.event !== "parse_failure");
      if (unsafeCase.expected !== undefined) {
        assert.equal(loopPerf.command, unsafeCase.expected);
      } else if (unsafeCase.maxBytes === undefined) {
        assert.ok(
          !("command" in loopPerf),
          "blank sanitized command must be omitted"
        );
      } else {
        assert.ok(loopPerf.command);
        assert.ok(
          Buffer.byteLength(loopPerf.command, "utf-8") <= unsafeCase.maxBytes
        );
      }
      assert.notEqual(loopPerf.command, unsafeCase.command);
    }
  }
});

test("T-5.1: parseAndEmitChunk emits loop.perf.agent for a valid agent event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeAgentLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.agent");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "agent");
  assert.equal(loopPerf.agentId, "agent-1");
  assert.equal(loopPerf.agentType, "coder");
  assert.equal(loopPerf.agentName, "Coder Agent");
  // Optional/legacy fields are OMITTED (undefined) when absent — see the
  // contract note in telemetry-protocol.ts. Asserting `undefined` makes the
  // expectation explicit; checking `'field' in obj` would also work.
  assert.equal(loopPerf.command, undefined);
  assert.equal(loopPerf.model, undefined);
  assert.equal(loopPerf.inputTokens, undefined);
  assert.equal(loopPerf.phase, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.tool for a valid tool event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeToolLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.tool");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(loopPerf.toolName, "bash");
  assert.equal(loopPerf.ok, true);
  assert.equal(loopPerf.command, undefined);
  assert.equal(loopPerf.phase, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.skill for a valid skill event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeSkillLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.skill");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "skill");
  assert.equal(loopPerf.toolName, "computer");
  assert.equal(loopPerf.skillName, "screenshot");
  assert.equal(loopPerf.ok, true);
  assert.equal(loopPerf.command, undefined);
  assert.equal(loopPerf.phase, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.spawn for a valid spawn event", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeSpawnLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.spawn");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "spawn");
  assert.equal(loopPerf.parentAgentId, "agent-0");
  assert.equal(loopPerf.command, undefined);
  assert.equal(loopPerf.parentSessionId, undefined);
  assert.equal(loopPerf.plannedSubagentType, undefined);
  assert.equal(loopPerf.phase, undefined);
});

test("T-5.1: parseAndEmitChunk emits loop.perf.parse_failure for an invalid schema", () => {
  const { emitter, events } = makeMockEmitter();

  // Valid JSON but missing required fields for any event type
  const badLine = `${JSON.stringify({ event: "run" })}\n`; // missing run_id, started_at

  parseAndEmitChunk(toChunk(badLine), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.parse_failure");
  assert.equal(events[0]?.severity, "warn");
});

// ---------------------------------------------------------------------------
// T-5.2: Streaming running-phase attribution
// ---------------------------------------------------------------------------

test("T-5.2: phase event sets running-phase state; subsequent tool event payload contains attributed phase", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  // First chunk: phase event
  const r1 = parseAndEmitChunk(
    toChunk(
      `${makePhaseLine({ phase: "Phase 3", run_id: "R", iteration: 1 })}\n`
    ),
    {
      phaseState,
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.phase");

  // Second chunk: tool event (same run_id + iteration, no phase field in raw record)
  parseAndEmitChunk(
    toChunk(`${makeToolLine({ run_id: "R", iteration: 1 })}\n`),
    {
      phaseState,
      priorLineBuffer: r1.newPriorLineBuffer,
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: r1.newLineNumberBase,
    }
  );

  assert.equal(events.length, 2);
  const toolEvent = events[1];
  assert.equal(toolEvent?.category, "loop.perf.tool");
  const loopPerf = toolEvent?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(
    loopPerf.phase,
    "Phase 3",
    "tool event must carry attributed phase"
  );
});

test("T-5.2: tool event emits phase: null when no prior phase event observed", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk(`${makeToolLine()}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(loopPerf.phase, undefined);
});

test("T-5.2: phase attribution is keyed by (run_id, iteration) — different iteration does not bleed over", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  // Phase event for iteration 1
  const r1 = parseAndEmitChunk(
    toChunk(
      `${makePhaseLine({ phase: "Phase 1", run_id: "R", iteration: 1 })}\n`
    ),
    {
      phaseState,
      priorLineBuffer: "",
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: 0,
    }
  );

  // Tool event for iteration 2 — should NOT inherit phase from iteration 1
  parseAndEmitChunk(
    toChunk(`${makeToolLine({ run_id: "R", iteration: 2 })}\n`),
    {
      phaseState,
      priorLineBuffer: r1.newPriorLineBuffer,
      telemetryEmitter: emitter,
      traceContext: TRACE,
      lineNumberBase: r1.newLineNumberBase,
    }
  );

  const toolEvent = events[1];
  const loopPerf = toolEvent?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(
    loopPerf.phase,
    undefined,
    "phase must be omitted when no prior phase event in this iteration"
  );
});

// ---------------------------------------------------------------------------
// T-5.3: Partial-line buffering across chunks
// ---------------------------------------------------------------------------

test("T-5.3: first half of a JSON event (no trailing newline) triggers no emission and no parse_failure", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  const fullLine = makeRunLine();
  const half = fullLine.slice(0, Math.floor(fullLine.length / 2));

  const r1 = parseAndEmitChunk(toChunk(half), {
    phaseState,
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  // No events should have been emitted (no complete line yet)
  assert.equal(
    events.length,
    0,
    "no events must be emitted for a partial line"
  );
  // The partial bytes must be buffered
  assert.ok(r1.newPriorLineBuffer.length > 0, "partial bytes must be buffered");
});

test("T-5.3: second half of a JSON event triggers exactly one emission", () => {
  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();

  const fullLine = makeRunLine();
  const midpoint = Math.floor(fullLine.length / 2);
  const firstHalf = fullLine.slice(0, midpoint);
  const secondHalf = `${fullLine.slice(midpoint)}\n`;

  // First chunk: no emission
  const r1 = parseAndEmitChunk(toChunk(firstHalf), {
    phaseState,
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  // Second chunk: exactly one emission
  parseAndEmitChunk(toChunk(secondHalf), {
    phaseState,
    priorLineBuffer: r1.newPriorLineBuffer,
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: r1.newLineNumberBase,
  });

  assert.equal(
    events.length,
    1,
    "exactly one event must be emitted after the complete line arrives"
  );
  assert.equal(events[0]?.category, "loop.perf.run");
  // No parse_failure events
  assert.ok(
    events.every((e) => e.category !== "loop.perf.parse_failure"),
    "no parse_failure must be emitted for partial-line buffering"
  );
});

// ---------------------------------------------------------------------------
// T-5.4: Reconciliation catch-up read — no double emission
// ---------------------------------------------------------------------------

test("T-5.4: reconcileLoopPerfTelemetry emits only records beyond watcher HWM", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t54-"));
  tempPathsToClean.push(workdir);

  const perfFile = path.join(workdir, "perf.jsonl");

  // Write N=5 events
  const lines = [
    makeRunLine(),
    makePhaseLine(),
    makeIterationLine(),
    makePipelineStepLine(),
    makeAgentLine(),
  ]
    .map((l) => `${l}\n`)
    .join("");

  await fs.writeFile(perfFile, lines, "utf-8");

  // Watcher HWM covers only the first M=2 records
  const firstTwoLines = [makeRunLine(), makePhaseLine()]
    .map((l) => `${l}\n`)
    .join("");
  const hwmAfterTwo = Buffer.byteLength(firstTwoLines, "utf-8");

  const { emitter: watcherEmitter, events: watcherEvents } = makeMockEmitter();

  // Simulate the watcher having emitted the first 2 records
  const watcherPhaseState = createRunningPhaseState();
  parseAndEmitChunk(Buffer.from(firstTwoLines, "utf-8"), {
    phaseState: watcherPhaseState,
    priorLineBuffer: "",
    telemetryEmitter: watcherEmitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });
  assert.equal(watcherEvents.length, 2, "watcher must have emitted 2 records");

  // Build a mock watcher handle reflecting the watcher's state
  const mockWatcherHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => hwmAfterTwo,
    getPhaseState: () => watcherPhaseState,
    getLineNumberBase: () => 2,
    getPriorLineBuffer: () => "",
    getToolCallsBaseline: () => new Set<string>(),
  };

  // Reconciliation pass — should emit only the remaining 3 records
  const { emitter: reconcileEmitter, events: reconcileEvents } =
    makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: reconcileEmitter,
    watcherHandle: mockWatcherHandle,
  });

  assert.equal(
    reconcileEvents.length,
    3,
    `reconcile must emit exactly 3 events (N-M=5-2), got ${reconcileEvents.length}`
  );

  // Verify total across watcher + reconcile is N=5 (no double emission)
  const totalEvents = watcherEvents.length + reconcileEvents.length;
  assert.equal(
    totalEvents,
    5,
    "total watcher + reconcile events must equal N=5"
  );

  // Verify the reconcile events are the right ones (iteration, pipeline_step, agent)
  const reconcileCategories = reconcileEvents.map((e) => e.category);
  assert.ok(reconcileCategories.includes("loop.perf.iteration"));
  assert.ok(reconcileCategories.includes("loop.perf.pipeline_step"));
  assert.ok(reconcileCategories.includes("loop.perf.agent"));
});

test("T-5.4: reconcileLoopPerfTelemetry with no watcherHandle starts from startOffset", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t54b-"));
  tempPathsToClean.push(workdir);

  const perfFile = path.join(workdir, "perf.jsonl");

  const twoLines = [makeRunLine(), makeIterationLine()]
    .map((l) => `${l}\n`)
    .join("");
  const startOffset = Buffer.byteLength(`${makeRunLine()}\n`, "utf-8");

  await fs.writeFile(perfFile, twoLines, "utf-8");

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  // Only the second line (beyond startOffset) should be emitted
  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.iteration");
});

// ---------------------------------------------------------------------------
// T-5.5: Mixed-version payload handling (legacy + v2 agent events)
// ---------------------------------------------------------------------------

test("T-5.5: legacy agent event (no command/token fields) omits missing fields entirely (preserves source omission for symphony-alpha contract)", () => {
  const { emitter, events } = makeMockEmitter();

  // Legacy agent: no command, no token fields
  const legacyAgent = makeAgentLine();
  // v2 agent: has command + token fields
  const v2Agent = makeAgentLine({
    command: "EXECUTE",
    model: "claude-opus-4",
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 100,
    total_context_tokens: 1800,
  });

  const chunk = toChunk(`${legacyAgent}\n${v2Agent}\n`);

  parseAndEmitChunk(chunk, {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(
    events.length,
    2,
    "both legacy and v2 agent events must emit telemetry"
  );

  // Both should be loop.perf.agent
  assert.equal(events[0]?.category, "loop.perf.agent");
  assert.equal(events[1]?.category, "loop.perf.agent");

  // Legacy event: fields the producer omitted must be ABSENT from the
  // payload (not null). symphony-alpha consumes this contract and may add
  // these fields with optional-but-non-nullable schemas; emitting an
  // explicit null would cause those schemas to reject the event.
  const legacyPayload = events[0]?.diagnostics?.loopPerf;
  assert.ok(legacyPayload && legacyPayload.event === "agent");
  assert.ok(
    !("command" in legacyPayload),
    "legacy command must be omitted, not null"
  );
  assert.ok(
    !("model" in legacyPayload),
    "legacy model must be omitted, not null"
  );
  assert.ok(
    !("inputTokens" in legacyPayload),
    "legacy inputTokens must be omitted"
  );
  assert.ok(
    !("outputTokens" in legacyPayload),
    "legacy outputTokens must be omitted"
  );
  assert.ok(
    !("cacheCreationInputTokens" in legacyPayload),
    "legacy cacheCreationInputTokens must be omitted"
  );
  assert.ok(
    !("cacheReadInputTokens" in legacyPayload),
    "legacy cacheReadInputTokens must be omitted"
  );
  assert.ok(
    !("totalContextTokens" in legacyPayload),
    "legacy totalContextTokens must be omitted"
  );

  // v2 event: fields present
  const v2Payload = events[1]?.diagnostics?.loopPerf;
  assert.ok(v2Payload && v2Payload.event === "agent");
  assert.equal(v2Payload.command, "EXECUTE");
  assert.equal(v2Payload.model, "claude-opus-4");
  assert.equal(v2Payload.inputTokens, 1000);
  assert.equal(v2Payload.outputTokens, 500);
  assert.equal(v2Payload.cacheCreationInputTokens, 200);
  assert.equal(v2Payload.cacheReadInputTokens, 100);
  assert.equal(v2Payload.totalContextTokens, 1800);

  // No parse_failure events produced for either shape
  assert.ok(
    events.every((e) => e.category !== "loop.perf.parse_failure"),
    "no parse_failure must be produced for legacy or v2 agent shapes"
  );
});

// ---------------------------------------------------------------------------
// T-5.6: Malformed-line handling
// ---------------------------------------------------------------------------

test("T-5.6: malformed JSON between valid lines emits parse_failure but does not prevent surrounding emissions", () => {
  const { emitter, events } = makeMockEmitter();

  const validLine1 = `${makeRunLine()}\n`;
  const malformedLine = "{not valid json at all\n";
  const validLine2 = `${makeIterationLine()}\n`;

  const chunk = toChunk(validLine1 + malformedLine + validLine2);

  parseAndEmitChunk(chunk, {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 3, "must emit 2 valid events + 1 parse_failure");

  const categories = events.map((e) => e.category);
  assert.ok(
    categories.includes("loop.perf.run"),
    "loop.perf.run must be emitted"
  );
  assert.ok(
    categories.includes("loop.perf.iteration"),
    "loop.perf.iteration must be emitted"
  );
  assert.ok(
    categories.includes("loop.perf.parse_failure"),
    "loop.perf.parse_failure must be emitted"
  );

  // The parse_failure event must be a warning
  const parseFailure = events.find(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(parseFailure?.severity, "warn");
  const loopPerf = parseFailure?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "parse_failure");
  assert.ok(
    loopPerf.rawBytes.length > 0,
    "rawBytes must capture the malformed line"
  );
  assert.ok(loopPerf.errorMessage.length > 0, "errorMessage must be populated");
});

test("T-5.6: Zod validation failure emits parse_failure and continues processing", () => {
  const { emitter, events } = makeMockEmitter();

  const validLine = `${makeRunLine()}\n`;
  // Valid JSON but unknown event type (will fail discriminatedUnion)
  const zodFailLine = `${JSON.stringify({ event: "unknown_type", run_id: "r1" })}\n`;
  const anotherValidLine = `${makeIterationLine()}\n`;

  const chunk = toChunk(validLine + zodFailLine + anotherValidLine);

  parseAndEmitChunk(chunk, {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 3);
  const categories = events.map((e) => e.category);
  assert.ok(categories.includes("loop.perf.run"));
  assert.ok(categories.includes("loop.perf.iteration"));
  assert.ok(categories.includes("loop.perf.parse_failure"));
  assert.equal(
    events.find((e) => e.category === "loop.perf.parse_failure")?.severity,
    "warn"
  );
});

test("PLN-750: non-string command emits bounded parse_failure instead of normal loopPerf event", () => {
  const { emitter, events } = makeMockEmitter();
  const invalidLine = makeIterationLine({
    command: { token: "sk_secret_value" },
  });

  parseAndEmitChunk(toChunk(`${invalidLine}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.parse_failure");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "parse_failure");
  assert.equal(loopPerf.rawBytes.includes("sk_secret_value"), false);
  assert.ok(Buffer.byteLength(loopPerf.rawBytes, "utf-8") <= 1024);
});

test("PLN-750: malformed JSON parse_failure redacts echoed credential snippets in errorMessage", () => {
  const { emitter, events } = makeMockEmitter();

  parseAndEmitChunk(toChunk("ghp_secret_value_that_json_parse_echoes\n"), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.category, "loop.perf.parse_failure");
  const loopPerf = events[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "parse_failure");
  assert.equal(loopPerf.rawBytes, "[redacted]");
  assert.equal(loopPerf.errorMessage, "[redacted]");
});

test("PLN-750: malformed bursts are capped, redacted, and later valid command rows continue", () => {
  const { emitter, events } = makeMockEmitter();
  const secretLine = `{"event":"iteration","command":"token=${"x".repeat(4096)}`;
  const malformedLines = [
    secretLine,
    ...Array.from({ length: 49 }, (_value, index) => `{bad json ${index}`),
  ];
  const validIteration = makeIterationLine({ command: "EXECUTE" });
  const validPipelineStep = makePipelineStepLine({ command: "PLAN" });
  const chunk = toChunk(
    [...malformedLines, validIteration, validPipelineStep]
      .map((line) => `${line}\n`)
      .join("")
  );

  parseAndEmitChunk(chunk, {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    21,
    "20 details plus one summary must emit"
  );
  const detailFailures = failureEvents.slice(0, 20);
  for (const failure of detailFailures) {
    const loopPerf = failure.diagnostics?.loopPerf;
    assert.ok(loopPerf && loopPerf.event === "parse_failure");
    assert.ok(Buffer.byteLength(loopPerf.rawBytes, "utf-8") <= 1024);
    assert.equal(loopPerf.rawBytes.includes("token="), false);
    assert.equal(loopPerf.rawBytes.includes("x".repeat(64)), false);
  }
  const summary = failureEvents[20]?.diagnostics?.loopPerf;
  assert.ok(summary && summary.event === "parse_failure");
  assert.equal(summary.rawBytes, "");
  assert.match(summary.errorMessage, /30 additional parse failure/);

  const iterationEvent = events.find(
    (e) => e.category === "loop.perf.iteration"
  );
  const pipelineStepEvent = events.find(
    (e) => e.category === "loop.perf.pipeline_step"
  );
  assert.ok(iterationEvent?.diagnostics?.loopPerf?.event === "iteration");
  assert.equal(iterationEvent.diagnostics.loopPerf.command, "EXECUTE");
  assert.ok(
    pipelineStepEvent?.diagnostics?.loopPerf?.event === "pipeline_step"
  );
  assert.equal(pipelineStepEvent.diagnostics.loopPerf.command, "PLAN");
});

// ---------------------------------------------------------------------------
// T-5.7: Orphaned-sentinel handling
// ---------------------------------------------------------------------------

test("T-5.7: reconcileLoopPerfTelemetry emits loop.perf.tool with nulls for orphaned sentinel file", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t57-"));
  tempPathsToClean.push(workdir);

  // Create empty perf.jsonl so file operations don't fail
  await fs.writeFile(path.join(workdir, "perf.jsonl"), "", "utf-8");

  // Pre-populate .tool-calls/ with a sentinel file
  const toolCallsDir = path.join(workdir, ".tool-calls");
  await fs.mkdir(toolCallsDir, { recursive: true });

  const sentinelData = {
    run_id: "run-sentinel-1",
    agent_id: "agent-sentinel-1",
    tool_name: "bash",
    started_at: "2026-01-01T00:00:01Z",
    iteration: 1,
    command: "EXECUTE",
  };
  await fs.writeFile(
    path.join(toolCallsDir, "sentinel-abc123.json"),
    JSON.stringify(sentinelData),
    "utf-8"
  );

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  // Find the orphaned tool event
  const orphanEvents = events.filter((e) => e.category === "loop.perf.tool");
  assert.equal(
    orphanEvents.length,
    1,
    "exactly one loop.perf.tool event must be emitted for the orphan"
  );

  const orphanEvent = orphanEvents[0];
  assert.equal(orphanEvent?.severity, "info");
  const loopPerf = orphanEvent?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(loopPerf.runId, "run-sentinel-1");
  assert.equal(loopPerf.agentId, "agent-sentinel-1");
  assert.equal(loopPerf.toolName, "bash");
  assert.equal(loopPerf.startedAt, "2026-01-01T00:00:01Z");
  assert.equal(loopPerf.iteration, 1);
  assert.equal(loopPerf.command, "EXECUTE");
  assert.equal(
    loopPerf.endedAt,
    null,
    "endedAt must be null for orphaned sentinel"
  );
  assert.equal(
    loopPerf.durationS,
    null,
    "durationS must be null for orphaned sentinel"
  );
  assert.equal(loopPerf.ok, null, "ok must be null for orphaned sentinel");
  assert.equal(
    loopPerf.phase,
    undefined,
    "phase must be omitted (not null) for orphaned sentinel — no phase observed"
  );
});

test("T-5.7: reconcileLoopPerfTelemetry skips non-JSON sentinel files without crashing", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t57b-"));
  tempPathsToClean.push(workdir);

  await fs.writeFile(path.join(workdir, "perf.jsonl"), "", "utf-8");

  const toolCallsDir = path.join(workdir, ".tool-calls");
  await fs.mkdir(toolCallsDir, { recursive: true });
  await fs.writeFile(
    path.join(toolCallsDir, "bad-sentinel.json"),
    "not json",
    "utf-8"
  );

  const { emitter, events } = makeMockEmitter();
  // Should not throw
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  // No tool events emitted, no crash
  const toolEvents = events.filter((e) => e.category === "loop.perf.tool");
  assert.equal(toolEvents.length, 0);
});

// ---------------------------------------------------------------------------
// T-5.8: Watcher-failure resilience
// ---------------------------------------------------------------------------

test("T-5.8: startLoopPerfTelemetryWatcher self-disables with warning when file watching fails (non-existent path on unsupported mount)", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t58-"));
  tempPathsToClean.push(workdir);

  // Write some events to perf.jsonl before the watcher is created
  const perfFile = path.join(workdir, "perf.jsonl");
  const twoLines = [makeRunLine(), makeIterationLine()]
    .map((l) => `${l}\n`)
    .join("");
  await fs.writeFile(perfFile, twoLines, "utf-8");

  const { emitter: watcherEmitter, events: watcherEvents } = makeMockEmitter();

  // On macOS/Linux fs.watch throws for a non-existent path.
  // We simulate a failing watcher by passing a workdir that has NO perf.jsonl
  // at a path that cannot be watched (use a path inside a non-existent directory).
  const nonExistentWorkdir = path.join(workdir, "does-not-exist");
  // Do NOT create the directory — fs.watch on the file inside will throw.

  const handle = startLoopPerfTelemetryWatcher(nonExistentWorkdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: watcherEmitter,
  });

  // The watcher should have emitted a warning telemetry event
  const warningEvents = watcherEvents.filter(
    (e) => e.category === "loop.perf.parse_failure" && e.severity === "warn"
  );
  assert.ok(
    warningEvents.length >= 1,
    "a warning telemetry event must be emitted when watcher fails to initialize"
  );

  // The handle must still be usable (no-op handle)
  await handle.stop();
  assert.equal(typeof handle.getHwm(), "number");

  // Reconciliation pass on the ACTUAL workdir (which has records) still emits all records
  const { emitter: reconcileEmitter, events: reconcileEvents } =
    makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: reconcileEmitter,
  });

  assert.equal(
    reconcileEvents.length,
    2,
    "reconcile must emit all 2 records that the watcher missed"
  );
  assert.equal(
    reconcileEvents.filter((e) => e.category === "loop.perf.run").length,
    1
  );
  assert.equal(
    reconcileEvents.filter((e) => e.category === "loop.perf.iteration").length,
    1
  );
});

test("T-5.8: watcher handle from failure returns a no-op stop() and valid getHwm()/getPhaseState()", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t58b-"));
  tempPathsToClean.push(workdir);

  const { emitter, events: _events } = makeMockEmitter();

  // Use a non-existent subpath so fs.watch throws
  const badWorkdir = path.join(workdir, "does-not-exist");

  const handle = startLoopPerfTelemetryWatcher(badWorkdir, {
    startOffset: 42,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  // stop() must resolve without throwing
  await handle.stop();

  // getHwm() must return the startOffset (42) since watcher never advanced it
  assert.equal(handle.getHwm(), 42);

  // getPhaseState() must return an empty map
  assert.equal(handle.getPhaseState().size, 0);
});

// ---------------------------------------------------------------------------
// T-5.9: Watcher streams records when perf.jsonl is created after watcher starts
// ---------------------------------------------------------------------------

test("T-5.9: startLoopPerfTelemetryWatcher streams records via fs.watch or the fallback poll when perf.jsonl is created after the watcher starts", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t59-"));
  tempPathsToClean.push(workdir);

  // The orchestrator typically creates perf.jsonl shortly AFTER the desktop
  // server installs the watcher. To isolate the proactive `fs.watch` path
  // (rather than the initial-tick or stop()-flush paths), wait long enough
  // for the initial 250ms debounce tick to fire against the empty workdir
  // BEFORE writing the file. The records that arrive afterwards must be
  // emitted by the watcher's directory event handler, not by an unrelated
  // catch-up read.
  const { emitter, events } = makeMockEmitter();
  const handle = startLoopPerfTelemetryWatcher(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  // Wait past the 250ms debounce so the initial tick fires while perf.jsonl
  // is still missing — readBytesFrom returns null and the watcher remains at
  // HWM=0 with zero events emitted.
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  assert.equal(
    events.length,
    0,
    "initial tick must not emit anything when perf.jsonl does not exist yet"
  );

  // Now create the file. The watcher must pick perf.jsonl up and emit both
  // records strictly before stop() is called: on Linux via the fs.watch
  // directory event, and on macOS (where fs.watch does not reliably deliver a
  // child-file creation event) via the fallback poll. Poll up to 2s instead of
  // using a fixed sleep so fast machines return quickly and loaded CI runners
  // (where event delivery / the poll interval + the 250ms debounce + tick can
  // comfortably exceed 500ms) still succeed deterministically.
  const perfFile = path.join(workdir, "perf.jsonl");
  const lines = [makeRunLine(), makeIterationLine()]
    .map((l) => `${l}\n`)
    .join("");
  await fs.writeFile(perfFile, lines, "utf-8");

  await pollUntil(
    () =>
      events.filter(
        (e) =>
          e.category === "loop.perf.run" || e.category === "loop.perf.iteration"
      ).length >= 2,
    { timeoutMs: 2000, intervalMs: 50 }
  );

  const proactiveRecordEvents = events.filter(
    (e) =>
      e.category === "loop.perf.run" || e.category === "loop.perf.iteration"
  );
  assert.equal(
    proactiveRecordEvents.length,
    2,
    `proactive fs.watch path must stream both records before stop(), got ${proactiveRecordEvents.length}`
  );

  // stop() should now be a no-op for emission (HWM already at EOF). The
  // assertion above guarantees the proactive path covered everything.
  await handle.stop();

  // No parse_failure must have been emitted from the initial-tick
  // missing-file path — readBytesFrom returns null cleanly.
  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    0,
    "no parse_failure must be emitted when the file is created after the watcher starts"
  );
});

// ---------------------------------------------------------------------------
// T-5.10: lineNumberBase is seeded from startOffset (absolute line numbers)
// ---------------------------------------------------------------------------

test("T-5.10: parse_failure during reconcile reports absolute line numbers when startOffset > 0", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t510-"));
  tempPathsToClean.push(workdir);

  // Simulate two prior-run records already on disk before this run starts.
  const priorLines = [makeRunLine(), makeIterationLine()]
    .map((l) => `${l}\n`)
    .join("");
  const perfFile = path.join(workdir, "perf.jsonl");
  await fs.writeFile(perfFile, priorLines, "utf-8");
  const startOffset = Buffer.byteLength(priorLines, "utf-8");

  // Append a malformed line for THIS run's reconcile pass.
  await fs.appendFile(perfFile, "not-json\n", "utf-8");

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  const failures = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(failures.length, 1, "exactly one parse_failure must be emitted");

  const diag = failures[0]?.diagnostics?.loopPerf;
  assert.ok(diag && diag.event === "parse_failure");
  // 2 prior lines exist before startOffset, so the malformed line is line 3.
  assert.equal(
    diag.lineNumber,
    3,
    `parse_failure lineNumber must be absolute (3), got ${String(diag.lineNumber)}`
  );
});

// ---------------------------------------------------------------------------
// T-5.11: priorLineBuffer is threaded across watcher → reconcile boundary
// ---------------------------------------------------------------------------

test("T-5.11: reconcileLoopPerfTelemetry inherits watcher priorLineBuffer so a record straddling the boundary is emitted exactly once", async () => {
  // Simulate the production failure mode: the watcher's last tick read up to
  // the middle of a JSON record, advanced HWM to that byte, and stashed the
  // first half in priorLineBuffer. The orchestrator then flushed the rest of
  // the record. Reconcile must inherit the buffer AND read the remaining
  // bytes from HWM to EOF, joining them into one valid record.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t511-"));
  tempPathsToClean.push(workdir);

  const perfFile = path.join(workdir, "perf.jsonl");
  const fullRecord = `${makePhaseLine()}\n`;
  await fs.writeFile(perfFile, fullRecord, "utf-8");

  // The watcher consumed bytes [0, splitAt) and stored that prefix in
  // priorLineBuffer (no newlines yet, so HWM = splitAt and buffer = prefix).
  const splitAt = Math.floor(fullRecord.length / 2);
  const watcherPriorLineBuffer = fullRecord.slice(0, splitAt);
  const phaseState = createRunningPhaseState();
  const mockHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => splitAt,
    getPhaseState: () => phaseState,
    getLineNumberBase: () => 0,
    getPriorLineBuffer: () => watcherPriorLineBuffer,
    getToolCallsBaseline: () => new Set<string>(),
  };

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    watcherHandle: mockHandle,
  });

  const phaseEvents = events.filter((e) => e.category === "loop.perf.phase");
  assert.equal(
    phaseEvents.length,
    1,
    "the straddling record must be emitted exactly once via reconcile"
  );
  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    0,
    "no parse_failure must be emitted for a clean watcher → reconcile straddle"
  );
});

test("PLN-750: command-bearing watcher and reconcile rows emit once with preserved commands", async () => {
  const workdir = await fs.mkdtemp(
    path.join(os.tmpdir(), "loop-perf-pln750-reconcile-")
  );
  tempPathsToClean.push(workdir);

  const watcherRecord = `${makeIterationLine({ command: "EXECUTE" })}\n`;
  const reconcileRecord = `${makePipelineStepLine({ command: "PLAN" })}\n`;
  const perfFile = path.join(workdir, "perf.jsonl");
  await fs.writeFile(perfFile, watcherRecord + reconcileRecord, "utf-8");

  const { emitter, events } = makeMockEmitter();
  const phaseState = createRunningPhaseState();
  parseAndEmitChunk(toChunk(watcherRecord), {
    phaseState,
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  const mockHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => Buffer.byteLength(watcherRecord, "utf-8"),
    getPhaseState: () => phaseState,
    getLineNumberBase: () => 1,
    getPriorLineBuffer: () => "",
    getToolCallsBaseline: () => new Set<string>(),
  };

  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    watcherHandle: mockHandle,
  });

  const infoEvents = events.filter((e) => e.severity === "info");
  assert.equal(
    infoEvents.length,
    2,
    "watcher plus reconcile must emit exactly two rows"
  );
  const iteration = infoEvents.find((e) => e.category === "loop.perf.iteration")
    ?.diagnostics?.loopPerf;
  const pipelineStep = infoEvents.find(
    (e) => e.category === "loop.perf.pipeline_step"
  )?.diagnostics?.loopPerf;
  assert.ok(iteration && iteration.event === "iteration");
  assert.equal(iteration.command, "EXECUTE");
  assert.ok(pipelineStep && pipelineStep.event === "pipeline_step");
  assert.equal(pipelineStep.command, "PLAN");
});

// ---------------------------------------------------------------------------
// T-5.12: Final record buffered without trailing newline is flushed on reconcile
// ---------------------------------------------------------------------------

test("T-5.12: reconcileLoopPerfTelemetry emits a final record buffered in the watcher when perf.jsonl lacks a trailing newline", async () => {
  // Production scenario flagged by review: the loop is killed (or exits)
  // immediately after the orchestrator wrote a final record but before the
  // trailing "\n" lands. The watcher's final tick reads the bytes, parses
  // nothing (no newline), stashes the entire record in priorLineBuffer, and
  // advances HWM to EOF. Reconcile then reads zero new bytes — without an
  // explicit flush the record is silently dropped.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t512-"));
  tempPathsToClean.push(workdir);

  const finalRecord = makeIterationLine({ command: "EXECUTE" }); // intentionally no trailing newline
  const perfFile = path.join(workdir, "perf.jsonl");
  await fs.writeFile(perfFile, finalRecord, "utf-8");

  // Watcher reads the whole record into priorLineBuffer; HWM is at EOF.
  const fileSize = Buffer.byteLength(finalRecord, "utf-8");
  const phaseState = createRunningPhaseState();
  const mockHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => fileSize,
    getPhaseState: () => phaseState,
    getLineNumberBase: () => 0,
    getPriorLineBuffer: () => finalRecord,
    getToolCallsBaseline: () => new Set<string>(),
  };

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    watcherHandle: mockHandle,
  });

  const iterationEvents = events.filter(
    (e) => e.category === "loop.perf.iteration"
  );
  assert.equal(
    iterationEvents.length,
    1,
    "the buffered final record must be flushed by reconcile even with HWM at EOF"
  );
  const loopPerf = iterationEvents[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "iteration");
  assert.equal(loopPerf.command, "EXECUTE");
  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    0,
    "no parse_failure must be emitted for a flushed final record"
  );
});

test("PLN-750: reconcileLoopPerfTelemetry emits a command-bearing final pipeline_step without a trailing newline", async () => {
  const workdir = await fs.mkdtemp(
    path.join(os.tmpdir(), "loop-perf-t512-pipeline-")
  );
  tempPathsToClean.push(workdir);

  const finalRecord = makePipelineStepLine({ command: "PLAN" });
  const perfFile = path.join(workdir, "perf.jsonl");
  await fs.writeFile(perfFile, finalRecord, "utf-8");

  const fileSize = Buffer.byteLength(finalRecord, "utf-8");
  const mockHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => fileSize,
    getPhaseState: () => createRunningPhaseState(),
    getLineNumberBase: () => 0,
    getPriorLineBuffer: () => finalRecord,
    getToolCallsBaseline: () => new Set<string>(),
  };

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    watcherHandle: mockHandle,
  });

  const pipelineStepEvents = events.filter(
    (e) => e.category === "loop.perf.pipeline_step"
  );
  assert.equal(pipelineStepEvents.length, 1);
  const loopPerf = pipelineStepEvents[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "pipeline_step");
  assert.equal(loopPerf.command, "PLAN");
});

test("T-5.12: reconcileLoopPerfTelemetry without a watcher handle still flushes a trailing record that lacks a newline", async () => {
  // Same scenario but no watcher (e.g. fs.watch failed to initialize and
  // returned the no-op handle). Reconcile reads from startOffset to EOF and
  // must still flush the final record even though it lacks a terminator.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t512b-"));
  tempPathsToClean.push(workdir);

  const finalRecord = makeRunLine(); // no trailing newline
  const perfFile = path.join(workdir, "perf.jsonl");
  await fs.writeFile(perfFile, finalRecord, "utf-8");

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  const runEvents = events.filter((e) => e.category === "loop.perf.run");
  assert.equal(
    runEvents.length,
    1,
    "reconcile must emit the trailing record even when it has no newline terminator"
  );
});

// ---------------------------------------------------------------------------
// T-5.13: Caller must gate reconcile when the watcher was never started
// ---------------------------------------------------------------------------

test("T-5.13: reconcileLoopPerfTelemetry called with no watcher and startOffset=0 re-emits every existing record (motivates the symphony-loop call-site gate)", async () => {
  // This test locks in the contract that motivates the gate in
  // handleProcessCompletion: when a non-run-loop command (e.g. REQUEST_CHANGES)
  // reuses a workdir that already contains a prior PLAN's perf.jsonl, calling
  // reconcileLoopPerfTelemetry from byte 0 with no watcher handle WILL re-emit
  // every record under the new command's trace context. handleProcessCompletion
  // therefore must NOT call reconcile in that case.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t513-"));
  tempPathsToClean.push(workdir);

  // Simulate a workdir left behind by a prior PLAN run.
  const priorRunRecords = [makeRunLine(), makePhaseLine(), makeIterationLine()]
    .map((l) => `${l}\n`)
    .join("");
  await fs.writeFile(
    path.join(workdir, "perf.jsonl"),
    priorRunRecords,
    "utf-8"
  );

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    // watcherHandle intentionally omitted — this is the unsafe scenario.
  });

  // The unguarded reconcile re-reads from byte 0 and emits every prior record.
  const recordEvents = events.filter(
    (e) =>
      e.category === "loop.perf.run" ||
      e.category === "loop.perf.phase" ||
      e.category === "loop.perf.iteration"
  );
  assert.equal(
    recordEvents.length,
    3,
    "unguarded reconcile re-emits all 3 prior-run records — caller MUST gate"
  );
});

test("T-5.13: reconcileLoopPerfTelemetry honors a non-zero startOffset to skip prior-run records", async () => {
  // Mirrors the failure mode from the symphony-loop fail-open path: when
  // fs.watch fails, startLoopPerfTelemetryWatcher returns a no-op handle that
  // still carries the captured startOffset. Reconcile must use that offset to
  // skip records the prior runs (or the captured pre-spawn boundary) already
  // accounted for, instead of re-reading from byte 0.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t513b-"));
  tempPathsToClean.push(workdir);

  const priorRunRecords = [makeRunLine(), makePhaseLine()]
    .map((l) => `${l}\n`)
    .join("");
  const priorByteLen = Buffer.byteLength(priorRunRecords, "utf-8");
  await fs.writeFile(
    path.join(workdir, "perf.jsonl"),
    priorRunRecords,
    "utf-8"
  );

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    // startOffset is positioned past every prior-run record — reconcile must
    // emit nothing because there are no new bytes between hwm and EOF.
    startOffset: priorByteLen,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    // Intentionally no watcherHandle — exercises the seedLineNumberBase /
    // raw-startOffset path used by the no-op fail-open handle.
  });

  assert.equal(
    events.length,
    0,
    "reconcile must emit no events when startOffset already covers every record"
  );
});

// ---------------------------------------------------------------------------
// T-5.14: Baseline filter prevents stale .tool-calls/ orphans from re-emitting
// ---------------------------------------------------------------------------

test("T-5.14: reconcileLoopPerfTelemetry skips sentinel files present in the watcher's baseline (prior-run orphans on a reused workdir)", async () => {
  // Production scenario flagged by review: a prior loop was killed mid-tool,
  // leaving a sentinel in .tool-calls/. The next PLAN/EXECUTE on the same
  // claudeWorkDir starts the watcher; the captured baseline must exclude that
  // stale sentinel so reconcile does not re-emit it under the new command's
  // trace context.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t514-"));
  tempPathsToClean.push(workdir);

  const toolCallsDir = path.join(workdir, ".tool-calls");
  await fs.mkdir(toolCallsDir, { recursive: true });

  // Stale sentinel from a hypothetical prior killed loop.
  const stalePayload = {
    run_id: "prior-run",
    agent_id: "prior-agent",
    tool_name: "Bash",
    started_at: "2026-01-01T00:00:00Z",
    iteration: 1,
    command: "PLAN",
  };
  await fs.writeFile(
    path.join(toolCallsDir, "stale-sentinel.json"),
    JSON.stringify(stalePayload),
    "utf-8"
  );

  // Fresh sentinel created during this run, after the baseline was captured.
  const freshPayload = {
    run_id: "current-run",
    agent_id: "current-agent",
    tool_name: "Edit",
    started_at: "2026-01-01T00:00:05Z",
    iteration: 1,
    command: "EXECUTE",
  };
  await fs.writeFile(
    path.join(toolCallsDir, "fresh-sentinel.json"),
    JSON.stringify(freshPayload),
    "utf-8"
  );

  const phaseState = createRunningPhaseState();
  const mockHandle = {
    stop: () => Promise.resolve(),
    getHwm: () => 0,
    getPhaseState: () => phaseState,
    getLineNumberBase: () => 0,
    getPriorLineBuffer: () => "",
    // Baseline contains only the stale file — fresh-sentinel.json appeared after.
    getToolCallsBaseline: () =>
      new Set<string>(["stale-sentinel.json"]) satisfies ReadonlySet<string>,
  };

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
    watcherHandle: mockHandle,
  });

  const toolEvents = events.filter((e) => e.category === "loop.perf.tool");
  assert.equal(
    toolEvents.length,
    1,
    "exactly one orphan event must be emitted — the fresh sentinel only"
  );

  const loopPerf = toolEvents[0]?.diagnostics?.loopPerf;
  assert.ok(loopPerf && loopPerf.event === "tool");
  assert.equal(
    loopPerf.runId,
    "current-run",
    "the emitted orphan must be the fresh sentinel, not the prior-run stale one"
  );
  assert.equal(loopPerf.toolName, "Edit");
});

test("T-5.14: reconcileLoopPerfTelemetry without a watcher handle still emits every sentinel (test-only path; production gates reconcile on watcher presence)", async () => {
  // Locks in the contract that the baseline filter is anchored on the watcher
  // handle: when there is no watcher (the path used by T-5.7 and other unit
  // tests), every sentinel is emitted. Production callers gate reconcile on
  // watcher presence so this codepath does not run for non-run-loop commands.
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-perf-t514b-"));
  tempPathsToClean.push(workdir);

  const toolCallsDir = path.join(workdir, ".tool-calls");
  await fs.mkdir(toolCallsDir, { recursive: true });
  const payload = {
    run_id: "run-1",
    agent_id: "agent-1",
    tool_name: "Bash",
    started_at: "2026-01-01T00:00:00Z",
    iteration: 1,
    command: "EXECUTE",
  };
  await fs.writeFile(
    path.join(toolCallsDir, "any-sentinel.json"),
    JSON.stringify(payload),
    "utf-8"
  );

  const { emitter, events } = makeMockEmitter();
  reconcileLoopPerfTelemetry(workdir, {
    startOffset: 0,
    traceContext: TRACE,
    telemetryEmitter: emitter,
  });

  const toolEvents = events.filter((e) => e.category === "loop.perf.tool");
  assert.equal(
    toolEvents.length,
    1,
    "without a watcher handle the baseline is empty — every sentinel emits"
  );
});

// ---------------------------------------------------------------------------
// T-5.15: Fractional pipeline step numbers (e.g. 8.5) are accepted
// ---------------------------------------------------------------------------

test("T-5.15: pipeline_step with a fractional `step` value is accepted and emitted as loop.perf.pipeline_step", () => {
  // The producer emits a synthetic sub-step (write_merged_patterns) at
  // step 8.5 between integer pipeline positions. The schema must accept it
  // instead of rejecting the otherwise-valid record as a parse_failure.
  const { emitter, events } = makeMockEmitter();
  const fractionalStep = makePipelineStepLine({
    step: 8.5,
    step_name: "write_merged_patterns",
  });

  parseAndEmitChunk(toChunk(`${fractionalStep}\n`), {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  const stepEvents = events.filter(
    (e) => e.category === "loop.perf.pipeline_step"
  );
  assert.equal(
    stepEvents.length,
    1,
    "fractional step record must emit one pipeline_step event"
  );

  const payload = stepEvents[0]?.diagnostics?.loopPerf;
  assert.ok(payload && payload.event === "pipeline_step");
  assert.equal(
    payload.step,
    8.5,
    "step value must be preserved as a non-integer number"
  );
  assert.equal(payload.stepName, "write_merged_patterns");

  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    0,
    "no parse_failure must be emitted for a fractional pipeline step"
  );
});

// ---------------------------------------------------------------------------
// T-5.16: Known-but-unsupported producer events are skipped silently
// ---------------------------------------------------------------------------

test("T-5.16: known-unsupported producer events (post_loop_review / post_loop_fix) are skipped without emitting parse_failure", () => {
  // The producer emits post_loop_review / post_loop_fix records that the
  // desktop does not yet have a TelemetryCategory for. These are valid
  // producer output and must NOT show up in Datadog as warnings — they
  // should simply be ignored. Surrounding valid events must continue to
  // emit normally.
  const { emitter, events } = makeMockEmitter();

  const validBefore = makeRunLine();
  const postLoopReview = JSON.stringify({
    event: "post_loop_review",
    run_id: "run-1",
    started_at: "2026-01-01T00:00:30Z",
    summary: "loop completed successfully",
  });
  const postLoopFix = JSON.stringify({
    event: "post_loop_fix",
    run_id: "run-1",
    started_at: "2026-01-01T00:00:35Z",
    fix_count: 2,
  });
  const validAfter = makeIterationLine();

  const chunk = toChunk(
    [validBefore, postLoopReview, postLoopFix, validAfter]
      .map((l) => `${l}\n`)
      .join("")
  );

  parseAndEmitChunk(chunk, {
    phaseState: createRunningPhaseState(),
    priorLineBuffer: "",
    telemetryEmitter: emitter,
    traceContext: TRACE,
    lineNumberBase: 0,
  });

  const failureEvents = events.filter(
    (e) => e.category === "loop.perf.parse_failure"
  );
  assert.equal(
    failureEvents.length,
    0,
    "post_loop_* records must not produce parse_failure warnings"
  );

  // The two surrounding records must still emit normally.
  const runEvents = events.filter((e) => e.category === "loop.perf.run");
  const iterationEvents = events.filter(
    (e) => e.category === "loop.perf.iteration"
  );
  assert.equal(
    runEvents.length,
    1,
    "run record around the skipped events must still emit"
  );
  assert.equal(
    iterationEvents.length,
    1,
    "iteration record after the skipped events must still emit"
  );

  // No spurious post_loop_* category leaked through either.
  const postLoopCategories = events.filter((e) =>
    e.category.toString().startsWith("loop.perf.post_loop")
  );
  assert.equal(
    postLoopCategories.length,
    0,
    "post_loop_* events must not emit under any loop.perf.* category"
  );
});
