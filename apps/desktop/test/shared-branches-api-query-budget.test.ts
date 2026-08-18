import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
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

    assert.equal(labels.length, 12);
    assert.equal(
      labels.filter((label) => label === "canonicalActivity").length,
      1
    );
    assert.deepEqual(canonicalActivityParameters, ["acme/web", "a"]);
    assert.equal(labels.filter((label) => label === "links").length, 1);
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("FROM pull_requests") &&
          !label.includes("WITH pr_branch")
      ).length,
      1
    );
    assert.equal(
      labels.filter(
        (label) =>
          label.includes("kind = 'commit'") && !label.includes("WITH pr_branch")
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
          !label.includes("canonical_outside_events AS")
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
      labels.filter((label) => label.includes("WITH pr_branch")).length,
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
          label.includes("WITH pr_branch") && label.includes("LIMIT 10001")
      ).length,
      1
    );
  });
});
