/**
 * @file agent-dashboard-ipc-coercion.test.ts
 * @description ISS-7979: direct boundary coverage for the dashboard IPC
 * coercers that previously had no focused tests.
 */
import assert from "node:assert/strict";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { BranchStatus } from "@repo/api/src/types/branch";
import { branchListCohortKey } from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import {
  coerceDashboardWindowRequest,
  coerceDiagnosticsRequest,
  coerceFingerprint,
  coerceInsightsPeriod,
  coerceInsightsSection,
  coerceLookbackDays,
  coerceSessionPageRequest,
  coerceSharedAgentSessionsListRequest,
  coerceSharedAgentSessionsQuery,
  coerceSharedBranchesQuery,
  coerceSharedQuery,
  coerceWindowDays,
  toBranchSyncSource,
} from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";

const LOC_RANGE_ERROR = /locMin must be less than or equal to locMax/;

describe("agent dashboard IPC coercion", () => {
  test("coerceSharedQuery preserves object payloads and defaults primitives", () => {
    const request = { q: "needle" };

    assert.equal(coerceSharedQuery(request), request);
    assert.deepEqual(coerceSharedQuery(null), {});
    assert.deepEqual(coerceSharedQuery("needle"), {});
    assert.deepEqual(coerceSharedQuery(undefined), {});
  });

  test("coerceSessionPageRequest projects known fields without changing numeric semantics", () => {
    assert.deepEqual(
      coerceSessionPageRequest({
        limit: -1.5,
        offset: Number.POSITIVE_INFINITY,
        status: "active",
        q: "needle",
        ignored: true,
      }),
      {
        limit: -1.5,
        offset: Number.POSITIVE_INFINITY,
        status: "active",
        q: "needle",
      }
    );
    assert.deepEqual(
      coerceSessionPageRequest({
        limit: Number.NaN,
        offset: "12",
        status: null,
        q: false,
      }),
      {
        limit: Number.NaN,
        offset: undefined,
        status: undefined,
        q: undefined,
      }
    );
    assert.equal(coerceSessionPageRequest(null), undefined);
    assert.equal(coerceSessionPageRequest("request"), undefined);
  });

  test("insights coercers preserve declared values and use their historical defaults", () => {
    assert.equal(
      coerceInsightsSection(InsightsSection.Agents),
      InsightsSection.Agents
    );
    assert.equal(coerceInsightsSection("future"), InsightsSection.Delivery);
    assert.equal(
      coerceInsightsPeriod(InsightsPeriod.Week),
      InsightsPeriod.Week
    );
    assert.equal(coerceInsightsPeriod("future"), InsightsPeriod.Quarter);
  });

  test("coerceLookbackDays preserves null and every finite numeric window", () => {
    assert.equal(coerceLookbackDays(null), null);
    assert.equal(coerceLookbackDays(-2.5), -2.5);
    assert.equal(coerceLookbackDays(30), 30);
    assert.equal(coerceLookbackDays(Number.NaN), undefined);
    assert.equal(coerceLookbackDays(Number.POSITIVE_INFINITY), undefined);
    assert.equal(coerceLookbackDays("30"), undefined);
    assert.equal(coerceLookbackDays(undefined), undefined);
  });

  test("coerceWindowDays accepts only integer days inside the declared range", () => {
    assert.equal(coerceWindowDays(1), 1);
    assert.equal(coerceWindowDays(33), 33);
    assert.equal(coerceWindowDays(365), 365);
    assert.equal(coerceWindowDays(33.33), 30);
    assert.equal(coerceWindowDays(0), 30);
    assert.equal(coerceWindowDays(366), 30);
    assert.equal(coerceWindowDays(Number.NaN), 30);
    assert.equal(coerceWindowDays(Number.POSITIVE_INFINITY), 30);
    assert.equal(coerceWindowDays("30"), 30);
  });

  test("coerceFingerprint preserves non-empty strings and degrades everything else to null", () => {
    assert.equal(coerceFingerprint("full-content-hash"), "full-content-hash");
    assert.equal(coerceFingerprint(" "), " ");
    assert.equal(coerceFingerprint(""), null);
    assert.equal(coerceFingerprint(null), null);
    assert.equal(coerceFingerprint(42), null);
  });

  test("coerceDiagnosticsRequest strips additive fields and refuses malformed flags", () => {
    assert.deepEqual(
      coerceDiagnosticsRequest({
        includeActivityCoverage: true,
        newerRendererField: "ignored",
      }),
      { includeActivityCoverage: true }
    );
    assert.deepEqual(
      coerceDiagnosticsRequest({ includeActivityCoverage: false }),
      {
        includeActivityCoverage: false,
      }
    );
    for (const malformed of [
      { includeActivityCoverage: "true" },
      [],
      "request",
      null,
      undefined,
    ]) {
      assert.deepEqual(coerceDiagnosticsRequest(malformed), {});
    }
  });

  /**
   * ISS-7125: main keys `branchListCohortKey(coerceSharedBranchesQuery(raw))`
   * while the renderer keys the raw request it sent — its facet values come
   * straight off the URL, and `dedupeNonEmpty` drops only `""`. The coercer's
   * schema trims, so a bookmarked `#/branches?tag=release+` would key
   * `["release"]` in main and `["release "]` in the renderer, the equality gate
   * would reject the producer's cohort, and the notice would fall back to the
   * page-scoped undercount ISS-7125 exists to remove — permanently, and only on
   * Desktop. This is the Desktop twin of the web parity test in
   * `packages/app/branches/lib/__tests__/branch-server-page-query.test.ts`.
   */
  test("coerceSharedBranchesQuery keys a padded facet as the renderer keys it", () => {
    const rendererRequest = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      tags: ["release ", " hotfix"],
      repositories: [" closedloop-ai/closedloop-ai"],
      statuses: [BranchStatus.Open],
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    };

    const mainRequest = coerceSharedBranchesQuery(rendererRequest);

    assert.deepEqual(mainRequest.tags, ["release", "hotfix"]);
    assert.equal(
      branchListCohortKey(mainRequest),
      branchListCohortKey(rendererRequest)
    );
  });

  test("coerceSessionPageRequest drops a non-numeric limit", () => {
    assert.deepEqual(coerceSessionPageRequest({ limit: "25", offset: 5 }), {
      limit: undefined,
      offset: 5,
      status: undefined,
      q: undefined,
    });
  });

  test("coerceDashboardWindowRequest keeps only numeric bounds", () => {
    assert.deepEqual(coerceDashboardWindowRequest({ limit: 10, offset: 20 }), {
      limit: 10,
      offset: 20,
    });
    assert.deepEqual(
      coerceDashboardWindowRequest({ limit: "10", offset: null }),
      { limit: undefined, offset: undefined }
    );
    assert.deepEqual(coerceDashboardWindowRequest("window"), {
      limit: undefined,
      offset: undefined,
    });
  });

  test("coerceSharedBranchesQuery enforces locMin <= locMax only when both are set", () => {
    const serverRequest = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    };

    assert.equal(
      coerceSharedBranchesQuery({ ...serverRequest, locMin: 5 }).locMin,
      5
    );
    assert.deepEqual(
      coerceSharedBranchesQuery({ ...serverRequest, locMin: 5, locMax: 5 }),
      { ...serverRequest, locMin: 5, locMax: 5 }
    );
    assert.throws(
      () =>
        coerceSharedBranchesQuery({ ...serverRequest, locMin: 9, locMax: 1 }),
      LOC_RANGE_ERROR
    );
  });

  test("shared agent-sessions coercers keep modelled fields and fall back to {}", () => {
    assert.deepEqual(
      coerceSharedAgentSessionsQuery({
        status: SESSION_STATUS.ACTIVE,
        unknownKey: 1,
      }),
      { status: SESSION_STATUS.ACTIVE }
    );
    assert.deepEqual(coerceSharedAgentSessionsQuery(null), {});
    assert.deepEqual(coerceSharedAgentSessionsQuery("query"), {});

    assert.deepEqual(
      coerceSharedAgentSessionsListRequest({ ids: ["a"], search: "x" }),
      { ids: ["a"], search: "x" }
    );
    assert.deepEqual(coerceSharedAgentSessionsListRequest(undefined), {});
    assert.deepEqual(coerceSharedAgentSessionsListRequest(42), {});
  });

  test("toBranchSyncSource exposes only the four shared Branch read dependencies", () => {
    const prisma = { name: "prisma" };
    const readBranchCanonicalActivityRows = () => Promise.resolve([]);
    const readBranchMetricEventEvidence = () => Promise.resolve([]);
    const syncSource = { name: "sync-source" };
    const agentDatabase = {
      prisma,
      readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence,
      syncSource,
      sessions: { shouldNotEscape: true },
    } as unknown as DbHostAgentDatabase;

    assert.deepEqual(toBranchSyncSource(agentDatabase), {
      prisma,
      readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence,
      syncSource,
    });
  });
});
