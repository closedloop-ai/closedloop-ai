import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSessionTraceSyncFields } from "../src/main/database/session-trace.js";
import { baseSessionTraceInput as baseInput } from "./session-trace-test-utils.js";

// ISS-8566 §3: `turns` was the unclamped twin of the three flat LOC scalars it
// sits beside. The cloud declares it `.int().nonnegative()` and stores it in an
// int4 column, and apps/api safeParses the WHOLE sync batch with no per-session
// salvage — so one fractional or out-of-int4 metadata blob rejected every
// session in the batch, on the first attempt and on every retry. The contract is
// the same as its neighbours': drop the FIELD, not the sync.
//
// These assert the emitted payload from `buildSessionTraceSyncFields`, not the
// coercion helper, because the wire shape is what the cloud parses.

function turnsPayload(
  userMessages: unknown,
  assistantMessages: unknown
): ReturnType<typeof buildSessionTraceSyncFields> {
  return buildSessionTraceSyncFields(
    baseInput({ metadata: { userMessages, assistantMessages } })
  );
}

test("a fractional message count drops turns rather than shipping 5.5", () => {
  const fields = turnsPayload(3, 2.5);
  assert.equal("turns" in fields, false);
  assert.notEqual(fields.turns, 5.5);
});

test("an out-of-int4 message count drops turns", () => {
  assert.equal("turns" in turnsPayload(3, 1e20), false);
});

test("a negative message count drops turns", () => {
  assert.equal("turns" in turnsPayload(-5, 1), false);
});

test("an ordinary integer pair still emits the summed turns", () => {
  const fields = turnsPayload(3, 4);
  assert.equal("turns" in fields, true);
  assert.equal(fields.turns, 7);
});

test("a zero-turn session still emits no turns key", () => {
  assert.equal("turns" in turnsPayload(0, 0), false);
  assert.equal(
    "turns" in buildSessionTraceSyncFields(baseInput({ metadata: {} })),
    false
  );
});

// ISS-8566 review (whitlockk): bounding only the SUM lets the addition launder its
// operands — two fractions can sum to an integer and a negative can cancel
// against a positive — so a count the source never measured passes the int4
// non-negative check and ships as a plausible measurement.

test("a fractional pair that sums to an integer drops turns rather than shipping 6", () => {
  const fields = turnsPayload(2.5, 3.5);
  assert.equal("turns" in fields, false);
  assert.notEqual(fields.turns, 6);
});

test("a negative count cancelled by a positive one drops turns rather than shipping 1", () => {
  const fields = turnsPayload(-1, 2);
  assert.equal("turns" in fields, false);
  assert.notEqual(fields.turns, 1);
});

test("a present non-numeric count drops turns rather than reading as 0", () => {
  assert.equal("turns" in turnsPayload("3", 4), false);
});

test("an absent count still contributes 0 to its present sibling", () => {
  const fields = buildSessionTraceSyncFields(
    baseInput({ metadata: { assistantMessages: 4 } })
  );
  assert.equal(fields.turns, 4);
});

test("a JSON null count drops turns rather than contributing 0 to the sum", () => {
  // Review (davetho): `null` is a PRESENT persisted value meaning the count is
  // unknown, not zero. Mixed with a real sibling it would otherwise ship 4 as a
  // measured turn total built from one operand.
  const fields = turnsPayload(null, 4);
  assert.equal("turns" in fields, false);
  assert.notEqual(fields.turns, 4);
});
