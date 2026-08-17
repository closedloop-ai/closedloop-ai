import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BranchCloudHydrationStatus,
  BranchKpiState,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity.js";
import { ChecksStatus } from "@repo/api/src/types/branch-checks.js";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics.js";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import { projectDesktopBranchLastActive } from "../src/main/branch/branch-last-active-projection.js";
import {
  type BranchSyncSource,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import type {
  BranchCommitRow,
  BranchPrRow,
} from "../src/main/database/branch-reads.js";
import { SHARED_BRANCHES_SOURCE_ERROR_CODE } from "../src/shared/shared-branches-contract.js";
import {
  canonicalActivity,
  commit,
  eventFromToken,
  link,
  makeSource,
  SQL_SECRET,
} from "./shared-branches-test-helpers.js";

const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});

describe("Desktop canonical Branch Last active", () => {
  test("production list excludes later generic Session activity", async () => {
    const source = makeSource({
      links: [link({ activity_at: "2026-06-30T12:00:00.000Z" })],
      commits: [commit({ committed_at: "2026-06-10T12:00:00.000Z" })],
      canonicalActivity: [
        canonicalActivity({ occurredAt: "2026-06-20T12:00:00.000Z" }),
      ],
    });

    const [row] = (await getSharedBranches(source)).items;

    assert.equal(row.lastActivityAt, "2026-06-20T12:00:00.000Z");
    assert.deepEqual(row.canonicalLastActiveAt, {
      value: "2026-06-20T12:00:00.000Z",
      state: BranchMetricAvailability.Partial,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
  });

  test("dedupes source events and preserves partial or unavailable evidence", () => {
    const duplicateSourceRows = [
      canonicalActivity({ occurredAt: "2026-06-12T12:00:00.000Z" }),
      canonicalActivity({ occurredAt: "2026-06-20T12:00:00.000Z" }),
      canonicalActivity({
        sourceEventId: "monitored:partial",
        occurredAt: null,
        completeness: BranchActivityEvidenceCompleteness.Partial,
      }),
    ];

    assert.deepEqual(
      projectDesktopBranchLastActive(
        [branchId],
        duplicateSourceRows,
        [],
        []
      ).get(branchId),
      {
        value: "2026-06-20T12:00:00.000Z",
        state: BranchMetricAvailability.Partial,
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      }
    );
    assert.deepEqual(
      projectDesktopBranchLastActive([branchId], [], [], []).get(branchId),
      { value: null, state: BranchMetricAvailability.Unavailable }
    );
  });

  test("ignores activity outside the requested branch identities", () => {
    const requestedBranchId = encodeBranchId({
      repoFullName: null,
      branchName: "feature/requested",
    });
    const requestedPullRequest: BranchPrRow = {
      repoFullName: null,
      branchName: "feature/requested",
      prNumber: 7,
      prUrl: null,
      title: null,
      state: null,
      isDraft: null,
      openedAt: "2026-06-15T12:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      observedAt: null,
      linesAdded: null,
      linesRemoved: null,
      filesChanged: null,
    };
    const unrelatedPullRequest: BranchPrRow = {
      ...requestedPullRequest,
      repoFullName: "acme/web",
      branchName: "feature/unrelated",
      prNumber: 8,
      openedAt: "2026-06-30T12:00:00.000Z",
    };
    const unrelatedCommit: BranchCommitRow = {
      repoFullName: "acme/web",
      branchName: "feature/unrelated",
      sha: "unrelated-commit",
      committedAt: "2026-07-01T12:00:00.000Z",
      message: null,
    };

    assert.deepEqual(
      projectDesktopBranchLastActive(
        [requestedBranchId],
        [
          canonicalActivity({
            branchName: "feature/unrelated",
            occurredAt: "2026-07-02T12:00:00.000Z",
          }),
        ],
        [requestedPullRequest, unrelatedPullRequest],
        [unrelatedCommit]
      ).get(requestedBranchId),
      {
        value: "2026-06-15T12:00:00.000Z",
        state: BranchMetricAvailability.Partial,
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      }
    );
  });

  test("orders equal instants by normalized identity, then stable encoded id", async () => {
    const tied = [
      { repoFullName: "zeta/repo", branchName: "alpha" },
      { repoFullName: "ACME/WEB", branchName: "beta" },
      { repoFullName: "acme/web.git", branchName: "alpha" },
      { repoFullName: "acme/web", branchName: "alpha" },
    ].map(({ repoFullName, branchName }, index) => ({
      id: encodeBranchId({ repoFullName, branchName }),
      link: link({
        repo_full_name: repoFullName,
        branch_name: branchName,
        session_id: `session-tie-${index}`,
      }),
      activity: canonicalActivity({
        repoFullName,
        branchName,
        sourceEventId: `monitored:tie-${index}`,
        occurredAt: "2026-06-20T12:00:00.000Z",
      }),
    }));
    const source = makeSource({
      links: tied.map((item) => item.link),
      canonicalActivity: tied.map((item) => item.activity),
    });

    const result = await getSharedBranches(source);

    assert.deepEqual(
      result.items.map((item) => item.id),
      [tied[3]?.id, tied[2]?.id, tied[1]?.id, tied[0]?.id]
    );
  });

  test("windows the full 101-row corpus before page selection", async () => {
    const inWindow = Array.from({ length: 99 }, (_, index) => {
      const branchName = `feature/recent-${String(index).padStart(3, "0")}`;
      return {
        id: encodeBranchId({ repoFullName: "acme/web", branchName }),
        link: link({ branch_name: branchName, session_id: `session-${index}` }),
        activity: canonicalActivity({
          branchName,
          sourceEventId: `monitored:${index}`,
          occurredAt: "2026-06-20T12:00:00.000Z",
        }),
      };
    });
    const oldName = "feature/old-outside-window";
    const oldId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: oldName,
    });
    const unavailableName = "feature/unavailable";
    const unavailableId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: unavailableName,
    });
    const source = makeSource({
      links: [
        ...inWindow.map((item) => item.link),
        link({ branch_name: oldName, session_id: "session-old" }),
        link({ branch_name: unavailableName, session_id: "session-last" }),
      ],
      canonicalActivity: [
        ...inWindow.map((item) => item.activity),
        canonicalActivity({
          branchName: oldName,
          sourceEventId: "monitored:old",
          occurredAt: "2026-05-01T12:00:00.000Z",
        }),
      ],
    });
    const request = { startDate: "2026-06-01T00:00:00.000Z", limit: 100 };

    const firstPage = await getSharedBranches(source, request);
    const secondPage = await getSharedBranches(source, {
      ...request,
      offset: 100,
    });

    assert.equal(firstPage.total, 100);
    assert.deepEqual(
      firstPage.items.map((item) => item.id),
      [...inWindow.map((item) => item.id), unavailableId]
    );
    assert.equal(
      firstPage.items.some((item) => item.id === oldId),
      false
    );
    assert.deepEqual(secondPage.items, []);
    assert.equal(
      firstPage.items.at(-1)?.canonicalLastActiveAt?.state,
      BranchMetricAvailability.Unavailable
    );
  });

  test("shares the row result with page analytics and exact cohort analytics", async () => {
    const recentId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "recent",
    });
    const oldId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "old",
    });
    const unavailableId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "unavailable",
    });
    const source = makeSource({
      links: [
        link({ branch_name: "recent", session_id: "session-recent" }),
        link({ branch_name: "old", session_id: "session-old" }),
        link({
          branch_name: "unavailable",
          session_id: "session-unavailable",
        }),
      ],
      canonicalActivity: [
        canonicalActivity({
          branchName: "recent",
          occurredAt: "2026-06-20T12:00:00.000Z",
        }),
        canonicalActivity({
          branchName: "old",
          sourceEventId: "monitored:old",
          occurredAt: "2026-05-01T12:00:00.000Z",
        }),
      ],
    });
    const request = {
      startDate: "2026-06-01T00:00:00.000Z",
      endDate: "2026-07-01T00:00:00.000Z",
    };

    const page = await getSharedBranchesPageData(source, request);
    const cohort = await getSharedBranchCohortAnalytics(source, {
      branchIds: [recentId, oldId, unavailableId],
      ...request,
    });
    const recentResult = page.list.items[0]?.canonicalLastActiveAt;

    assert.deepEqual(
      page.list.items.map((item) => item.id),
      [recentId, unavailableId]
    );
    assert.deepEqual(
      page.analytics?.canonicalMetrics?.lastActiveAt,
      recentResult
    );
    assert.deepEqual(cohort?.canonicalMetrics.lastActiveAt, recentResult);
    assert.deepEqual(cohort?.matchedBranchIds, [recentId, unavailableId]);
  });

  test("uses canonical activity for usage and analytics window membership", async () => {
    const source = makeSource({
      links: [
        link({ branch_name: "recent", session_id: "session-recent" }),
        link({ branch_name: "stale", session_id: "session-stale" }),
      ],
      usageEvents: [
        eventFromToken("session-recent", "2026-06-20T12:00:00.000Z", 10, 5),
        eventFromToken("session-stale", "2026-05-01T12:00:00.000Z", 100, 50),
      ],
      canonicalActivity: [
        canonicalActivity({
          branchName: "recent",
          sourceEventId: "monitored:recent",
          occurredAt: "2026-06-20T12:00:00.000Z",
        }),
        canonicalActivity({
          branchName: "stale",
          sourceEventId: "monitored:stale",
          occurredAt: "2026-05-01T12:00:00.000Z",
        }),
      ],
    });
    const request = { startDate: "2026-06-17T00:00:00.000Z" };

    const usage = await getSharedBranchUsage(source, request);
    const analytics = await getSharedBranchAnalytics(source, request);

    assert.equal(usage.totalBranches, 1);
    assert.equal(usage.totalInputTokens, 10);
    assert.equal(analytics.activeBranchCount.value, 1);
  });

  test("cloud hydration cannot overwrite canonical activity or legacy membership", async () => {
    const source = makeSource({
      links: [link({})],
      canonicalActivity: [
        canonicalActivity({ occurredAt: "2026-06-01T12:00:00.000Z" }),
      ],
    });
    const hydration = {
      hydrate: async () => ({
        status: BranchCloudHydrationStatus.Fresh,
        overlays: {
          "acme/web::feature/x": {
            lastActivityAt: "2026-06-30T12:00:00.000Z",
            checksStatus: ChecksStatus.Passing,
          },
        },
      }),
    };

    const [row] = (await getSharedBranches(source, {}, hydration)).items;
    const analytics = await getSharedBranchAnalytics(
      source,
      { startDate: "2026-06-20T00:00:00.000Z" },
      hydration
    );

    assert.equal(row.lastActivityAt, "2026-06-01T12:00:00.000Z");
    assert.equal(row.checksStatus, ChecksStatus.Passing);
    assert.deepEqual(row.canonicalLastActiveAt, {
      value: "2026-06-01T12:00:00.000Z",
      state: BranchMetricAvailability.Partial,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
    assert.equal(analytics.activeBranchCount.state, BranchKpiState.Unavailable);
  });

  test("sanitizes an activity-read failure after invoking the typed source", async () => {
    const baseline = makeSource({ links: [link({})] });
    let capturedBranchKeys: readonly {
      repoFullName: string | null;
      branchName: string;
    }[] = [];
    const source: BranchSyncSource = {
      ...baseline,
      readBranchCanonicalActivityRows: (request) => {
        capturedBranchKeys = request.branchKeys.map((key) => ({
          repoFullName: key.repoFullName,
          branchName: key.branchName,
        }));
        return Promise.reject(
          new Error("SELECT secret_column FROM secret_table")
        );
      },
    };

    await assert.rejects(getSharedBranches(source), (error: Error) => {
      assert.equal(error.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
      assert.doesNotMatch(error.message, SQL_SECRET);
      return true;
    });
    assert.deepEqual(capturedBranchKeys, [
      { repoFullName: "acme/web", branchName: "feature/x" },
    ]);
  });
});
