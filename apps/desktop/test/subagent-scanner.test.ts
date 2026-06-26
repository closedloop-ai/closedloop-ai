import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  scanSubagentTranscript,
  scanSubagentTranscriptStream,
} from "../src/main/collectors/subagent-scanner.js";

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
  const dir = mkdtempSync(path.join(os.tmpdir(), "sub-"));
  const fp = path.join(dir, "agent-1.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "tool_use",
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
  assert.equal(result.toolUses[0].agentId, "agent-1");
  assert.equal(result.toolUses[0].sessionId, "ses-1");
  assert.equal(result.toolUses[1].toolName, "Edit");
});

test("scanSubagentTranscriptStream handles multi-line tool_use entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sub-"));
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
  await rm(dir, { recursive: true, force: true });
});
