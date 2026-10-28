import { describe, expect, it } from "vitest";
import { isPlausibleBranchPushTransition } from "../branch-push-contribution.ts";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);

describe("isPlausibleBranchPushTransition", () => {
  it("accepts a changed exact SHA range including new-ref creation", () => {
    expect(isPlausibleBranchPushTransition(BEFORE_SHA, AFTER_SHA)).toBe(true);
    expect(isPlausibleBranchPushTransition("0".repeat(40), AFTER_SHA)).toBe(
      true
    );
  });

  it("rejects unchanged, deleted, malformed, and out-of-range SHAs", () => {
    for (const [beforeSha, afterSha] of [
      [BEFORE_SHA, BEFORE_SHA],
      [BEFORE_SHA, "0".repeat(40)],
      ["", AFTER_SHA],
      [BEFORE_SHA, "not-a-sha"],
      [BEFORE_SHA, "b".repeat(65)],
    ]) {
      expect(isPlausibleBranchPushTransition(beforeSha, afterSha)).toBe(false);
    }
  });
});
