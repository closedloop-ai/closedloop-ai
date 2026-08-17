import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import {
  getSharedBranchDetail,
  getSharedBranches,
} from "../src/main/branch/shared-branches-api.js";
import {
  link,
  makeSource,
  openPullRequestRow,
} from "./shared-branches-test-helpers.js";

const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});

describe("ISS-5550 Desktop branch cost contract", () => {
  test("list and detail preserve raw cost while exposing canonical attribution", async () => {
    const source = costSource(120, 40);

    const [listRow] = (await getSharedBranches(source)).items;
    const detail = await getSharedBranchDetail(source, branchId);

    assert.equal(listRow.estimatedCostUsd, 120);
    assert.equal(listRow.attributedCostUsd, 40);
    assert.equal(detail?.estimatedCostUsd, 120);
    assert.equal(detail?.attributedCostUsd, 40);
  });

  test("priced zero stays zero and entirely unpriced cost stays null", async () => {
    const [zero] = (await getSharedBranches(costSource(0, 0))).items;
    const [unpriced] = (await getSharedBranches(costSource(null, null))).items;

    assert.equal(zero.estimatedCostUsd, 0);
    assert.equal(zero.attributedCostUsd, 0);
    assert.equal(unpriced.estimatedCostUsd, null);
    assert.equal(unpriced.attributedCostUsd, null);
  });
});

function costSource(
  rawCostUsdEstimated: number | null,
  attributedCostUsd: number | null
) {
  return makeSource({
    links: [link({ branch_name: "feature/x", session_id: "s1" })],
    prs: [openPullRequestRow()],
    tokenAgg: [
      {
        repo_full_name: "acme/web",
        branch_name: "feature/x",
        model: "claude-sonnet-4-5",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        raw_cost_usd_estimated: rawCostUsdEstimated,
        cost_usd_estimated: attributedCostUsd,
      },
    ],
  });
}
