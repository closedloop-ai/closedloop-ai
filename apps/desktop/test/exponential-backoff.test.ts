/**
 * @file exponential-backoff.test.ts
 * @description FEA-3795: unit coverage for the shared exponential-backoff ladder
 * (`exponentialBackoffMs`) that now backs BOTH the transcript-sync file retry
 * schedule and the agent-session dead-letter retry schedule. Asserts the base,
 * doubling, cap, monotonicity, defensive count-clamp, and overflow-safety, plus
 * that both call sites delegate to the shared helper (SSOT).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEAD_LETTER_RETRY_BASE_MS,
  DEAD_LETTER_RETRY_MAX_MS,
  deadLetterRetryDelayMs,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  TRANSCRIPT_SYNC_RETRY_BASE_MS,
  TRANSCRIPT_SYNC_RETRY_MAX_MS,
  transcriptRetryDelayMs,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { exponentialBackoffMs } from "../src/shared/exponential-backoff.js";

const BASE = 1000;
const MAX = 60_000;

test("exponentialBackoffMs: attempt 1 returns the base", () => {
  assert.equal(exponentialBackoffMs(1, BASE, MAX), BASE);
});

test("exponentialBackoffMs: each attempt doubles until the cap", () => {
  assert.equal(exponentialBackoffMs(2, BASE, MAX), BASE * 2);
  assert.equal(exponentialBackoffMs(3, BASE, MAX), BASE * 4);
  assert.equal(exponentialBackoffMs(4, BASE, MAX), BASE * 8);
});

test("exponentialBackoffMs: clamps at maxMs and stays there (monotonic)", () => {
  let previous = 0;
  let reachedCap = false;
  for (let count = 1; count <= 40; count += 1) {
    const delay = exponentialBackoffMs(count, BASE, MAX);
    assert.ok(delay <= MAX, `attempt ${count} never exceeds the cap`);
    assert.ok(delay >= previous, `attempt ${count} never regresses`);
    if (delay === MAX) {
      reachedCap = true;
    }
    previous = delay;
  }
  assert.ok(reachedCap, "the schedule eventually reaches the cap");
});

test("exponentialBackoffMs: a non-positive or fractional count behaves like the first attempt", () => {
  assert.equal(exponentialBackoffMs(0, BASE, MAX), BASE);
  assert.equal(exponentialBackoffMs(-5, BASE, MAX), BASE);
  // A fractional count floors to the same integer attempt.
  assert.equal(
    exponentialBackoffMs(2.9, BASE, MAX),
    exponentialBackoffMs(2, BASE, MAX)
  );
});

test("exponentialBackoffMs: a huge count stays clamped at the cap (no overflow to Infinity)", () => {
  const delay = exponentialBackoffMs(1000, BASE, MAX);
  assert.equal(delay, MAX);
  assert.ok(Number.isFinite(delay), "the delay never overflows to Infinity");
});

test("exponentialBackoffMs: transcriptRetryDelayMs delegates to the shared ladder", () => {
  for (const count of [1, 2, 3, 5, 8, 40, 1000]) {
    assert.equal(
      transcriptRetryDelayMs(count),
      exponentialBackoffMs(
        count,
        TRANSCRIPT_SYNC_RETRY_BASE_MS,
        TRANSCRIPT_SYNC_RETRY_MAX_MS
      ),
      `transcriptRetryDelayMs(${count}) matches the shared ladder`
    );
  }
});

test("exponentialBackoffMs: deadLetterRetryDelayMs delegates to the shared ladder", () => {
  for (const count of [0, 1, 2, 3, 5, 8, 40, 1000]) {
    assert.equal(
      deadLetterRetryDelayMs(count),
      exponentialBackoffMs(
        count,
        DEAD_LETTER_RETRY_BASE_MS,
        DEAD_LETTER_RETRY_MAX_MS
      ),
      `deadLetterRetryDelayMs(${count}) matches the shared ladder`
    );
  }
});
