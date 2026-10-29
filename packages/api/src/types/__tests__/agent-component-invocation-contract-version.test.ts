/**
 * ISS-7580 (@whitlockk review): the shared reading of a stored
 * `normalizer_contract_version` cell, pinned against the wire constraint it
 * exists to mirror.
 *
 * The rejected set is the interesting half. A blank or whitespace cell is a
 * FINITE ZERO through `Number`, so a finite check alone — the obvious reading —
 * still emits version `0`, and `0` is not a version any normalizer has emitted.
 * Zero, negative, and fractional are as invalid as `NaN` under
 * `z.number().int().positive()`, and every one of them makes the strict boundary
 * reject the whole part rather than the one field.
 */
import { describe, expect, it } from "vitest";
import { agentComponentInvocationContractVersion } from "../agent-component-invocation";
import { agentComponentInvocationSyncItemSchema } from "../agent-component-invocation-schema";
import { PR_INT_MAX } from "../session-artifact-link";

const VERSION_FIELD =
  agentComponentInvocationSyncItemSchema.shape.normalizerContractVersion;

describe("agentComponentInvocationContractVersion", () => {
  it.each([
    ["a plain integer", 7, 7],
    ["a bigint from an INTEGER column", 7n, 7],
    ["a numeric TEXT cell", "7", 7],
    ["exactly the int4 ceiling", PR_INT_MAX, PR_INT_MAX],
  ])("keeps %s", (_label, input, expected) => {
    expect(
      agentComponentInvocationContractVersion(input as number | bigint | string)
    ).toBe(expected);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a blank cell", ""],
    ["a whitespace cell", "   "],
    ["corrupt text", "n/a"],
    ["zero", 0],
    ["a negative", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    // ISS-8329 (whitlockk review): the column is int4, so a value above it makes
    // the strict boundary reject the whole PART, not just this field. A
    // `bigint` above the ceiling is exactly what a raw SQLite read hands back.
    ["an int4 overflow", PR_INT_MAX + 1],
    ["an int4 overflow as bigint", BigInt(PR_INT_MAX) + 1n],
    ["an int4 overflow as TEXT", String(PR_INT_MAX + 1)],
  ])("omits %s", (_label, input) => {
    expect(
      agentComponentInvocationContractVersion(
        input as number | bigint | string | null | undefined
      )
    ).toBeUndefined();
  });

  it("accepts exactly what the wire field accepts", () => {
    for (const candidate of [
      1,
      2,
      7,
      0,
      -1,
      1.5,
      Number.NaN,
      PR_INT_MAX,
      PR_INT_MAX + 1,
    ]) {
      const kept = agentComponentInvocationContractVersion(candidate);
      // The parser is not allowed to be more permissive than the schema it
      // mirrors: anything it keeps must survive the field's own validation.
      expect(VERSION_FIELD.safeParse(kept).success).toBe(true);
    }
  });
});
