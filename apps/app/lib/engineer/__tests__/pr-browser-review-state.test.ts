import { describe, expect, it } from "vitest";
import { normalizeReviewRestoreSeed } from "../pr-browser-review-state";

describe("normalizeReviewRestoreSeed", () => {
  it("drops partial log output for running reviews", () => {
    expect(
      normalizeReviewRestoreSeed({
        status: "running",
        log: "partial output",
        provider: "codex",
      })
    ).toEqual({
      status: "running",
      log: undefined,
      provider: "codex",
    });
  });

  it("preserves completed review output", () => {
    expect(
      normalizeReviewRestoreSeed({
        status: "completed",
        log: "final output",
        provider: "codex",
      })
    ).toEqual({
      status: "completed",
      log: "final output",
      provider: "codex",
    });
  });
});
