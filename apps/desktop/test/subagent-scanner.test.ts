import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  MAX_STRINGIFIED_CHARS,
  scanSubagentTranscript,
  scanSubagentTranscriptStream,
  stringifyBounded,
} from "../src/main/collectors/parsing/subagent-scanner.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";

afterEach(cleanupTempDirs);

test("scanSubagentTranscript returns empty for non-existent file", () => {
  const result = scanSubagentTranscript(
    "/nonexistent/file.jsonl",
    "ses-1",
    "agent-1"
  );
  assert.deepEqual(result, { toolUses: [] });
});

test("scanSubagentTranscriptStream returns empty for non-existent file", async () => {
  const result = await scanSubagentTranscriptStream(
    "/nonexistent/file.jsonl",
    "ses-1",
    "agent-1"
  );
  assert.deepEqual(result, { toolUses: [] });
});

test("scanSubagentTranscript extracts tool_use entries", () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-1.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "tool_use",
        id: "toolu_flat_read",
        name: "Read",
        timestamp: "2025-01-15T10:00:00Z",
        input: { path: "/tmp/test.txt" },
        result: { content: "file content" },
      }),
      JSON.stringify({
        type: "tool_result",
        name: "Edit",
        timestamp: "2025-01-15T10:01:00Z",
        input: { path: "/tmp/test.txt", old_string: "foo", new_string: "bar" },
        result: { success: true },
      }),
      JSON.stringify({
        type: "notification",
        message: "some notification",
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const result = scanSubagentTranscript(fp, "ses-1", "agent-1");
  assert.equal(result.toolUses.length, 2);
  assert.equal(result.toolUses[0].toolName, "Read");
  assert.equal(result.toolUses[0].toolUseId, "toolu_flat_read");
  assert.equal(result.toolUses[0].agentId, "agent-1");
  assert.equal(result.toolUses[0].sessionId, "ses-1");
  assert.equal(result.toolUses[1].toolName, "Edit");
});

test("scanSubagentTranscriptStream handles multi-line tool_use entries", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-2.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "tool_use",
        name: "Bash",
        timestamp: "2025-01-15T10:00:00Z",
        input: { command: "ls -la" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const result = await scanSubagentTranscriptStream(fp, "ses-2", "agent-2");
  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].toolName, "Bash");
});

test("scanSubagentTranscript extracts nested Claude message tool_use blocks", () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-3.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-24T10:00:00Z",
        message: {
          content: [
            { type: "text", text: "checking" },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Read",
              input: { file_path: "src/index.ts" },
            },
          ],
        },
      }),
    ].join("\n"),
    "utf8"
  );

  const result = scanSubagentTranscript(fp, "ses-3", "agent-3");

  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].toolName, "Read");
  assert.equal(result.toolUses[0].toolUseId, "toolu_123");
  assert.equal(result.toolUses[0].timestamp, "2026-06-24T10:00:00Z");
  assert.equal(result.toolUses[0].input, '{"file_path":"src/index.ts"}');
});

test("scanSubagentTranscriptStream extracts nested Claude message tool_use blocks", async () => {
  const dir = makeTempDir("sub-");
  const fp = path.join(dir, "agent-4.jsonl");
  writeFileSync(
    fp,
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-24T10:01:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_456",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    }),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(fp, "ses-4", "agent-4");

  assert.equal(result.toolUses.length, 1);
  assert.equal(result.toolUses[0].toolName, "Bash");
  assert.equal(result.toolUses[0].toolUseId, "toolu_456");
  assert.equal(result.toolUses[0].input, '{"command":"pwd"}');
});

test("scanSubagentTranscriptStream returns no partial rows for corrupt JSONL", async () => {
  const dir = makeTempDir("sub-corrupt-");
  const fp = path.join(dir, "agent-corrupt.jsonl");
  writeFileSync(
    fp,
    [
      "{not-json",
      JSON.stringify({
        type: "tool_use",
        name: "Read",
        timestamp: "2025-01-15T10:02:00Z",
        input: { path: "/tmp/should-not-appear.txt" },
      }),
      "",
    ].join("\n"),
    "utf8"
  );

  const result = await scanSubagentTranscriptStream(fp, "ses-5", "agent-5");

  assert.deepEqual(result, { toolUses: [] });
});

// ISS-5543: `stringifyBounded` bounds the serialization, not just its result —
// a `Write`/`Edit` input carrying a whole source file must never be copied in
// full to keep 1 KB of it. A payload whose complete serialization exceeds V8's
// maximum string length proves that: the old `JSON.stringify(value).slice(...)`
// form threw `RangeError: Invalid string length` and returned null, so only a
// serializer that stops at the budget can answer with the bounded prefix.
test("stringifyBounded never materializes the whole payload", () => {
  const chunk = "x".repeat(2_000_000);
  // One 2 MB string, referenced 300×: ~600 MB serialized, 2 MB resident.
  const oversized = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`field${i}`, chunk])
  );

  const bounded = stringifyBounded(oversized);

  assert.equal(typeof bounded, "string");
  assert.equal(bounded?.length, MAX_STRINGIFIED_CHARS);
  assert.ok(bounded?.startsWith('{"field0":"xxx'));
});

test("stringifyBounded keeps the unbounded prefix byte-for-byte", () => {
  // These records reach `session.subagents[].toolUses`, which the artifact-ref
  // extractor reads, so the bounded form must emit exactly what the naive
  // serialize-then-slice emitted — same prefix, same truncation point.
  const cases: unknown[] = [
    { command: "pwd" },
    { file_path: "/tmp/a.ts", content: "a".repeat(50_000) },
    { old_string: 'b\n"c"\t'.repeat(400), new_string: "d".repeat(50_000) },
    ["e".repeat(3000), { nested: "f".repeat(3000) }],
    "g".repeat(50_000),
    null,
    42,
  ];

  for (const value of cases) {
    assert.equal(
      stringifyBounded(value),
      JSON.stringify(value).slice(0, MAX_STRINGIFIED_CHARS)
    );
  }
});

test("stringifyBounded returns null for unserializable values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.equal(stringifyBounded(undefined), null);
  assert.equal(stringifyBounded(circular), null);
  assert.equal(
    stringifyBounded(() => "noop"),
    null
  );
});

test("scanSubagentTranscript bounds an oversized tool_use input", () => {
  const dir = makeTempDir("sub-large-");
  const fp = path.join(dir, "agent-large.jsonl");
  const input = { file_path: "/tmp/big.ts", content: "z".repeat(200_000) };
  writeFileSync(
    fp,
    `${JSON.stringify({
      type: "tool_use",
      id: "toolu_large",
      name: "Write",
      timestamp: "2025-01-15T10:03:00Z",
      input,
    })}\n`,
    "utf8"
  );

  const result = scanSubagentTranscript(fp, "ses-6", "agent-6");

  assert.equal(result.toolUses.length, 1);
  assert.equal(
    result.toolUses[0].input,
    JSON.stringify(input).slice(0, MAX_STRINGIFIED_CHARS)
  );
});
