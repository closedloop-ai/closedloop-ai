import { describe, expect, it } from "vitest";
import { validateKeyBelongsToLoop } from "@/lib/loops/loop-state";

describe("validateKeyBelongsToLoop support artifacts", () => {
  it("accepts loop-scoped support artifact keys", () => {
    expect(
      validateKeyBelongsToLoop(
        "org-1/loops/loop-1/run-1/support/claude-output.jsonl",
        "org-1",
        "loop-1"
      )
    ).toBe(true);
    expect(
      validateKeyBelongsToLoop(
        "org-1/loops/loop-1/run-1/support/perf.jsonl",
        "org-1",
        "loop-1"
      )
    ).toBe(true);
  });

  it("rejects traversal and wrong-scope support artifact keys", () => {
    const invalidKeys = [
      "org-1/loops/loop-1/run-1/support/../perf.jsonl",
      "org-1/loops/loop-1/run-1/support/./perf.jsonl",
      "org-1/loops/loop-2/run-1/support/perf.jsonl",
      "org-2/loops/loop-1/run-1/support/perf.jsonl",
    ];

    for (const key of invalidKeys) {
      expect(validateKeyBelongsToLoop(key, "org-1", "loop-1")).toBe(false);
    }
  });
});
