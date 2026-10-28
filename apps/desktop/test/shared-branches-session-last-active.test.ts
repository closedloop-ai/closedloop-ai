import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { describe, test, vi } from "vitest";
import { SESSION_EPOCH_TIMESTAMP } from "../src/main/agent-sync/session-date-window.js";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../src/main/branch/branch-cohort-analytics.js";
import {
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import {
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
} from "../src/main/database/branch-reads.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";
import {
  canonicalActivity,
  commit,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";

vi.mock(
  "../src/main/branch/shared-branches-default-eligibility.js",
  async (importOriginal) =>
    (
      await import("./helpers/complete-eligibility-snapshot.js")
    ).withCompleteEligibility(await importOriginal())
);

const oldActivity = "2026-06-01T12:00:00.000Z";
const recentActivity = "2026-06-20T12:00:00.000Z";
const scanTime = "2026-06-30T12:00:00.000Z";
const request = {
  startDate: "2026-06-17T00:00:00.000Z",
  endDate: "2026-06-24T00:00:00.000Z",
};
const branchId = encodeBranchId({
  repoFullName: "acme/web",
  branchName: "feature/x",
});

describe("ISS-11915 linked Session Last active fallback", () => {
  test("global and branch-scoped reads carry last_activity_at independently of end and scan time", async () => {
    await withAcDb(async (db) => {
      const seed = seeder(db);
      await seed.session("session-1");
      const artifactId = await seed.branch({ branch: "feature/x" });
      await seed.link({
        session: "session-1",
        artifactId,
        method: BRANCH_PUSH_METHOD_VALUES[0],
        observedAt: scanTime,
      });
      await db.run(
        "UPDATE sessions SET last_activity_at = $1 WHERE id = $2",
        recentActivity,
        "session-1"
      );
      const global = await readLocalBranchLinkRows(db.prisma);
      const scoped = await readLocalBranchLinkRowsForBranch(db.prisma, {
        repoFullName: "acme/web",
        branchName: "feature/x",
      });
      assert.equal(global[0]?.sessionLastActivityAt, recentActivity);
      assert.equal(scoped[0]?.sessionLastActivityAt, recentActivity);
      assert.notEqual(global[0]?.activityAt, recentActivity);
    });
  });

  test("old Session-only branches leave the bounded list, usage and analytics cohort", async () => {
    const source = makeSource({
      links: [
        link({
          last_activity_at: oldActivity,
          activity_at: scanTime,
          observed_at: scanTime,
        }),
      ],
    });
    const list = await getSharedBranches(source, request);
    assert.deepEqual(list.items, []);
    assert.equal(list.total, 0);
    const page = await getSharedBranchesPageData(source, request);
    assert.equal(page.list.total, 0);
    assert.equal(
      (await getSharedBranchUsage(source, request)).totalBranches,
      0
    );
    assert.equal(
      (await getSharedBranchAnalytics(source, request)).activeBranchCount.state,
      BranchMetricAvailability.Unavailable
    );
    const allTime = await getSharedBranches(source);
    assert.equal(allTime.items[0]?.canonicalLastActiveAt?.value, oldActivity);
    assert.equal(allTime.items[0]?.lastActivityAt, oldActivity);
  });

  test("latest linked Session wins per branch and reaches list, detail and cohort metrics", async () => {
    const source = makeSource({
      links: [
        link({ session_id: "session-old", last_activity_at: oldActivity }),
        link({
          session_id: "session-recent",
          last_activity_at: recentActivity,
        }),
        link({
          branch_name: "old",
          session_id: "other-session",
          last_activity_at: oldActivity,
        }),
      ],
    });
    const page = await getSharedBranchesPageData(source, request);
    assert.deepEqual(
      page.list.items.map((row) => row.id),
      [branchId]
    );
    const expected = page.list.items[0]?.canonicalLastActiveAt;
    assert.equal(expected?.value, recentActivity);
    assert.equal(expected?.state, BranchMetricAvailability.Partial);
    assert.deepEqual(page.analytics?.canonicalMetrics?.lastActiveAt, expected);
    const detail = await getSharedBranchDetail(source, branchId);
    assert.deepEqual(detail?.canonicalLastActiveAt, expected);
    const cohort = await getSharedBranchCohortAnalytics(source, {
      branchIds: [branchId],
      ...request,
    });
    assert.deepEqual(cohort?.canonicalMetrics.lastActiveAt, expected);
    assert.equal(
      (await getSharedBranchUsage(source, request)).totalBranches,
      1
    );
    assert.equal(
      (await getSharedBranchAnalytics(source, request)).activeBranchCount.value,
      1
    );
  });

  test("canonical monitored, commit and PR timestamps retain precedence over newer sessions", async () => {
    for (const evidence of [
      { canonicalActivity: [canonicalActivity({ occurredAt: oldActivity })] },
      { commits: [commit({ committed_at: oldActivity })] },
      {
        prs: [
          {
            repo_full_name: "acme/web",
            branch_name: "feature/x",
            pr_number: 123,
            opened_at: oldActivity,
          },
        ],
      },
    ]) {
      const source = makeSource({
        links: [link({ last_activity_at: recentActivity })],
        ...evidence,
      });
      const allTime = await getSharedBranches(source);
      assert.equal(allTime.items[0]?.lastActivityAt, oldActivity);
      assert.equal((await getSharedBranches(source, request)).total, 0);
    }
  });

  test("absent, malformed and epoch-default Session timestamps never substitute scan or end time", async () => {
    for (const lastActivityAt of [
      null,
      "not-a-timestamp",
      "",
      SESSION_EPOCH_TIMESTAMP,
    ]) {
      const source = makeSource({
        links: [
          link({
            last_activity_at: lastActivityAt,
            activity_at: scanTime,
            observed_at: scanTime,
          }),
        ],
      });
      const list = await getSharedBranches(source, request);
      assert.equal(list.items[0]?.canonicalLastActiveAt?.value, null);
      assert.equal(
        list.items[0]?.canonicalLastActiveAt?.state,
        BranchMetricAvailability.Unavailable
      );
      assert.equal(list.lastActiveCohort?.retainedUnavailable.value, 1);
    }
  });
});
