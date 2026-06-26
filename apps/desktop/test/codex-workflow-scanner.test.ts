import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  findWorkflowJournals,
  scanWorkflowJournal,
} from "../src/main/collectors/codex-workflow-scanner.js";

const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

test("findWorkflowJournals returns empty for non-existent directory", () => {
  const result = findWorkflowJournals("/nonexistent/dir");
  assert.deepEqual(result, []);
});

test("findWorkflowJournals finds workflow-*.jsonl files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  writeFileSync(path.join(dir, "workflow-abc123.jsonl"), "", "utf8");
  writeFileSync(path.join(dir, "rollout-session.jsonl"), "", "utf8");
  writeFileSync(path.join(dir, "workflow-xyz789.jsonl"), "", "utf8");
  const result = findWorkflowJournals(dir);
  assert.equal(result.length, 2);
  assert.ok(result[0].endsWith("workflow-abc123.jsonl"));
  assert.ok(result[1].endsWith("workflow-xyz789.jsonl"));
});

test("findWorkflowJournals ignores non-workflow jsonl and non-jsonl files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  writeFileSync(path.join(dir, "workflow-test.jsonl"), "", "utf8");
  writeFileSync(path.join(dir, "other.log"), "", "utf8");
  writeFileSync(path.join(dir, "data.txt"), "", "utf8");
  const result = findWorkflowJournals(dir);
  assert.equal(result.length, 1);
});

test("scanWorkflowJournal returns empty for invalid file", async () => {
  const result = await scanWorkflowJournal("/nonexistent/file.jsonl");
  assert.deepEqual(result, {
    entries: [],
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
  });
});

test("scanWorkflowJournal extracts token usage entries", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const fp = path.join(dir, "workflow-test.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "usage",
        model: "gpt-4",
        tokens_input: 100,
        tokens_output: 50,
        tokens_cache_read: 20,
        tokens_cache_creation: 10,
        session_id: "inner-ses-1",
      }),
      JSON.stringify({
        type: "token_usage",
        model: "gpt-4",
        tokens_input: 200,
        tokens_output: 100,
        session_id: "inner-ses-2",
      }),
      JSON.stringify({
        type: "heartbeat",
        timestamp: "2025-01-15T10:00:00Z",
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const result = await scanWorkflowJournal(fp);
  assert.equal(result.entries.length, 2);
  assert.equal(result.totalInput, 300);
  assert.equal(result.totalOutput, 150);
  assert.equal(result.totalCacheRead, 20);
  assert.equal(result.totalCacheWrite, 10);
});

test("scanWorkflowJournal preserves large token counters exactly", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const fp = path.join(dir, "workflow-large.jsonl");
  writeFileSync(
    fp,
    `${JSON.stringify({
      type: "usage",
      model: "gpt-4",
      tokens_input: 100,
      tokens_output: 50,
      tokens_cache_read: LARGE_CACHE_READ_TOKENS,
      tokens_cache_creation: 10,
      session_id: "inner-large",
    })}\n`,
    "utf8"
  );

  const result = await scanWorkflowJournal(fp);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].cacheRead, LARGE_CACHE_READ_TOKENS);
  assert.equal(result.totalCacheRead, LARGE_CACHE_READ_TOKENS);
});

test("scanWorkflowJournal rejects unsafe token counters", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const fp = path.join(dir, "workflow-unsafe.jsonl");
  writeFileSync(
    fp,
    `${JSON.stringify({
      type: "usage",
      model: "gpt-4",
      tokens_input: Number.MAX_SAFE_INTEGER + 1,
      tokens_output: 50,
    })}\n`,
    "utf8"
  );

  await assert.rejects(() => scanWorkflowJournal(fp));
});

test("scanWorkflowJournal handles nested usage object", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wf-"));
  const fp = path.join(dir, "workflow-nested.jsonl");
  writeFileSync(
    fp,
    [
      JSON.stringify({
        type: "run",
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
        model: "gpt-4o",
      }),
      "",
    ].join("\n"),
    "utf8"
  );
  const result = await scanWorkflowJournal(fp);
  assert.equal(result.entries.length, 1);
  assert.equal(result.totalInput, 50);
  assert.equal(result.totalOutput, 25);
  assert.equal(result.totalCacheRead, 5);
  assert.equal(result.totalCacheWrite, 2);
});
