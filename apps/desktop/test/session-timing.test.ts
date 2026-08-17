import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSessionTiming } from "../src/shared/session-timing.js";

/** Helper: build an event with a given type and ISO timestamp. */
function ev(eventType: string, ms: number) {
  return { eventType, createdAt: new Date(ms).toISOString() };
}

test("empty events array returns zeros", () => {
  assert.deepStrictEqual(computeSessionTiming([]), {
    activeAgentMs: 0,
    waitingUserMs: 0,
  });
});

test("single event returns zeros", () => {
  const result = computeSessionTiming([ev("PostToolUse", 1000)]);
  assert.deepStrictEqual(result, { activeAgentMs: 0, waitingUserMs: 0 });
});

test("agent event followed by human event counts as waitingUserMs", () => {
  const result = computeSessionTiming([
    ev("PostToolUse", 1000), // agent
    ev("UserPromptSubmit", 4000), // human
  ]);
  assert.equal(result.waitingUserMs, 3000);
  assert.equal(result.activeAgentMs, 0);
});

test("human event followed by agent event counts as activeAgentMs", () => {
  const result = computeSessionTiming([
    ev("UserPromptSubmit", 1000), // human
    ev("PostToolUse", 6000), // agent
  ]);
  assert.equal(result.activeAgentMs, 5000);
  assert.equal(result.waitingUserMs, 0);
});

test("system events are skipped and do not contribute to either bucket", () => {
  // system -> agent: system is prev, prevRole === "system" so gap is dropped
  const result = computeSessionTiming([
    ev("SessionStart", 0), // system
    ev("PostToolUse", 5000), // agent
  ]);
  assert.equal(result.activeAgentMs, 0);
  assert.equal(result.waitingUserMs, 0);
});

test("mixed sequence produces expected active/waiting split", () => {
  // Timeline:
  //   0ms  UserPromptSubmit (human)
  //   -> 2000ms gap, human->agent = activeAgentMs += 2000
  //   2000ms PostToolUse (agent)
  //   -> 3000ms gap, agent->agent = activeAgentMs += 3000
  //   5000ms PostToolUse (agent)
  //   -> 1000ms gap, agent->agent = activeAgentMs += 1000
  //   6000ms Stop (agent)
  //   -> 4000ms gap, agent->human = waitingUserMs += 4000
  //   10000ms UserPromptSubmit (human)
  const result = computeSessionTiming([
    ev("UserPromptSubmit", 0),
    ev("PostToolUse", 2000),
    ev("PostToolUse", 5000),
    ev("Stop", 6000),
    ev("UserPromptSubmit", 10_000),
  ]);
  assert.equal(result.activeAgentMs, 6000);
  assert.equal(result.waitingUserMs, 4000);
});

test("all agent events produce no waitingUserMs", () => {
  const result = computeSessionTiming([
    ev("PostToolUse", 0),
    ev("PreToolUse", 1000),
    ev("AssistantMessage", 3000),
    ev("Stop", 7000),
  ]);
  assert.equal(result.activeAgentMs, 7000);
  assert.equal(result.waitingUserMs, 0);
});

// ── FEA-3582: active/idle time must never exceed the session's wall window ──────

test("bounds clamp active time to wall when the timeline overruns the span", () => {
  // startedAt = 1000, endedAt = 6000 => wall = 5000ms. A timeline event predates
  // the declared start (an early metadata.messages row) and another runs past the
  // resolved end (a folded concurrent-subagent event). Unclamped, the summed
  // active gap would be 8000ms — GREATER than the 5000ms wall. Clamping caps it.
  const events = [
    ev("UserPromptSubmit", 0), // human, before startMs (1000)
    ev("PostToolUse", 3000), // agent, in-window
    ev("Stop", 8000), // agent, past endMs (6000)
  ];
  const unclamped = computeSessionTiming(events);
  assert.equal(unclamped.activeAgentMs, 8000); // 3000 + 5000 raw gaps

  const clamped = computeSessionTiming(events, { startMs: 1000, endMs: 6000 });
  // gap [0,3000) clamped to [1000,3000) = 2000; gap [3000,8000) clamped to
  // [3000,6000) = 3000; total active = 5000 == wall, never exceeding it.
  assert.equal(clamped.activeAgentMs, 5000);
  assert.ok(
    clamped.activeAgentMs + clamped.waitingUserMs <= 6000 - 1000,
    "active + waiting must be <= wall"
  );
});

test("bounds leave a clean in-window timeline unchanged", () => {
  // Every event sits inside [startMs, endMs]; clamping is a no-op vs unclamped.
  const events = [
    ev("UserPromptSubmit", 1000), // human
    ev("PostToolUse", 3000), // agent (human->agent = active 2000)
    ev("Stop", 4000), // agent (agent->agent = active 1000)
    ev("UserPromptSubmit", 6000), // human (agent->human = waiting 2000)
  ];
  const clamped = computeSessionTiming(events, { startMs: 0, endMs: 10_000 });
  assert.equal(clamped.activeAgentMs, 3000);
  assert.equal(clamped.waitingUserMs, 2000);
});

test("a gap wholly outside the window contributes nothing", () => {
  const events = [
    ev("UserPromptSubmit", 100), // human
    ev("PostToolUse", 500), // agent — entire gap precedes startMs
  ];
  const clamped = computeSessionTiming(events, { startMs: 1000, endMs: 2000 });
  assert.equal(clamped.activeAgentMs, 0);
  assert.equal(clamped.waitingUserMs, 0);
});

test("ignores a degenerate window (endMs < startMs) and sums raw gaps", () => {
  const events = [ev("UserPromptSubmit", 0), ev("PostToolUse", 4000)];
  const result = computeSessionTiming(events, { startMs: 9000, endMs: 1000 });
  assert.equal(result.activeAgentMs, 4000);
});
