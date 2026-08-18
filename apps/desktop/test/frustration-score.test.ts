/**
 * @file frustration-score.test.ts
 * @description FEA-3928 — unit tests for the pure versioned scoring primitive
 * `computeFrustrationRaw` (apps/desktop/src/shared/frustration-score.ts).
 * Locks the contract the schema column (SessionDetail.frustration_raw) and the
 * later sync/Insights slices depend on: a high-frustration transcript scores
 * above a calm one above an empty one; the signal is monotonic in each input
 * (language, nearby errors, and every trace signal); it floors at 0; every
 * contribution and the final sum are non-negative int4-safe integers (fractions
 * floor, and the sum saturates at int4 max so it can never overflow the
 * persisted column); and it is UNBOUNDED-at-100 — a very noisy transcript
 * exceeds 100 raw and is NOT clamped, since the population-relative 0–100
 * normalization is a downstream concern. Also pins that the shared-contract
 * `FRUSTRATION_SCORE_VERSION` (@repo/api) is a positive integer. Deterministic
 * (no timers, no wall clock), per the desktop test:node determinism rule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRUSTRATION_RAW_MAX,
  FRUSTRATION_SCORE_VERSION,
} from "@repo/api/src/frustration-score-contract";
import {
  type ComputeFrustrationRawInput,
  computeFrustrationRaw,
  deriveFrustrationInput,
} from "../src/shared/frustration-score.js";

const ERROR_EVENT = { eventType: "tool_error" } as const;
const NEUTRAL_EVENT = { eventType: "assistant_message" } as const;

function turn(text: string, index = 0) {
  return { index, text };
}

test("FRUSTRATION_SCORE_VERSION contract is a positive integer", () => {
  assert.equal(typeof FRUSTRATION_SCORE_VERSION, "number");
  assert.ok(Number.isInteger(FRUSTRATION_SCORE_VERSION));
  assert.ok(FRUSTRATION_SCORE_VERSION >= 1);
});

test("empty input scores 0", () => {
  assert.equal(computeFrustrationRaw({ events: [], userTurns: [] }), 0);
});

test("a high-frustration transcript scores above a calm one above empty", () => {
  const empty = computeFrustrationRaw({ events: [], userTurns: [] });
  const calm = computeFrustrationRaw({
    events: [NEUTRAL_EVENT],
    userTurns: [turn("thanks, please continue when you can")],
  });
  const frustrated = computeFrustrationRaw({
    events: [ERROR_EVENT, NEUTRAL_EVENT, ERROR_EVENT],
    userTurns: [
      turn("STOP. this is STILL broken, revert it — WHY?? seriously??", 1),
    ],
    trace: {
      steeringEpisodes: 3,
      correctionCount: 2,
      phaseLoopbacks: 1,
      throttles: 1,
    },
  });
  assert.ok(frustrated > calm, `${frustrated} > ${calm}`);
  assert.ok(calm > empty, `${calm} > ${empty}`);
});

test("monotonic in the language signal (more frustration words never lowers)", () => {
  const base = computeFrustrationRaw({
    events: [],
    userTurns: [turn("please stop")],
  });
  const more = computeFrustrationRaw({
    events: [],
    userTurns: [turn("please stop, this is wrong and broken, revert it")],
  });
  assert.ok(more > base, `${more} > ${base}`);
});

test("monotonic in nearby error events", () => {
  const events = [ERROR_EVENT, NEUTRAL_EVENT, ERROR_EVENT];
  const withoutErrors = computeFrustrationRaw({
    events: [NEUTRAL_EVENT, NEUTRAL_EVENT, NEUTRAL_EVENT],
    userTurns: [turn("stop", 1)],
  });
  const withErrors = computeFrustrationRaw({
    events,
    userTurns: [turn("stop", 1)],
  });
  assert.ok(withErrors > withoutErrors, `${withErrors} > ${withoutErrors}`);
});

test("monotonic in each trace signal independently", () => {
  const baseInput: ComputeFrustrationRawInput = {
    events: [],
    userTurns: [turn("ok")],
    trace: {
      steeringEpisodes: 0,
      correctionCount: 0,
      phaseLoopbacks: 0,
      throttles: 0,
    },
  };
  const base = computeFrustrationRaw(baseInput);
  const signals = [
    "steeringEpisodes",
    "correctionCount",
    "phaseLoopbacks",
    "throttles",
  ] as const;
  for (const signal of signals) {
    const bumped = computeFrustrationRaw({
      ...baseInput,
      trace: { ...baseInput.trace, [signal]: 4 },
    });
    assert.ok(
      bumped > base,
      `bumping ${signal} raised the score (${bumped} > ${base})`
    );
  }
});

test("floors at 0 for negative or non-finite trace counts", () => {
  const score = computeFrustrationRaw({
    events: [],
    userTurns: [],
    trace: {
      steeringEpisodes: -100,
      correctionCount: Number.NaN,
      phaseLoopbacks: Number.NEGATIVE_INFINITY,
      throttles: -3,
    },
  });
  assert.equal(score, 0);
});

test("fractional trace counts floor to an integer (never a fractional int4 value)", () => {
  const score = computeFrustrationRaw({
    events: [],
    userTurns: [],
    trace: {
      steeringEpisodes: 0.5,
      correctionCount: 2.9,
      phaseLoopbacks: 1.4,
      throttles: 0.99,
    },
  });
  // 0.5→0, 2.9→2, 1.4→1, 0.99→0 = 3, and it is an exact integer.
  assert.equal(score, 3);
  assert.ok(Number.isInteger(score));
});

test("raw signal saturates at int4 max — a giant contribution cannot overflow the persisted column", () => {
  const score = computeFrustrationRaw({
    events: [],
    userTurns: [],
    trace: {
      steeringEpisodes: FRUSTRATION_RAW_MAX,
      correctionCount: FRUSTRATION_RAW_MAX,
      phaseLoopbacks: 1,
      throttles: 1,
    },
  });
  // Two int4-max contributions plus more must saturate, not wrap or exceed int4.
  assert.equal(score, FRUSTRATION_RAW_MAX);
  assert.ok(Number.isInteger(score));
});

test("a single over-int4 contribution is capped at int4 max", () => {
  const score = computeFrustrationRaw({
    events: [],
    userTurns: [],
    trace: { steeringEpisodes: FRUSTRATION_RAW_MAX + 1000 },
  });
  assert.equal(score, FRUSTRATION_RAW_MAX);
});

test("absent trace signals contribute 0 (undefined/null degrade to safe default)", () => {
  const noTrace = computeFrustrationRaw({
    events: [],
    userTurns: [turn("stop")],
  });
  const nullTrace = computeFrustrationRaw({
    events: [],
    userTurns: [turn("stop")],
    trace: {
      steeringEpisodes: null,
      correctionCount: null,
      phaseLoopbacks: null,
      throttles: null,
    },
  });
  assert.equal(noTrace, nullTrace);
});

test("raw signal is UNBOUNDED — a very noisy transcript exceeds 100 and is not clamped", () => {
  const noisyTurns = Array.from({ length: 60 }, (_unused, index) =>
    turn("STOP STOP this is BROKEN and WRONG, revert it!! please!!", index * 2)
  );
  const noisyEvents = Array.from({ length: 120 }, () => ERROR_EVENT);
  const score = computeFrustrationRaw({
    events: noisyEvents,
    userTurns: noisyTurns,
    trace: {
      steeringEpisodes: 50,
      correctionCount: 50,
      phaseLoopbacks: 50,
      throttles: 50,
    },
  });
  assert.ok(score > 100, `expected unbounded raw signal > 100, got ${score}`);
});

test("is deterministic — identical input yields identical output", () => {
  const input: ComputeFrustrationRawInput = {
    events: [ERROR_EVENT, NEUTRAL_EVENT],
    userTurns: [turn("STOP this is broken??", 0)],
    trace: { steeringEpisodes: 2, correctionCount: 1 },
  };
  assert.equal(computeFrustrationRaw(input), computeFrustrationRaw(input));
});

// FEA-4022: deriveFrustrationInput turns raw session-event rows + trace-signal
// counts into the computeFrustrationRaw input the desktop sync-source assembly
// feeds it. Pins that user turns are extracted (by event type + non-empty text
// from summary, falling back to data), that non-user / empty-text events are
// skipped, and that the event indices are preserved so nearby-error windows land.
test("deriveFrustrationInput extracts user turns and preserves event indices", () => {
  const events = [
    { eventType: "assistant_message", summary: "sure" }, // index 0 — not a user turn
    { eventType: "UserPromptSubmit", summary: "STOP this is broken??" }, // index 1
    { eventType: "tool_error", summary: null }, // index 2 — nearby error
    { eventType: "user_prompt", summary: "", data: "please revert" }, // index 3 — data fallback
    { eventType: "user_prompt", summary: "   " }, // index 4 — blank → skipped
  ];
  const input = deriveFrustrationInput(events);
  assert.equal(input.events, events);
  assert.deepEqual(
    input.userTurns.map((t) => t.index),
    [1, 3]
  );
  assert.equal(input.userTurns[0].text, "STOP this is broken??");
  assert.equal(input.userTurns[1].text, "please revert");
});

test("deriveFrustrationInput forwards trace-signal counts to the scorer", () => {
  const trace = {
    steeringEpisodes: 3,
    correctionCount: 2,
    phaseLoopbacks: 1,
    throttles: 4,
  };
  const input = deriveFrustrationInput(
    [{ eventType: "assistant_message", summary: "ok" }],
    trace
  );
  assert.equal(input.trace, trace);
  // A calm session with no user turns still scores its trace-signal counts.
  assert.equal(computeFrustrationRaw(input), 3 + 2 + 1 + 4);
});

test("deriveFrustrationInput yields 0 for a calm, turn-less session", () => {
  const input = deriveFrustrationInput([
    { eventType: "assistant_message", summary: "done" },
  ]);
  assert.equal(computeFrustrationRaw(input), 0);
});
