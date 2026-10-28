import { describe, expect, it } from "vitest";
import { applyBranchDiffStatsPatch } from "./persist-session-children";

describe("applyBranchDiffStatsPatch", () => {
  it("clears all four branch_* columns to null when branchDiffStats is explicitly null", () => {
    // Explicit null (as opposed to omission/undefined, which early-returns and
    // preserves the existing patch) is the documented "clear together" signal —
    // every one of the four columns must fall back to null in one call.
    const patch: Parameters<typeof applyBranchDiffStatsPatch>[0] = {};

    applyBranchDiffStatsPatch(patch, null);

    expect(patch).toEqual({
      branchLinesAdded: null,
      branchLinesRemoved: null,
      branchFilesChanged: null,
      branchLocSource: null,
    });
  });
});
