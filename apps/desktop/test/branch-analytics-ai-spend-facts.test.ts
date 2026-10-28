import { BranchKpiState } from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import { readBranchCostMetricFacts } from "../src/main/database/branch-cost-window-reads.js";
import { readSessionBranchCounts } from "../src/main/database/branch-reads.js";
import { BRANCH_WRITE_METHOD_VALUES } from "../src/main/database/db-constants.js";
import { type AcDb, seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

vi.mock(
  "../src/main/branch/shared-branches-default-eligibility.js",
  async (importOriginal) =>
    (
      await import("./helpers/complete-eligibility-snapshot.js")
    ).withCompleteEligibility(await importOriginal())
);

vi.mock("../src/main/database/branch-reads.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/database/branch-reads.js")
    >();
  return {
    ...actual,
    readSessionBranchCounts: vi.fn(actual.readSessionBranchCounts),
  };
});

vi.mock(
  "../src/main/database/branch-cost-window-reads.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/main/database/branch-cost-window-reads.js")
      >();
    return {
      ...actual,
      readBranchCostMetricFacts: vi.fn(actual.readBranchCostMetricFacts),
    };
  }
);

/**
 * ISS-12361: the AI spend card is the SQL fold, so it does not stop at the
 * 900-session cap the contribution fold needed for SQLite's old parameter limit.
 */

const OLD_SESSION_CAP = 900;
const SESSION_COUNT = OLD_SESSION_CAP + 100;
const EVENT_AT = "2026-06-01T12:00:00.000Z";
const WRITE = BRANCH_WRITE_METHOD_VALUES[0];

describe("Desktop Branches AI spend card", () => {
  it("sums every linked session, past the old 900-session cap", async () => {
    await withAcDb(async (db) => {
      await seedBranchWithSessions(db, SESSION_COUNT, 2);

      const analytics = await getSharedBranchAnalytics(db, {});

      expect(analytics.canonicalMetrics?.aiSpendUsd.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: SESSION_COUNT * 2,
      });
    });
  }, 120_000);

  it("hands every linked session to the branch-count read, with no 900-session slice", async () => {
    await withAcDb(async (db) => {
      vi.mocked(readSessionBranchCounts).mockClear();
      await seedBranchWithSessions(db, SESSION_COUNT, 2);

      await getSharedBranchAnalytics(db, {});

      const sessionIds = vi.mocked(readSessionBranchCounts).mock.calls[0]?.[1];
      expect(sessionIds).toHaveLength(SESSION_COUNT);
    });
  }, 120_000);

  it("fills the legacy spend KPIs from the cards, so spend is derived once", async () => {
    await withAcDb(async (db) => {
      await seedBranchWithSessions(db, 3, 2);

      const analytics = await getSharedBranchAnalytics(db, {});

      expect(analytics.canonicalMetrics?.aiSpendUsd.current.value).toBe(6);
      expect(analytics.totalSpendUsd).toMatchObject({
        state: BranchKpiState.Available,
        value: 6,
      });
      expect(analytics.locPerDollar.value).toBe(
        analytics.canonicalMetrics?.locPerDollar.current.value ?? null
      );
    });
  });

  it("reports a measured zero spend as unavailable on the legacy KPI (ISS-4737)", async () => {
    await withAcDb(async (db) => {
      await seedBranchWithSessions(db, 2, 0);

      const analytics = await getSharedBranchAnalytics(db, {});

      expect(analytics.canonicalMetrics?.aiSpendUsd.current).toMatchObject({
        state: BranchMetricAvailability.Complete,
        value: 0,
      });
      expect(analytics.totalSpendUsd).toMatchObject({
        state: BranchKpiState.Unavailable,
        value: null,
      });
    });
  });

  it("names the figure partial when a session holds an event it cannot price", async () => {
    await withAcDb(async (db) => {
      await seedBranchWithSessions(db, 3, 2);
      await db.run(
        `INSERT INTO token_events
           (session_id, transport_id, model, created_at, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens,
            cost_usd_estimated)
         VALUES ('session-0', 'unpriced', 'm1', $1, 1, 0, 0, 0, NULL)`,
        EVENT_AT
      );

      const analytics = await getSharedBranchAnalytics(db, {});

      expect(analytics.canonicalMetrics?.aiSpendUsd.current).toMatchObject({
        state: BranchMetricAvailability.Partial,
        value: 6,
      });
    });
  });

  // The even-split divisor is the whole eligible set on BOTH shells, so
  // narrowing the list must not move the figure: web reads it from
  // `branchListQuerySchema.parse({})` (branch-cohort-cost-facts.ts), which no
  // request filter reaches. A divisor that shrank with the filter would report
  // the session's whole $10 against whichever branch survived it.
  it("keeps the shared-session split on the whole eligible set when a search narrows the list", async () => {
    await withAcDb(async (db) => {
      await seedSharedSessionAcrossBranches(db);

      const unfiltered = await getSharedBranchAnalytics(db, {});
      const searched = await getSharedBranchAnalytics(db, { search: "alpha" });

      expect(unfiltered.canonicalMetrics?.aiSpendUsd.current.value).toBe(10);
      expect(searched.canonicalMetrics?.aiSpendUsd.current.value).toBe(5);
    });
  });

  it("reports an unavailable spend card, not a dead analytics payload, when the fold throws", async () => {
    await withAcDb(async (db) => {
      await seedBranchWithSessions(db, 2, 2);
      vi.mocked(readBranchCostMetricFacts).mockRejectedValueOnce(
        new Error("store is busy")
      );

      const analytics = await getSharedBranchAnalytics(db, {});

      expect(analytics.canonicalMetrics?.aiSpendUsd.current).toMatchObject({
        state: BranchMetricAvailability.Unavailable,
      });
      // The rest of the payload survives: a failed cost read takes the spend
      // card, never every other card with it.
      expect(analytics.canonicalMetrics?.activeBranches.current).toMatchObject({
        state: BranchMetricAvailability.Complete,
      });
    });
  });
});

/** One session writing to two eligible branches, holding a single $10 event. */
async function seedSharedSessionAcrossBranches(db: AcDb): Promise<void> {
  const seed = seeder(db);
  await seed.session("session-shared");
  for (const branch of ["feature/alpha", "feature/beta"]) {
    const artifactId = await seed.branch({ branch });
    await seed.link({
      session: "session-shared",
      artifactId,
      method: WRITE,
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  await db.run(
    `INSERT INTO token_events
       (session_id, transport_id, model, created_at, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd_estimated)
     VALUES ('session-shared', 'shared:event', 'm1', $1, 10, 0, 0, 0, 10)`,
    EVENT_AT
  );
}

async function seedBranchWithSessions(
  db: AcDb,
  sessions: number,
  costPerSession: number
): Promise<void> {
  const seed = seeder(db);
  const artifactId = await seed.branch({ branch: "feature/x" });
  for (let index = 0; index < sessions; index++) {
    const id = `session-${index}`;
    await seed.session(id);
    await seed.link({
      session: id,
      artifactId,
      method: WRITE,
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    await db.run(
      `INSERT INTO token_events
         (session_id, transport_id, model, created_at, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd_estimated)
       VALUES ($1, $2, 'm1', $3, 10, 0, 0, 0, $4)`,
      id,
      `${id}:event`,
      EVENT_AT,
      costPerSession
    );
  }
}
