import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import { BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES } from "@repo/api/src/types/branch-analytics-cohort.js";
import { makeOversizedBranchIds } from "@repo/api/src/types/branch-analytics-cohort-fixtures.test-helpers.js";
import {
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

const existingId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});
const absentId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/missing",
});

describe("getSharedBranchCohortAnalytics", () => {
  test("projects only existing requested canonical IDs", async () => {
    const scopedEvidenceParameters: Array<readonly unknown[]> = [];
    const response = await getSharedBranchCohortAnalytics(
      makeSource({ links: [link({})] }, (sql, parameters) => {
        if (
          sql.includes("FROM session_activity_segments") ||
          sql.includes("WITH requested_branches")
        ) {
          scopedEvidenceParameters.push(parameters ?? []);
        }
      }),
      { branchIds: [absentId, existingId] }
    );

    assert.deepEqual(response?.matchedBranchIds, [existingId]);
    assert.equal(response?.canonicalMetrics.cohortSize, 1);
    assert.equal(scopedEvidenceParameters.length, 2);
    assert.deepEqual(scopedEvidenceParameters[0]?.slice(0, 4), [
      "acme/web",
      "feature/missing",
      "acme/web",
      "feature/x",
    ]);
    assert.equal(scopedEvidenceParameters[0]?.at(-2), null);
    assert.equal(typeof scopedEvidenceParameters[0]?.at(-1), "string");
    assert.deepEqual(scopedEvidenceParameters.slice(1), [
      ["acme/web", "feature/missing", "acme/web", "feature/x"],
    ]);
  });

  test("returns a zero-sized cohort when no requested IDs match", async () => {
    const response = await getSharedBranchCohortAnalytics(
      makeSource({ links: [link({})] }),
      { branchIds: [absentId] }
    );

    assert.deepEqual(response?.matchedBranchIds, []);
    assert.equal(response?.canonicalMetrics.cohortSize, 0);
  });

  test("projects an exact 101-identity cohort", async () => {
    const branches = Array.from({ length: 101 }, (_, index) => ({
      id: encodeBranchId({
        repoFullName: "acme/web",
        branchName: `feature/cohort-${index}`,
      }),
      row: link({
        branch_name: `feature/cohort-${index}`,
        session_id: `session-${index}`,
      }),
    }));

    const response = await getSharedBranchCohortAnalytics(
      makeSource({ links: branches.map(({ row }) => row) }),
      { branchIds: branches.map(({ id }) => id) }
    );

    assert.deepEqual(
      response?.matchedBranchIds,
      branches
        .map(({ id }) => id)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.equal(response?.canonicalMetrics.cohortSize, 101);
  });

  test("accepts an inclusive UTC-day cohort window", async () => {
    const response = await getSharedBranchCohortAnalytics(
      makeSource({ links: [link({})] }),
      {
        branchIds: [existingId],
        startDate: "2026-06-14T00:00:00.000Z",
        endDate: "2026-06-20T23:59:59.999Z",
      }
    );

    assert.deepEqual(response?.matchedBranchIds, [existingId]);
    assert.equal(
      response?.canonicalMetrics.period,
      BranchMetricPeriod.SevenDays
    );
    assert.equal(
      response?.canonicalMetrics.label,
      BranchMetricComparisonLabel.WeekOverWeek
    );
    assert.deepEqual(response?.canonicalMetrics.window, {
      startAt: "2026-06-14T00:00:00.000Z",
      endAt: "2026-06-21T00:00:00.000Z",
    });
  });

  test("rejects malformed input before persisted reads", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });

    await assert.rejects(
      getSharedBranchCohortAnalytics(source, { branchIds: [] })
    );
    assert.equal(queried, false);
  });

  test("rejects an over-budget request before persisted reads", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });
    const branchIds = makeOversizedBranchIds();

    assert.equal(
      new TextEncoder().encode(JSON.stringify({ branchIds })).byteLength,
      BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES + 1
    );
    assert.equal(
      branchIds.every((branchId) => branchId.length <= 512),
      true
    );
    await assert.rejects(getSharedBranchCohortAnalytics(source, { branchIds }));
    assert.equal(queried, false);
  });

  test("rejects raw over-budget identities before trimming or persisted reads", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });
    const branchIds = Array.from(
      { length: 140 },
      (_, index) => `${" ".repeat(480)}branch-${index}`
    );
    const normalizedBranchIds = branchIds.map((branchId) => branchId.trim());

    assert.equal(
      new TextEncoder().encode(JSON.stringify({ branchIds })).byteLength >
        BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES,
      true
    );
    assert.equal(
      new TextEncoder().encode(
        JSON.stringify({ branchIds: normalizedBranchIds })
      ).byteLength < BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES,
      true
    );
    await assert.rejects(getSharedBranchCohortAnalytics(source, { branchIds }));
    assert.equal(queried, false);
  });
});
