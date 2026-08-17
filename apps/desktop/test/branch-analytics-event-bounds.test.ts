import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});
const finiteRequest = {
  startDate: "2026-06-24T00:00:00.000Z",
  endDate: "2026-07-01T00:00:00.000Z",
};
const expectedPriorStart = "2026-06-17T00:00:00.000Z";
const rawStartBoundRegex = /te\.created_at >= \$1/;
const rawEndBoundRegex = /te\.created_at <= \$2/;

describe("Desktop Branch analytics canonical event bounds", () => {
  test("all three production callers read the prior/current span, never only the request span", async () => {
    const standalone = captureMetricEventQueries();
    await getSharedBranchAnalytics(standalone.source, finiteRequest);

    const pageData = captureMetricEventQueries();
    await getSharedBranchesPageData(pageData.source, finiteRequest);

    const exactCohort = captureMetricEventQueries();
    await getSharedBranchCohortAnalytics(exactCohort.source, {
      branchIds: [branchId],
      ...finiteRequest,
    });
    for (const queries of [
      standalone.queries,
      pageData.queries,
      exactCohort.queries,
    ]) {
      assert.equal(queries.length, 2);
      const { provenance, raw } = metricEventPair(queries);
      assert.match(raw.sql, rawStartBoundRegex);
      assert.match(raw.sql, rawEndBoundRegex);
      assert.deepEqual(raw.parameters, [
        expectedPriorStart,
        finiteRequest.endDate,
      ]);
      assert.deepEqual(provenance.parameters.slice(-2), [
        expectedPriorStart,
        finiteRequest.endDate,
      ]);
      assert.equal(
        provenance.parameters.includes(finiteRequest.startDate),
        false
      );
    }
  });

  test("all three production callers retain end-only All behavior", async () => {
    for (const invoke of [
      (source: ReturnType<typeof makeSource>) =>
        getSharedBranchAnalytics(source),
      (source: ReturnType<typeof makeSource>) =>
        getSharedBranchesPageData(source),
      (source: ReturnType<typeof makeSource>) =>
        getSharedBranchCohortAnalytics(source, { branchIds: [branchId] }),
    ]) {
      const capture = captureMetricEventQueries();
      await invoke(capture.source);
      assert.equal(capture.queries.length, 2);
      const raw = capture.queries.find((query) => !query.provenance);
      const provenance = capture.queries.find((query) => query.provenance);
      assert.ok(raw);
      assert.ok(provenance);
      const rawEnd = raw.parameters.at(-1);
      assert.equal(typeof rawEnd, "string");
      assert.equal(provenance.parameters.at(-2), null);
      assert.equal(provenance.parameters.at(-1), rawEnd);
    }
  });
});

function captureMetricEventQueries(): {
  source: ReturnType<typeof makeSource>;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const source = makeSource({ links: [link({})] }, (sql, parameters = []) => {
    if (sql.includes("FROM token_events")) {
      queries.push({
        provenance: sql.includes("canonical_outside_events AS"),
        sql,
        parameters,
      });
    }
  });
  return { source, queries };
}

function metricEventPair(queries: readonly CapturedQuery[]): {
  raw: CapturedQuery;
  provenance: CapturedQuery;
} {
  const raw = queries.find((query) => !query.provenance);
  const provenance = queries.find((query) => query.provenance);
  if (!(raw && provenance)) {
    throw new Error("Expected raw and outside-provenance metric event queries");
  }
  return { raw, provenance };
}

type CapturedQuery = {
  provenance: boolean;
  sql: string;
  parameters: readonly unknown[];
};
