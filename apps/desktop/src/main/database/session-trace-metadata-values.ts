/**
 * @file session-trace-metadata-values.ts
 * @description Metadata-value coercions shared by the session-trace builders —
 * the narrow cluster that turns an untrusted `metadata` JSON scalar into a value
 * the cloud wire schema accepts. Extracted verbatim from `session-trace.ts`.
 *
 * The cloud parses a sync batch with ONE `safeParse` and has no per-session
 * salvage, so a single out-of-domain scalar rejects every session in the batch
 * and keeps rejecting it on every retry. Coercions that bound a value therefore
 * return `undefined` for "drop the field", never a substitute number.
 */

import { boundedNonNegativeInt } from "./db-helpers.js";

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// FEA-3267: an absent metadata LOC field stays absent; a present one is bounded
// to the cloud's int4 LOC range, yielding undefined (field omitted) when it is
// out of range.
function boundedLocFromMetadata(value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : boundedNonNegativeInt(numberFromMetadata(value));
}

function optionalNumberFromMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ISS-8566: one side of the sum, screened BEFORE it is added. An ABSENT count —
// `undefined`, the key not being there — still contributes 0, because that is the
// existing meaning of a session with only one kind of message and it must stay
// byte-identical. Anything PRESENT that is not a bounded non-negative integer
// yields undefined, which drops the whole `turns` field: the sum is then
// unknowable, and 0 would be a measurement.
//
// A JSON `null` is PRESENT (review, ISS-8566). It is a persisted value that says
// the count is unknown, not that it is zero, so it drops the field rather than
// silently contributing 0 to a sum the wire then presents as measured.
function turnCountOperand(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" ? boundedNonNegativeInt(value) : undefined;
}

// ISS-8566: `turns` lands in the same int4 SessionDetail sink as the LOC scalars
// and the cloud bounds it with `.int().nonnegative()`, so a fractional or
// out-of-int4 sum fails the cloud's single batch parse and rejects every session
// in the batch.
//
// Bounding only the SUM is not enough, because the addition launders its
// operands: `2.5 + 3.5` is 6 and `-1 + 2` is 1, both of which clear an int4
// non-negative check and ship as a plausible turn count the source never
// measured. Each operand is screened first, then the sum is bounded too — two
// in-range counts can still sum past int4.
function boundedTurnsFromMetadata(
  userMessages: unknown,
  assistantMessages: unknown
): number | undefined {
  const userTurns = turnCountOperand(userMessages);
  const assistantTurns = turnCountOperand(assistantMessages);
  if (userTurns === undefined || assistantTurns === undefined) {
    return undefined;
  }
  return boundedNonNegativeInt(userTurns + assistantTurns);
}

export {
  boundedLocFromMetadata,
  boundedTurnsFromMetadata,
  optionalNumberFromMetadata,
};
