import { describe, expect, it } from "vitest";
import {
  booleanOrFallback,
  booleanRecordOrFallback,
  stringMembersOrEmpty,
  stringUnionOrFallback,
} from "../local-storage-validators";

/** Every JSON type a stored value can be, none of which is the expected shape. */
const MALFORMED_JSON_VALUES = [
  5,
  null,
  "text",
  true,
  { a: 1 },
  [1, 2],
] as const;

describe("booleanOrFallback", () => {
  it("returns a stored true and a stored false unchanged", () => {
    // `false` is the case a `value === true` implementation gets wrong. At the
    // dev-mode switch that flips a deliberate customer-view choice back to the
    // internal view, behind a rollout gate that hides the way out.
    expect(booleanOrFallback(true, false)).toBe(true);
    expect(booleanOrFallback(false, true)).toBe(false);
  });

  it("returns the caller's fallback for every non-boolean, either polarity", () => {
    for (const value of [5, null, "text", { a: 1 }, [1]]) {
      expect(booleanOrFallback(value, true)).toBe(true);
      expect(booleanOrFallback(value, false)).toBe(false);
    }
  });
});

describe("stringMembersOrEmpty", () => {
  it("returns an all-string array's members", () => {
    expect(stringMembersOrEmpty(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("drops non-string members rather than the whole array", () => {
    // The mutation this kills: an `Array.isArray`-only guard. A stored [1,2]
    // compares equal to no string key, so it reads as "nothing toggled" silently.
    expect(stringMembersOrEmpty([1, "a", null, "b"], [])).toEqual(["a", "b"]);
  });

  it("reaches the fallback ONLY for a non-array, never for a bad member", () => {
    // The split contract. Indistinguishable where the fallback is itself [], which
    // is why this case uses a non-empty one.
    const fallback = ["seed"];
    expect(stringMembersOrEmpty(5, fallback)).toBe(fallback);
    expect(stringMembersOrEmpty({ a: 1 }, fallback)).toBe(fallback);
    expect(stringMembersOrEmpty(null, fallback)).toBe(fallback);
    expect(stringMembersOrEmpty([1, 2], fallback)).toEqual([]);
  });
});

describe("booleanRecordOrFallback", () => {
  const FALLBACK = { alpha: true, beta: false };

  it("returns an all-boolean record BY IDENTITY", () => {
    // Identity, not equality: the hook caches this result and useSyncExternalStore
    // requires a stable reference, so a validator that rebuilt the object would
    // still pass toEqual while breaking the snapshot contract.
    const stored = { alpha: false, beta: true };
    expect(booleanRecordOrFallback(stored, FALLBACK)).toBe(stored);
  });

  it("keeps a legitimately PARTIAL record", () => {
    // A record written before a column existed omits that key. "Partial" is about
    // which KEYS are present and is valid; only a VALUE's type makes it corrupt.
    const partial = { beta: true };
    expect(booleanRecordOrFallback(partial, FALLBACK)).toBe(partial);
  });

  it("falls back WHOLESALE on one non-boolean member, not member-wise", () => {
    // Member-wise filtering would hand the column menu a record missing the key
    // while the backfilled copy still shows the column — an unchecked switch for a
    // visible column.
    expect(
      booleanRecordOrFallback({ alpha: "false", beta: true }, FALLBACK)
    ).toBe(FALLBACK);
  });

  it("falls back WHOLESALE on a non-boolean under a computed __proto__ key", () => {
    // A quoted "__proto__" in an object literal creates NO own key, so it would be a
    // vacuous fixture. JSON.parse does create one — and z.record(z.string(),
    // z.boolean()) SILENTLY DROPS it before validating, reporting success, which is
    // why this validator reads own keys directly instead of using a schema.
    const hostile = JSON.parse(
      '{"__proto__":"notabool","alpha":true}'
    ) as unknown;
    expect(booleanRecordOrFallback(hostile, FALLBACK)).toBe(FALLBACK);
    expect(Object.getPrototypeOf(FALLBACK)).toBe(Object.prototype);
  });

  it("returns the fallback for every non-record", () => {
    for (const value of [5, null, "text", true, [1, 2]]) {
      expect(booleanRecordOrFallback(value, FALLBACK)).toBe(FALLBACK);
    }
  });
});

describe("stringUnionOrFallback", () => {
  const ALLOWED = ["list", "card"] as const;

  it("returns a member unchanged", () => {
    expect(stringUnionOrFallback("card", ALLOWED, "list")).toBe("card");
  });

  it("returns the fallback for a non-member string and for every non-string", () => {
    expect(stringUnionOrFallback("banana", ALLOWED, "list")).toBe("list");
    for (const value of MALFORMED_JSON_VALUES) {
      expect(stringUnionOrFallback(value, ALLOWED, "list")).toBe("list");
    }
  });
});
