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
