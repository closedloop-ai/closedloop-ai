import assert from "node:assert/strict";
import { test } from "vitest";
import { createHistoricalWorkerStderrSummarizer } from "../src/main/collectors/engine/historical-parse-worker-diagnostics.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  WORKER_STDERR_REDACTED_PATH_PATTERN,
  WORKER_STDERR_REDACTED_SECRET_PATTERN,
  WORKER_STDERR_RELATIVE_CONTEXT_PATTERN,
  WORKER_STDERR_SUMMARY_PATTERN,
  WORKER_STDERR_SUMMARY_PREFIX_PATTERN,
  WORKER_STDERR_TRUNCATION_PATTERN,
  WORKER_STDERR_WARNING_PATTERN,
} from "./historical-parse-worker-response-support.js";

/**
 * The accumulator is the ONLY production entry point — the runner's stderr pipe
 * calls it, and a lone `data` event is not a record boundary. The trailing
 * newline makes each fixture one complete run, so what is asserted here is what
 * the runner would log rather than a shape no caller produces.
 */
function summarizeStderr(text: string): string | null {
  return createHistoricalWorkerStderrSummarizer().push(
    Buffer.from(`${text}\n`)
  );
}

test("historical parse worker stderr summary includes a sanitized preview", () => {
  const summary = summarizeStderr(
    [
      "Warning: parse failed at /Users/alice/private/transcript.jsonl:42",
      "OPENAI_API_KEY=secret-value",
      "relative-parser.ts: retrying",
    ].join("\n")
  );

  assert.ok(summary);
  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(summary, WORKER_STDERR_WARNING_PATTERN);
  assert.match(summary, WORKER_STDERR_REDACTED_PATH_PATTERN);
  assert.match(summary, WORKER_STDERR_REDACTED_SECRET_PATTERN);
  assert.match(summary, WORKER_STDERR_RELATIVE_CONTEXT_PATTERN);
  assert.equal(summary.includes("secret-value"), false);
  assert.equal(summary.includes("/Users/alice"), false);
  assert.equal(summary.includes("private/transcript"), false);
});

test("historical parse worker stderr preview is byte bounded", () => {
  const summary = summarizeStderr(`Warning: ${"x".repeat(2000)}`);
  assert.ok(summary);
  const preview = summary.replace(WORKER_STDERR_SUMMARY_PREFIX_PATTERN, "");

  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(preview, WORKER_STDERR_TRUNCATION_PATTERN);
  assert.equal(
    Buffer.byteLength(preview, "utf8") <=
      HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes,
    true
  );
});

test("historical parse worker stderr summary suppresses standalone SQLite experimental warning", () => {
  const summary = summarizeStderr(
    [
      "(node:41402) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
      "(Use `Electron Helper --trace-warnings ...` to show where the warning was created)",
    ].join("\n")
  );

  assert.equal(summary, null);
});

test("historical parse worker stderr summary keeps mixed warning output", () => {
  const summary = summarizeStderr(
    [
      "(node:41402) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
      "Warning: parse failed at /Users/alice/private/transcript.jsonl:42",
    ].join("\n")
  );

  assert.ok(summary);
  assert.match(summary, WORKER_STDERR_SUMMARY_PATTERN);
  assert.match(summary, WORKER_STDERR_WARNING_PATTERN);
  assert.equal(summary.includes("/Users/alice"), false);
});
