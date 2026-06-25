import assert from "node:assert/strict";
import { test } from "node:test";
import { deterministicEventId } from "../src/main/database/deterministic-event-id.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("deterministic-event-id returns the same ID for identical inputs", () => {
  const first = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );
  const second = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );

  assert.equal(first, second);
});

test("deterministic-event-id produces different IDs for different sessionIds", () => {
  const a = deterministicEventId(
    "session-aaa",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Read"
  );
  const b = deterministicEventId(
    "session-bbb",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Read"
  );

  assert.notEqual(a, b);
});

test("deterministic-event-id produces different IDs for different eventTypes", () => {
  const a = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );
  const b = deterministicEventId(
    "session-abc",
    "AssistantMessage",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );

  assert.notEqual(a, b);
});

test("deterministic-event-id output matches UUID v4 format with version=4 and variant bits", () => {
  const id = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Write"
  );

  assert.match(id, UUID_PATTERN);
});

test("deterministic-event-id handles null toolName without throwing", () => {
  const id = deterministicEventId(
    "session-abc",
    "AssistantMessage",
    "2026-06-15T10:00:00.000Z",
    null
  );

  assert.match(id, UUID_PATTERN);
});

test("deterministic-event-id handles undefined toolName without throwing", () => {
  const id = deterministicEventId(
    "session-abc",
    "AssistantMessage",
    "2026-06-15T10:00:00.000Z",
    undefined
  );

  assert.match(id, UUID_PATTERN);
});

test("deterministic-event-id null and undefined toolName produce the same ID", () => {
  const withNull = deterministicEventId(
    "session-abc",
    "AssistantMessage",
    "2026-06-15T10:00:00.000Z",
    null
  );
  const withUndefined = deterministicEventId(
    "session-abc",
    "AssistantMessage",
    "2026-06-15T10:00:00.000Z",
    undefined
  );

  assert.equal(withNull, withUndefined);
});

test("deterministic-event-id different discriminator values produce different IDs", () => {
  const base = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash",
    "chunk-1"
  );
  const other = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash",
    "chunk-2"
  );

  assert.notEqual(base, other);
});

test("deterministic-event-id null discriminator produces the same ID as omitted discriminator", () => {
  const withNull = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash",
    null
  );
  const omitted = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );

  assert.equal(withNull, omitted);
});

test("deterministic-event-id undefined discriminator produces the same ID as omitted discriminator", () => {
  const withUndefined = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash",
    undefined
  );
  const omitted = deterministicEventId(
    "session-abc",
    "ToolUse",
    "2026-06-15T10:00:00.000Z",
    "Bash"
  );

  assert.equal(withUndefined, omitted);
});
