import { normalizedEventKey } from "@closedloop-ai/design-system/lib/keyboard-event-key";
import { describe, expect, it } from "vitest";

/**
 * The whole point of this module is the inputs its parameter type FORBIDS, so
 * the cases below are the ones a `string` annotation would have told us cannot
 * happen — and which a `document`-level listener receives anyway (ISS-7493).
 * The `unknown` property type is what lets them be written without a cast.
 */
describe("normalizedEventKey", () => {
  it("lowercases a real key so a chord matches regardless of Shift or CapsLock", () => {
    expect(normalizedEventKey({ key: "K" })).toBe("k");
    expect(normalizedEventKey({ key: "k" })).toBe("k");
    expect(normalizedEventKey({ key: "ArrowDown" })).toBe("arrowdown");
  });

  it("answers null for every non-string a synthetic event can carry", () => {
    // Each of these reaches `.toLowerCase()` and throws without the guard. The
    // nullish pair is what optional chaining alone already covered; the rest is
    // what it did not (whitlockk review, PR #7424).
    expect(normalizedEventKey({ key: undefined })).toBeNull();
    expect(normalizedEventKey({ key: null })).toBeNull();
    expect(normalizedEventKey({ key: 42 })).toBeNull();
    expect(normalizedEventKey({ key: true })).toBeNull();
    expect(normalizedEventKey({ key: {} })).toBeNull();
    expect(normalizedEventKey({ key: ["k"] })).toBeNull();
    expect(normalizedEventKey({ key: Symbol("k") })).toBeNull();
    // The event that never carried the property at all.
    expect(normalizedEventKey({})).toBeNull();
  });

  it("keeps an empty-string key distinguishable from an absent one", () => {
    // `""` is a value a chord could legitimately be declared for, so it must
    // normalize as itself rather than collapse into the no-key answer.
    expect(normalizedEventKey({ key: "" })).toBe("");
    expect(normalizedEventKey({ key: undefined })).toBeNull();
  });
});
