import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTranscriptCache } from "../src/main/database/transcript.js";

const VALID_USAGE_LINE = {
  message: {
    model: "claude-3-5-sonnet-20241022",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    },
    id: "msg_001",
  },
  requestId: "req_001",
  timestamp: "2025-01-15T10:00:00Z",
};

test("createTranscriptCache returns an object with callable signature", () => {
  const cache = createTranscriptCache();
  assert.equal(typeof cache, "function");
});

test("createTranscriptCache returns null for non-existent path", () => {
  const cache = createTranscriptCache();
  const result = cache("/nonexistent/path.jsonl");
  assert.equal(result, null);
});

test("createTranscriptCache extracts tokens from a valid JSONL file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  const cache = createTranscriptCache();
  const result = cache(fp);
  assert.notEqual(result, null);
  assert.equal(result!.tokensByModel.size, 1);
  const [model, counts] = result!.tokensByModel.entries().next().value;
  assert.equal(model, "claude-3-5-sonnet-20241022");
  assert.equal(counts.input, 100);
  assert.equal(counts.output, 50);
  assert.equal(counts.cacheRead, 20);
  assert.equal(counts.cacheWrite, 5);
});

test("createTranscriptCache returns same-shape result on repeated call with unchanged stats", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  const cache = createTranscriptCache();
  const first = cache(fp);
  assert.notEqual(first, null);
  assert.equal(first!.tokensByModel.size, 1);
  const second = cache(fp);
  assert.notEqual(second, null);
  assert.deepEqual(second, first);
});

test("createTranscriptCache re-reads when mtime changes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tc-"));
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  const cache = createTranscriptCache();
  const result = cache(fp);
  assert.notEqual(result, null);

  await new Promise((r) => setTimeout(r, 1200));
  const updated = {
    ...VALID_USAGE_LINE,
    message: {
      ...VALID_USAGE_LINE.message,
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
      id: "msg_002",
    },
    requestId: "req_002",
    timestamp: "2025-01-15T10:01:00Z",
  };
  writeFileSync(fp, `${JSON.stringify(updated)}\n`, "utf8");
  const result2 = cache(fp);
  assert.notEqual(result2, null);
  const [, counts] = result2!.tokensByModel.entries().next().value;
  assert.equal(counts.input, 200);
  assert.equal(counts.output, 100);
});
