import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BranchStatus } from "@repo/api/src/types/branch.js";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution.js";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { projectCanonicalBranchListMetrics } from "@repo/lib/branches/branch-list-metric-projection";
import { readCanonicalBranchMetricEventRows } from "../src/main/branch/branch-metric-event-read.js";
import { buildBranchAnalyticsResult } from "../src/main/branch/shared-branches-api.js";
import {
  readBranchAnalyticsActivitySegmentRows,
  readBranchAnalyticsLifecycleEventRows,
} from "../src/main/database/branch-analytics-phase-evidence.js";
import {
  readBranchAnalyticsTokenRows,
  readBranchUsageEventRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchPrRows,
} from "../src/main/database/branch-reads.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

const endIso = "2026-07-01T00:00:00.000Z";
const periodDays = [7, 30, 90] as const;

describe("Desktop Branch analytics bounded-read parity", () => {
  for (const days of periodDays) {
    test(`${days}d preserves canonical numbers and defeats naive request-window bounding`, async () => {
      await withParityFixture(days, false, async (fixture) => {
        const baseline = await projectWithRows(
          fixture,
          await readBranchUsageEventRows(fixture.db.prisma)
        );
        const boundedRead = await readCanonicalBranchMetricEventRows(
          fixture.db,
          fixture.request,
          fixture.boundary
        );
        const bounded = await projectWithMetricRead(fixture, boundedRead);
        assert.deepEqual(bounded.canonicalMetrics, baseline.canonicalMetrics);
        const baselineCostMetric = projectCostMetric(
          await readBranchUsageEventRows(fixture.db.prisma),
          fixture
        );
        const boundedCostMetric = projectCostMetric(boundedRead.rows, fixture);
        assert.deepEqual(boundedCostMetric, baselineCostMetric);
        assert.equal(baselineCostMetric.current.value, 0);
        assert.equal(baselineCostMetric.comparison?.deltaPct.value, -100);

        const naiveRows = await readBranchUsageEventRows(fixture.db.prisma, {
          startIso: fixture.request.startDate,
          endIso: fixture.request.endDate,
        });
        const naiveCostMetric = projectCostMetric(naiveRows, fixture);
        assert.notDeepEqual(
          naiveCostMetric.comparison,
          baselineCostMetric.comparison
        );
      });
    });

    test(`${days}d preserves full-read availability provenance`, async () => {
      await withParityFixture(days, true, async (fixture) => {
        const baseline = await projectWithRows(
          fixture,
          await readBranchUsageEventRows(fixture.db.prisma)
        );
        const bounded = await projectWithMetricRead(
          fixture,
          await readCanonicalBranchMetricEventRows(
            fixture.db,
            fixture.request,
            fixture.boundary
          )
        );
        assert.deepEqual(bounded.canonicalMetrics, baseline.canonicalMetrics);
      });
    });
  }

  test("All preserves the full-read canonical numbers", async () => {
    await withParityFixture(null, false, async (fixture) => {
      const baseline = await projectWithRows(
        fixture,
        await readBranchUsageEventRows(fixture.db.prisma)
      );
      const bounded = await projectWithMetricRead(
        fixture,
        await readCanonicalBranchMetricEventRows(
          fixture.db,
          fixture.request,
          fixture.boundary
        )
      );
      assert.deepEqual(bounded.canonicalMetrics, baseline.canonicalMetrics);
      assert.equal(baseline.canonicalMetrics?.aiSpendUsd.current.value, 30);
    });
  });

  test("All preserves full-read availability provenance", async () => {
    await withParityFixture(null, true, async (fixture) => {
      const baseline = await projectWithRows(
        fixture,
        await readBranchUsageEventRows(fixture.db.prisma)
      );
      const bounded = await projectWithMetricRead(
        fixture,
        await readCanonicalBranchMetricEventRows(
          fixture.db,
          fixture.request,
          fixture.boundary
        )
      );
      assert.deepEqual(bounded.canonicalMetrics, baseline.canonicalMetrics);
    });
  });
});

async function withParityFixture(
  days: number | null,
  outsideEvidence: boolean,
  run: (fixture: ParityFixture) => Promise<void>
): Promise<void> {
  await withAcDb(async (db) => {
    const seed = seeder(db);
    const artifactId = await seed.branch({ branch: "feature/x" });
    await seed.session("session-1");
    await seed.link({
      session: "session-1",
      artifactId,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await seed.tokens("session-1", 100);
    await insertSegment(db);

    const durationDays = days ?? 30;
    if (days === null || outsideEvidence) {
      await insertEvent(db, daysBeforeEnd(durationDays / 2), 20, 20);
    }
    await insertEvent(db, daysBeforeEnd(durationDays * 1.5), 10, 10);
    if (outsideEvidence) {
      await insertEvent(db, daysBeforeEnd(durationDays * 2.5), null, 1);
      await insertEvent(db, daysBeforeEnd(durationDays * 2.6), 0, 1);
      await insertEvent(db, daysBeforeEnd(durationDays * 2.7), 0.000_000_4, 1);
      await insertEvent(db, daysBeforeEnd(durationDays * 2.8), 0.000_000_4, 1);
      await insertEvent(db, "2026-07-02T00:00:00.000Z", null, 1);
      await insertEvent(db, "not-a-timestamp", 5, -1);
    }

    const request =
      days === null
        ? {}
        : {
            startDate: daysBeforeEnd(days),
            endDate: endIso,
          };
    await run({ db, request, boundary: new Date(endIso) });
  });
}

function projectCostMetric(
  rows: Awaited<ReturnType<typeof readBranchUsageEventRows>>,
  fixture: ParityFixture
) {
  return projectCanonicalBranchListMetrics({
    branches: [
      {
        id: "branch-1",
        status: BranchStatus.Open,
        lastActivityAt: null,
      },
    ],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    lastActiveCoverageComplete: false,
    costContributions: rows.flatMap((row) =>
      row.costUsdEstimated !== null &&
      Number.isFinite(row.costUsdEstimated) &&
      row.costUsdEstimated >= 0
        ? [
            {
              sourceEventId:
                row.eventFingerprint ?? row.eventRowId ?? row.createdAt ?? "",
              branchId: "branch-1",
              sessionId: row.sessionId,
              occurredAt: row.createdAt,
              phase: BranchVisibleLifecyclePhase.Build,
              costUsd: row.costUsdEstimated,
              qualifyingBranchCount: 1,
            },
          ]
        : []
    ),
    costCompleteBranchIds: ["branch-1"],
    startDate: fixture.request.startDate,
    endDate: fixture.request.endDate,
    now: fixture.boundary,
  }).aiSpendUsd;
}

async function projectWithRows(
  fixture: ParityFixture,
  rows: Awaited<ReturnType<typeof readBranchUsageEventRows>>
) {
  const activitySegments = await readBranchAnalyticsActivitySegmentRows(
    fixture.db.prisma
  );
  return projectWithMetricRead(fixture, {
    rows,
    requestBoundary: fixture.boundary,
    activitySegments,
  });
}

async function projectWithMetricRead(
  fixture: ParityFixture,
  metricEventRead: Awaited<
    ReturnType<typeof readCanonicalBranchMetricEventRows>
  >
) {
  const [linkRows, prRows, commitRows, usageTokenRows, lifecycleEvidence] =
    await Promise.all([
      readLocalBranchLinkRows(fixture.db.prisma),
      readLocalBranchPrRows(fixture.db.prisma),
      readLocalBranchCommitRows(fixture.db.prisma),
      readBranchAnalyticsTokenRows(fixture.db.prisma),
      readBranchAnalyticsLifecycleEventRows(fixture.db.prisma),
    ]);
  const activityRows = await fixture.db.readBranchCanonicalActivityRows({
    branchKeys: linkRows.map(({ repoFullName, branchName }) => ({
      repoFullName,
      branchName,
    })),
  });
  return buildBranchAnalyticsResult(
    fixture.db.prisma,
    linkRows,
    prRows,
    commitRows,
    activityRows,
    usageTokenRows,
    fixture.request,
    undefined,
    metricEventRead,
    metricEventRead.activitySegments,
    lifecycleEvidence
  );
}

async function insertSegment(db: ParityFixture["db"]): Promise<void> {
  await db.run(
    `INSERT INTO session_activity_segments
       (id, session_id, phase, start_ms, end_ms, confidence,
        evidence_layers, version, observed_at)
     VALUES ('segment-1', 'session-1', 'implement', $1, $2, 1, '[]', 1, $3)`,
    Date.parse("2025-12-01T00:00:00.000Z"),
    Date.parse("2026-08-01T00:00:00.000Z"),
    "2026-06-01T00:00:00.000Z"
  );
}

async function insertEvent(
  db: ParityFixture["db"],
  createdAt: string,
  cost: number | null,
  inputTokens: number
): Promise<void> {
  await db.run(
    `INSERT INTO token_events
       (session_id, model, created_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd_estimated)
     VALUES ('session-1', 'test-model', $1, $2, 0, 0, 0, $3)`,
    createdAt,
    inputTokens,
    cost
  );
}

function daysBeforeEnd(days: number): string {
  return new Date(
    Date.parse(endIso) - days * 24 * 60 * 60 * 1000
  ).toISOString();
}

type ParityFixture = {
  db: Parameters<Parameters<typeof withAcDb>[0]>[0];
  request: { startDate?: string; endDate?: string };
  boundary: Date;
};
