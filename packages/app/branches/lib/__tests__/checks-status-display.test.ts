import {
  CheckRowOutcomeBucket,
  checkRowOutcomeBucket,
} from "@repo/api/src/types/branch-check-projection";
import { describe, expect, it } from "vitest";
import {
  CHECK_ROW_BUCKET_VARIANT,
  CHECK_ROW_OUTCOME_UNRECORDED_LABEL,
  checkRowOutcome,
} from "../checks-status-display";

/**
 * ISS-8241. `checkRowOutcome` decides whether a reader sees a check as passed or
 * failed, and the API's rollup fold reads the same buckets to decide the
 * headline over them. Both halves are pinned here: the words, and the refusal to
 * guess at a word this product does not know.
 */
describe("checkRowOutcome", () => {
  it("prefers the conclusion over the status once a run has finished", () => {
    // A check run keeps `status: COMPLETED` and says what happened in the
    // conclusion; reading the status would report every finished check the same.
    expect(checkRowOutcome("COMPLETED", "FAILURE")).toEqual({
      label: "Failed",
      variant: "destructive",
    });
  });

  it("reads a status context, which never carries a conclusion at all", () => {
    expect(checkRowOutcome("SUCCESS", null)).toEqual({
      label: "Passed",
      variant: "success",
    });
  });

  it("accepts the provider's own casing and padding", () => {
    expect(checkRowOutcome(null, "  success  ")).toEqual({
      label: "Passed",
      variant: "success",
    });
  });

  it("names the row with NOTHING reported rather than leaving it blank", () => {
    expect(checkRowOutcome(null, null)).toEqual({
      label: CHECK_ROW_OUTCOME_UNRECORDED_LABEL,
      variant: "default",
    });
    expect(checkRowOutcome("", "")).toEqual({
      label: CHECK_ROW_OUTCOME_UNRECORDED_LABEL,
      variant: "default",
    });
  });

  it("shows an UNRECOGNIZED outcome as itself at the neutral tone", () => {
    // The defect this guards: bucketing an unknown provider word into the
    // nearest neighbour is how a failing check comes to read as a passing one.
    // It renders as the provider's own word, and never borrows a tone.
    expect(checkRowOutcome("COMPLETED", "QUARANTINED")).toEqual({
      label: "QUARANTINED",
      variant: "default",
    });
    expect(checkRowOutcomeBucket("COMPLETED", "QUARANTINED")).toBeNull();
  });

  it.each([
    ["SUCCESS", "Passed", "success"],
    ["FAILURE", "Failed", "destructive"],
    ["ERROR", "Failed", "destructive"],
    ["TIMED_OUT", "Timed out", "destructive"],
    ["ACTION_REQUIRED", "Action required", "destructive"],
    ["STARTUP_FAILURE", "Failed to start", "destructive"],
    ["CANCELLED", "Canceled", "default"],
    ["SKIPPED", "Skipped", "default"],
    ["STALE", "Stale", "default"],
    ["NEUTRAL", "Neutral", "default"],
    ["QUEUED", "Pending", "warning"],
    ["IN_PROGRESS", "Pending", "warning"],
    ["PENDING", "Pending", "warning"],
    ["EXPECTED", "Pending", "warning"],
    ["WAITING", "Pending", "warning"],
    ["REQUESTED", "Pending", "warning"],
  ])("words %s as %s", (word, label, variant) => {
    // Every word this module SPELLS must also be a word the shared table
    // CLASSIFIES. A label with no bucket would render at the neutral tone while
    // the API's fold, reading the same table, ignored it entirely.
    expect(checkRowOutcome("COMPLETED", word)).toEqual({ label, variant });
    expect(checkRowOutcomeBucket("COMPLETED", word)).not.toBeNull();
  });
});

describe("checkRowOutcomeBucket", () => {
  it("keeps an unfinished run out of the inconclusive bucket", () => {
    // A build still running is PENDING, never neutral: bucketing it as a
    // non-result would let a population still in flight read as settled.
    expect(checkRowOutcomeBucket("IN_PROGRESS", null)).toBe(
      CheckRowOutcomeBucket.Pending
    );
  });

  it("separates a check that ran without a verdict from one that failed", () => {
    expect(checkRowOutcomeBucket("COMPLETED", "SKIPPED")).toBe(
      CheckRowOutcomeBucket.Inconclusive
    );
    expect(checkRowOutcomeBucket("COMPLETED", "TIMED_OUT")).toBe(
      CheckRowOutcomeBucket.Failed
    );
  });

  it("tones every bucket distinctly enough that a failure cannot read as a pass", () => {
    expect(CHECK_ROW_BUCKET_VARIANT[CheckRowOutcomeBucket.Passed]).toBe(
      "success"
    );
    expect(CHECK_ROW_BUCKET_VARIANT[CheckRowOutcomeBucket.Failed]).toBe(
      "destructive"
    );
    expect(CHECK_ROW_BUCKET_VARIANT[CheckRowOutcomeBucket.Pending]).toBe(
      "warning"
    );
    expect(CHECK_ROW_BUCKET_VARIANT[CheckRowOutcomeBucket.Inconclusive]).toBe(
      "default"
    );
  });
});
