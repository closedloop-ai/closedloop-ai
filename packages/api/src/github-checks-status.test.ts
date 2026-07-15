import { describe, expect, it } from "vitest";
import {
  mapNullableRollupStateToChecksStatus,
  mapRollupStateToChecksStatus,
} from "./github-checks-status";
import { ChecksStatus } from "./types/branch-checks";

describe("github checks status", () => {
  it.each([
    ["SUCCESS", ChecksStatus.Passing],
    ["FAILURE", ChecksStatus.Failing],
    ["ERROR", ChecksStatus.Failing],
    ["PENDING", ChecksStatus.Pending],
    ["EXPECTED", ChecksStatus.Pending],
  ] as const)("maps %s to %s", (state, expected) => {
    expect(mapRollupStateToChecksStatus(state)).toBe(expected);
  });

  it("maps absent rollup data to unknown", () => {
    expect(mapNullableRollupStateToChecksStatus(null)).toBe(
      ChecksStatus.Unknown
    );
  });
});
