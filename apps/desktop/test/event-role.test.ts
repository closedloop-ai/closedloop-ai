import assert from "node:assert/strict";
import { test } from "node:test";
import { eventRole } from "../src/shared/event-role.js";

// --- Human events ---

test("UserPromptSubmit maps to human", () => {
  assert.equal(eventRole("UserPromptSubmit"), "human");
});

test("UserMessage maps to human", () => {
  assert.equal(eventRole("UserMessage"), "human");
});

// --- Agent events ---

test("PostToolUse maps to agent", () => {
  assert.equal(eventRole("PostToolUse"), "agent");
});

test("PreToolUse maps to agent", () => {
  assert.equal(eventRole("PreToolUse"), "agent");
});

test("AssistantMessage maps to agent", () => {
  assert.equal(eventRole("AssistantMessage"), "agent");
});

test("SubagentStop maps to agent", () => {
  assert.equal(eventRole("SubagentStop"), "agent");
});

test("Stop maps to agent", () => {
  assert.equal(eventRole("Stop"), "agent");
});

// --- System events ---

test("TurnDuration maps to system", () => {
  assert.equal(eventRole("TurnDuration"), "system");
});

test("APIError maps to system", () => {
  assert.equal(eventRole("APIError"), "system");
});

test("ToolError maps to system", () => {
  assert.equal(eventRole("ToolError"), "system");
});

test("Notification maps to system", () => {
  assert.equal(eventRole("Notification"), "system");
});

test("SessionStart maps to system", () => {
  assert.equal(eventRole("SessionStart"), "system");
});

test("SessionEnd maps to system", () => {
  assert.equal(eventRole("SessionEnd"), "system");
});

// --- Default fallback ---

test("unknown event type defaults to system", () => {
  assert.equal(eventRole("CompletelyMadeUp"), "system");
});
