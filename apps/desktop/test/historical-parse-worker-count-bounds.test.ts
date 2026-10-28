/**
 * @file historical-parse-worker-count-bounds.test.ts
 * @description ISS-9047 — an impossible count is refused at the boundary that
 * owns the derived-session record, and at the promotion gate that borrows it.
 *
 * `normalizedSessionSchema` typed `userMessages`, `assistantMessages` and their
 * siblings as bare `z.number()`, so `-1`, `1.5`, `Infinity` and a magnitude past
 * the safe-integer range all validated. That schema is load-bearing twice:
 * it is the parse-worker's `.strict()` response validator, and ISS-8741 made it
 * the promotion gate's borrowed validator for the DATA_REVISION rebuild. An
 * impossible count therefore crossed the worker boundary AND cleared the gate,
 * landing in session metadata under a known-good stamp.
 *
 * BOTH consumers are asserted here on purpose. Pinning only the schema would
 * leave the claim "and the gate refuses it too" resting on an import rather than
 * on a behaviour — and the gate is the consumer that stamps the result trusted.
 *
 * The values are written as literals, not derived from the schema, so a test
 * that stopped policing the bound cannot move with it.
 *
 * SCOPE: the message counts AND the four other stored numbers on the same
 * record that review found still unbounded — `observedSkillCount`, the
 * `firstAttributedRecordIndex`/`observedRecordCount` ordinal pair, and
 * `modelContextWindow`. The dual-consumer claim above is asserted for the
 * message counts only; the later cases pin the worker boundary alone.
 */
import assert from "node:assert/strict";
import { LaunchThreadSource } from "@repo/lib/harness/launch-attribution";
import { describe, test } from "vitest";
import { normalizedSessionSchema } from "../src/main/collectors/engine/historical-parse-worker-session-schema.js";
import { SESSION_PROJECTION_VALIDATORS } from "../src/main/collectors/engine/session-projection-gate.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const IMPOSSIBLE_COUNTS: [string, number][] = [
  ["a negative count", -1],
  ["a fractional count", 1.5],
  ["an infinite count", Number.POSITIVE_INFINITY],
  ["a magnitude past the safe-integer range", 1e300],
];

const [sessionValidator] = SESSION_PROJECTION_VALIDATORS;
/** The field a rejected candidate must be named by, so the reason is diagnosable. */
const ASSISTANT_MESSAGES_PATTERN = /assistantMessages/;

function gateVerdict(candidate: ReturnType<typeof makePopulatedSession>) {
  if (!sessionValidator) {
    throw new Error("the session projection gate must carry a validator");
  }
  return sessionValidator.validate(candidate);
}

describe("ISS-9047: derived-session count fields are bounded", () => {
  test("a well-formed session still passes both consumers", () => {
    const candidate = makePopulatedSession();

    assert.equal(normalizedSessionSchema.safeParse(candidate).success, true);
    assert.equal(gateVerdict(candidate).valid, true);
  });

  for (const [label, value] of IMPOSSIBLE_COUNTS) {
    test(`the worker boundary refuses ${label} on userMessages`, () => {
      const candidate = makePopulatedSession({ userMessages: value });

      assert.equal(normalizedSessionSchema.safeParse(candidate).success, false);
    });

    test(`the promotion gate refuses ${label} on assistantMessages`, () => {
      const verdict = gateVerdict(
        makePopulatedSession({ assistantMessages: value })
      );

      assert.equal(verdict.valid, false);
      // The gate reports the field that failed rather than an anonymous
      // "invalid", which is what makes a rejected rebuild diagnosable.
      assert.match(verdict.reason ?? "", ASSISTANT_MESSAGES_PATTERN);
    });
  }

  // davetho + whitlockk review (PR #7220): the primary message counts were the
  // ones the first pass bounded, but the same session record carries three more
  // numbers that reach persisted metadata — the launch-attribution tally and its
  // 1-based position pair — plus the Codex context-window magnitude. Each was
  // `.int()` or `.nonnegative()` only, and `Number.isInteger(1e300)` is `true`.
  for (const [label, value] of IMPOSSIBLE_COUNTS) {
    test(`the worker boundary refuses ${label} on observedSkillCount`, () => {
      const candidate = makePopulatedSession({
        harnessLaunchAttribution: {
          threadSource: LaunchThreadSource.Unstated,
          firstAttributedSkill: "some-skill",
          observedSkillCount: value,
        },
      });

      assert.equal(normalizedSessionSchema.safeParse(candidate).success, false);
    });

    test(`the worker boundary refuses ${label} on modelContextWindow`, () => {
      const candidate = makePopulatedSession({ modelContextWindow: value });

      assert.equal(normalizedSessionSchema.safeParse(candidate).success, false);
    });
  }

  // The ordinal pair is bounded tighter than a count (1-BASED), so its
  // impossible set includes `0` on top of the four above.
  for (const [label, value] of [
    ...IMPOSSIBLE_COUNTS,
    ["a zeroth position", 0],
  ] as [string, number][]) {
    test(`the worker boundary refuses ${label} on the attribution position pair`, () => {
      const candidate = makePopulatedSession({
        harnessLaunchAttribution: {
          threadSource: LaunchThreadSource.Unstated,
          firstAttributedRecordIndex: value,
          observedRecordCount: value,
        },
      });

      assert.equal(normalizedSessionSchema.safeParse(candidate).success, false);
    });
  }

  // The opposite state on the same three subjects: a well-formed attribution and
  // a real context window still validate, so the bounds above are bounds and not
  // a schema that rejects the field outright.
  test("a well-formed attribution and context window still pass", () => {
    const candidate = makePopulatedSession({
      harnessLaunchAttribution: {
        threadSource: LaunchThreadSource.Unstated,
        firstAttributedSkill: "some-skill",
        observedSkillCount: 2,
        firstAttributedRecordIndex: 251,
        observedRecordCount: 381,
      },
      modelContextWindow: 200_000,
    });

    assert.equal(normalizedSessionSchema.safeParse(candidate).success, true);
  });

  test("a nested diffStats count is bounded too, not just the top-level pair", () => {
    const candidate = makePopulatedSession({
      diffStats: { filesChanged: 1, linesAdded: -4, linesRemoved: 0 },
    });

    assert.equal(normalizedSessionSchema.safeParse(candidate).success, false);
    assert.equal(gateVerdict(candidate).valid, false);
  });
});
