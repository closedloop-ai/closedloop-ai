import { describe, expect, it } from "vitest";
import { COMPUTE_TARGETS_QUERY_OPTIONS } from "../compute-target-query-options";

const THIRTY_SECONDS_MS = 30_000;

describe("COMPUTE_TARGETS_QUERY_OPTIONS.refetchInterval", () => {
  it("stops polling once the query has settled into an error state", () => {
    const result = COMPUTE_TARGETS_QUERY_OPTIONS.refetchInterval({
      state: { status: "error" },
    });

    expect(result).toBe(false);
  });

  it("polls at the configured interval for a non-error status", () => {
    const result = COMPUTE_TARGETS_QUERY_OPTIONS.refetchInterval({
      state: { status: "success" },
    });

    expect(result).toBe(THIRTY_SECONDS_MS);
  });
});
