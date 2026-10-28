/**
 * @file retry-after-header.test.ts
 * @description ISS-8689: `parseRetryAfterMs`, the parse behind PRD-699 F7.
 *
 * The header is the ONLY thing that separates a bucket-unset 503 from a
 * transient one, so what this parser refuses matters as much as what it
 * accepts: every `undefined` below is a value the lane must fall back to its
 * own staged schedule on, never a stand-down it invented from something it
 * could not read.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { parseRetryAfterMs } from "../src/main/transcript/retry-after-header.js";

const NOW_MS = Date.parse("2026-07-09T00:00:00.000Z");

test("ISS-8689: delta-seconds parses to milliseconds", () => {
  assert.equal(parseRetryAfterMs("60", NOW_MS), 60_000);
  assert.equal(parseRetryAfterMs("3600", NOW_MS), 3_600_000);
  assert.equal(
    parseRetryAfterMs("  120  ", NOW_MS),
    120_000,
    "surrounding whitespace is not a malformed header"
  );
});

test("ISS-8689: a zero delta is a real instruction, not an absent one", () => {
  // 0 and `undefined` mean opposite things downstream — one is "retry now", the
  // other is "the server told me nothing". Collapsing them would be the same
  // conflation the lane exists to avoid; the caller's own floor decides whether
  // an immediate retry is honored.
  assert.equal(parseRetryAfterMs("0", NOW_MS), 0);
});

test("ISS-8689: the HTTP-date form resolves against the caller's clock", () => {
  assert.equal(
    parseRetryAfterMs("Wed, 09 Jul 2026 01:00:00 GMT", NOW_MS),
    3_600_000,
    "an hour out is an hour's wait"
  );
});

test("ISS-8689: an HTTP-date already in the past is an elapsed wait, not a rejection", () => {
  // Clock skew and queueing both produce this. It is 0 — "the wait is over" —
  // and must not come back as a negative that a later comparison would read as
  // unparseable, nor as `undefined`, which would discard a header we understood.
  assert.equal(parseRetryAfterMs("Tue, 08 Jul 2026 23:00:00 GMT", NOW_MS), 0);
});

test("ISS-8689: an unreadable header is undefined, never a guessed wait", () => {
  for (const header of [
    null,
    undefined,
    "",
    "   ",
    "soon",
    "-5",
    "1.5",
    "NaN",
    "60s",
    "Retry-After: 60",
  ]) {
    assert.equal(
      parseRetryAfterMs(header, NOW_MS),
      undefined,
      `"${String(header)}" is not a wait this lane can honor`
    );
  }
});

test("ISS-8689: an absurd delta is refused rather than clamped", () => {
  // A year of delta-seconds is not an instruction a transcript lane should act
  // on, and silently clamping it to the ceiling would let a broken or hostile
  // server pin every row at the maximum wait while looking like a normal parse.
  assert.equal(parseRetryAfterMs("31536000", NOW_MS), undefined);
  assert.equal(
    parseRetryAfterMs("Fri, 09 Jul 2027 00:00:00 GMT", NOW_MS),
    undefined
  );
});
