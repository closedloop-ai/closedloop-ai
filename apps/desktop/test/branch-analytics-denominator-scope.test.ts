import assert from "node:assert/strict";
import { BranchStatus } from "@repo/api/src/types/branch";
import { test } from "vitest";
import { selectDesktopDenominatorItems } from "../src/main/branch/branch-analytics-builder.js";
import { makeBranchRowFixture } from "./shared-branches-test-helpers.js";

test("exact denominator scope never widens to an unrelated same-repository Branch", () => {
  const selected = makeBranchRowFixture({
    id: "selected",
    branchName: "feature/selected",
    status: BranchStatus.Open,
  });
  const unrelated = makeBranchRowFixture({
    id: "unrelated",
    branchName: "feature/unrelated",
    status: BranchStatus.Open,
  });

  const result = selectDesktopDenominatorItems(
    [selected, unrelated],
    [selected],
    {},
    true
  );

  assert.deepEqual(
    result.map((item) => item.id),
    [selected.id]
  );
});
