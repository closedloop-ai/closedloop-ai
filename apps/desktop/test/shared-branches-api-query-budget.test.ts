import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
import { BRANCH_COST_SLICES_SQL_TAG } from "../src/main/database/branch-cost-window-reads.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

describe("getSharedBranchesPageData canonical query budget", () => {
  test("shares bounded evidence reads instead of repeating them", async () => {
    const labels: string[] = [];
    let canonicalActivityParameters: readonly unknown[] | undefined;
    const source = makeSource(
      { links: [link({ branch_name: "a", session_id: "s1" })] },
      (label, parameters) => {
        labels.push(label);
        if (label === "canonicalActivity") {
          canonicalActivityParameters = parameters;
        }
      }
    );

    await getSharedBranchesPageData(source);

    // ISS-12361: 12 reads plus the one SQL read that folds AI spend.
    assert.equal(labels.length, 13);
    assert.equal(
      labels.filter((label) => label.includes(BRANCH_COST_SLICES_SQL_TAG))
        .length,
      1
    );
    assert.equal(
      labels.filter((label) => label === "canonicalActivity").length,
      1
    );
    assert.deepEqual(canonicalActivityParameters, ["acme/web", "a"]);
    // ISS-10324 moved the list link read off the typed delegate onto a raw
    // statement, so it reports as its SQL like the other raw reads below. The
    // contract is unchanged: exactly ONE list link read per page load.
    assert.equal(
      labels.filter((label) => label.includes("latest_push_observed_at"))
        .length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM pull_requests") &&
          !label.includes("pr_branch AS (")
      ).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("kind = 'commit'") && !label.includes("pr_branch AS (")
      ).length,
      1
    );
    assert.equal(
      labels.filter((label) => label.includes("GROUP BY l.repo_full_name"))
        .length,
      1
    );
    assert.equal(labels.filter((label) => label === "usageTokens").length, 1);
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM token_events") &&
          !label.includes("canonical_outside_events AS") &&
          !label.includes(BRANCH_COST_SLICES_SQL_TAG)
      ).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM session_activity_segments") &&
          label.includes("LIMIT 50001")
      ).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM session_activity_segments") &&
          label.includes("LIMIT 50000")
      ).length,
      1
    );
    assert.equal(
      labels.filter((label) => label.includes("pr_branch AS (")).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM session_activity_segments") &&
          label.includes("LIMIT 50001")
      ).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("pr_branch AS (") && label.includes("LIMIT 10001")
      ).length,
      1
    );
  });
});
