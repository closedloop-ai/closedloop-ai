import assert from "node:assert/strict";
import { appendFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { claudeTranscriptEntryUuidScheme } from "@repo/lib/harness/usage-dedup";
import { test } from "vitest";
import { createTranscriptCache } from "../src/main/database/transcript.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeTempDir } = createTempDirManager("tc-");

/**
 * The two mtimes the rewrite test pins, rather than sleeping and hoping the
 * filesystem's granularity is fine enough to notice. The rewrite is exactly two
 * bytes longer than the original, so a same-mtime stat sends transcript.ts down
 * its incremental branch, which reads only those two bytes and re-counts
 * nothing — the assertion below would then see the ORIGINAL token totals.
 */
const FIRST_MTIME = new Date("2025-01-15T10:00:00Z");
const SECOND_MTIME = new Date("2025-01-15T10:01:00Z");

const VALID_USAGE_LINE = {
  uuid: "00000000-0000-4000-8000-000000000001",
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
  const dir = makeTempDir();
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  const cache = createTranscriptCache();
  const result = cache(fp);
  assert.notEqual(result, null);
  assert.equal(result!.tokensByModel.size, 1);
  // `IteratorResult#value` is `undefined` on a spent iterator, so prove the
  // first entry exists rather than destructuring a possibly-absent tuple.
  const firstEntry = result!.tokensByModel.entries().next().value;
  if (!firstEntry) {
    throw new Error("expected tokensByModel to hold one model entry");
  }
  const [model, counts] = firstEntry;
  assert.equal(model, "claude-3-5-sonnet-20241022");
  assert.equal(counts.input, 100);
  assert.equal(counts.output, 50);
  assert.equal(counts.cacheRead, 20);
  assert.equal(counts.cacheWrite, 5);
  assert.deepEqual(result!.records[0]?.sourceIdentity, {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: claudeTranscriptEntryUuidScheme,
    sourceRecordIds: [VALID_USAGE_LINE.uuid],
  });
});

test("createTranscriptCache returns same-shape result on repeated call with unchanged stats", () => {
  const dir = makeTempDir();
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

test("createTranscriptCache preserves and extends UUID evidence on incremental reads", () => {
  const dir = makeTempDir();
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  // A whole-ms mtime, so the reset below equals the cached one and the
  // incremental branch runs.
  utimesSync(fp, FIRST_MTIME, FIRST_MTIME);
  const cache = createTranscriptCache();
  const first = cache(fp);
  assert.notEqual(first, null);

  const appended = {
    ...VALID_USAGE_LINE,
    uuid: "00000000-0000-4000-8000-000000000002",
    timestamp: "2025-01-15T10:00:01Z",
  };
  appendFileSync(fp, `${JSON.stringify(appended)}\n`, "utf8");
  utimesSync(fp, FIRST_MTIME, FIRST_MTIME);

  const second = cache(fp);
  assert.deepEqual(second?.records[0]?.sourceIdentity, {
    availability: TokenSourceIdentityAvailability.Available,
    scheme: claudeTranscriptEntryUuidScheme,
    sourceRecordIds: [VALID_USAGE_LINE.uuid, appended.uuid],
  });
});

test("createTranscriptCache re-reads when mtime changes", () => {
  const dir = makeTempDir();
  const fp = path.join(dir, "session.jsonl");
  writeFileSync(fp, `${JSON.stringify(VALID_USAGE_LINE)}\n`, "utf8");
  utimesSync(fp, FIRST_MTIME, FIRST_MTIME);
  const cache = createTranscriptCache();
  const result = cache(fp);
  assert.notEqual(result, null);

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
  utimesSync(fp, SECOND_MTIME, SECOND_MTIME);
  const result2 = cache(fp);
  assert.notEqual(result2, null);
  const refreshedEntry = result2!.tokensByModel.entries().next().value;
  if (!refreshedEntry) {
    throw new Error("expected tokensByModel to hold one model entry");
  }
  const [, counts] = refreshedEntry;
  assert.equal(counts.input, 200);
  assert.equal(counts.output, 100);
});
