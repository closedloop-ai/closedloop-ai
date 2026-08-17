/**
 * ISS-5263: every widget on the Lost-work (ISS-4987) and TokenOps waste
 * (ISS-4988) screens returned "unavailable" in production from the day they
 * shipped, because the grouped reads behind them could not be PLANNED.
 *
 * `WALL_CLOCK_MINUTES` ended in `/ ${SECONDS_PER_MINUTE}` and
 * `FAILURE_THROTTLE_SOURCE` used `Prisma.join(...)` — both emit BOUND
 * PARAMETERS. The same fragments are interpolated into the SELECT list AND the
 * matching GROUP BY, and each interpolation gets a fresh placeholder number
 * (`… / $5` in the SELECT, `… / $9` in the GROUP BY). Postgres compares
 * grouping expressions structurally, sees two different `Param` nodes, and
 * raises:
 *
 *   42803 — column "s.session_ended_at" must appear in the GROUP BY clause
 *           or be used in an aggregate function
 *
 * The unit suites mock `withDb`, so they never plan a statement and CANNOT
 * observe this — which is exactly why an 8-of-8 total failure passed CI. This
 * suite runs the production entry points against a REAL Postgres (self-skips
 * when DATABASE_URL is unset), so the fragments have to survive an actual
 * planner.
 *
 * The load-bearing assertion is `unavailableWidgets: []`: `runWidget` converts
 * any read failure into a settled "unavailable" outcome rather than a
 * rejection, so a 42803 shows up here as a non-empty list, never as a throw.
 * The non-zero data assertions keep it from passing vacuously on a population
 * the seeded rows never reached.
 */

import { randomUUID } from "node:crypto";
import {
  AgentSessionState,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { InsightsScope } from "@repo/api/src/types/insights";
import { LossClass } from "@repo/api/src/types/session-analytics";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { fetchLostWork } from "@/app/insights/lost-work";
import {
  fetchLossGrid,
  fetchLossPersonGrid,
  fetchLossTrendGrid,
  fetchLostSessionCandidates,
} from "@/app/insights/lost-work-queries";
import { fetchTokenOpsWaste } from "@/app/insights/tokenops-waste";
import {
  fetchModelMedianTokens,
  fetchModelSpendGrid,
  fetchSpendGrid,
} from "@/app/insights/tokenops-waste-queries";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// A fixed "now" with the seeded sessions inside the 30-day window, so the run
// is independent of the wall clock it executes on.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const STARTED_AT = new Date("2026-06-10T09:00:00.000Z");
/** 90 minutes of wall clock — the `> 0` grid dimension must see it. */
const ENDED_AT = new Date("2026-06-10T10:30:00.000Z");
/**
 * In the EARLIER half of the 30-day baseline window (which opens 2026-05-16, so
 * the per-engineer split lands around 2026-05-31). `fetchLossPersonGrid` groups
 * on that split by output alias; without a session on each side the grid only
 * ever emits one value for it and the alias would never be exercised as a real
 * grouping key.
 */
const EARLY_STARTED_AT = new Date("2026-05-20T09:00:00.000Z");
const EARLY_ENDED_AT = new Date("2026-05-20T10:30:00.000Z");

type SeedInput = {
  organizationId: string;
  projectId: string;
  userId: string;
  computeTargetId: string;
  endsWithError: boolean | null;
  state: string;
  filesChanged: number;
  /** Left unset to seed the NULL shape a session that never recorded PRs has. */
  pullRequests?: Prisma.InputJsonValue;
  throttleSources?: Prisma.InputJsonValue;
  estimatedCostUsd?: string;
  startedAt?: Date;
  endedAt?: Date;
};

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "iss5263-groupby-machine",
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function seedSession(input: SeedInput): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "ISS-5263 group-by session",
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: "completed",
        type: ArtifactType.SESSION,
      },
      select: { id: true },
    })
  );
  await withDb((db) =>
    db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        computeTargetId: input.computeTargetId,
        endsWithError: input.endsWithError,
        externalSessionId: `iss5263-${artifact.id}`,
        filesChanged: input.filesChanged,
        harness: "claude",
        model: "claude-opus-4",
        pullRequests: input.pullRequests,
        repositoryFullName: "closedloop-ai/symphony-alpha",
        sessionEndedAt: input.endedAt ?? ENDED_AT,
        sessionStartedAt: input.startedAt ?? STARTED_AT,
        sessionUpdatedAt: input.endedAt ?? ENDED_AT,
        state: input.state,
        throttleSources: input.throttleSources,
        userId: input.userId,
      },
    })
  );
  if (input.estimatedCostUsd) {
    await withDb((db) =>
      db.agentSessionTokenUsage.create({
        data: {
          agentSessionId: artifact.id,
          cacheReadTokens: 500n,
          cacheWriteTokens: 100n,
          estimatedCost: input.estimatedCostUsd,
          inputTokens: 1000n,
          model: "claude-opus-4",
          outputTokens: 2000n,
        },
      })
    );
  }
  return artifact.id;
}

/**
 * One systemic loss, one coachable loss, one clean run that produced an
 * artifact, and one still-running session that has burnt wall clock without
 * producing anything — all in the later half of the baseline window — plus a
 * second coachable loss in the EARLIER half. Enough population that every grid
 * dimension the reads group on, including the per-engineer early/late split,
 * has more than one distinct value, so a planner error cannot hide behind a
 * single-bucket result.
 */
async function seedPopulation(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  const base = {
    computeTargetId,
    organizationId,
    projectId,
    userId: user.id,
  };

  // Systemic: errored, no artifact, and a FAILURE-kind throttle recorded.
  //
  // Its `pull_requests` holds an OBJECT rather than an array. The column is
  // `Json?` and free-form, so this shape is reachable, and
  // `jsonb_array_length` raises "cannot get array length of a non-array" on it.
  // `PRODUCED_ARTIFACT` guards that with `CASE`, not with a `jsonb_typeof(...)
  // AND ...` conjunction, because PostgreSQL does not promise `AND`
  // short-circuits. A raise here takes down every grid on the screen.
  await seedSession({
    ...base,
    endsWithError: true,
    estimatedCostUsd: "4.500000",
    filesChanged: 0,
    pullRequests: { note: "free-form JSON that is not a PR array" },
    state: AgentSessionState.Error,
    throttleSources: [
      {
        observedAt: STARTED_AT.toISOString(),
        provider: "anthropic",
        sourceType: SessionTraceThrottleSourceType.ProviderRateLimit,
      },
    ],
  });

  // Actionable: errored, no artifact, no throttle to blame it on.
  await seedSession({
    ...base,
    endsWithError: true,
    estimatedCostUsd: "1.250000",
    filesChanged: 0,
    state: AgentSessionState.Error,
  });

  // Clean: ended without error and produced changed files.
  await seedSession({
    ...base,
    endsWithError: false,
    estimatedCostUsd: "2.000000",
    filesChanged: 7,
    state: AgentSessionState.Completed,
  });

  // Unattributed: still RUNNING, so `outcomeOf` reports Unknown rather than
  // borrowing the `endsWithError: false` the desktop write path stamps on every
  // live row. It burnt wall clock and produced nothing, so the classifier calls
  // it lost. The prefilter's outcome clause used to read
  // `ends_with_error IS DISTINCT FROM false`, which dropped exactly this shape:
  // it was counted in the totals and in the engineer's unattributed column while
  // being structurally unreachable for the table below them (ISS-5263).
  await seedSession({
    ...base,
    endsWithError: false,
    filesChanged: 0,
    state: AgentSessionState.Running,
  });

  // A second coachable loss, in the EARLIER half of the baseline window, so the
  // per-engineer grid groups on both sides of its split.
  await seedSession({
    ...base,
    endedAt: EARLY_ENDED_AT,
    endsWithError: true,
    estimatedCostUsd: "0.750000",
    filesChanged: 0,
    startedAt: EARLY_STARTED_AT,
    state: AgentSessionState.Error,
  });

  return { organizationId, userId: user.id };
}

/**
 * Every grouped read behind the two screens, planned against a real Postgres.
 *
 * Deliberately NOT seeded and NOT wrapped in `autoRollbackTransaction`: these
 * assert that the statement can be PLANNED, which is independent of what rows
 * exist, and running each one on its own pooled connection (as production does)
 * means a failure surfaces as that read's own rejection carrying the verbatim
 * Postgres error. Inside a shared transaction the first 42803 aborts it and
 * every later read fails with a downstream error instead, which would bury the
 * cause the next person needs to see.
 */
describe.skipIf(!hasDatabase)(
  "session-analytics grouped reads plan against a real Postgres (ISS-5263)",
  () => {
    const scope = Prisma.sql`a.organization_id = ${randomUUID()}::uuid`;
    const windowStart = new Date("2026-06-01T00:00:00.000Z");
    const windowEnd = new Date("2026-06-30T23:59:59.000Z");
    const splitAt = new Date("2026-06-15T00:00:00.000Z");

    it("plans the lost-work signal grid", async () => {
      await expect(
        fetchLossGrid(scope, windowStart, windowEnd)
      ).resolves.toEqual([]);
    });

    it("plans the lost-work daily trend grid", async () => {
      const result = await fetchLossTrendGrid(
        scope,
        windowStart,
        windowEnd,
        "America/New_York"
      );
      expect(result.rows).toEqual([]);
    });

    it("plans the lost-work per-engineer grid", async () => {
      await expect(
        fetchLossPersonGrid(scope, windowStart, windowEnd, splitAt)
      ).resolves.toEqual([]);
    });

    it("plans the lost-session candidate scan", async () => {
      await expect(
        fetchLostSessionCandidates(scope, windowStart, windowEnd, 12)
      ).resolves.toEqual([]);
    });

    it("plans the TokenOps spend grid", async () => {
      await expect(
        fetchSpendGrid(scope, windowStart, windowEnd)
      ).resolves.toEqual([]);
    });

    it("plans the TokenOps per-model spend grid", async () => {
      await expect(
        fetchModelSpendGrid(scope, windowStart, windowEnd)
      ).resolves.toEqual([]);
    });

    it("plans the TokenOps per-model median read", async () => {
      await expect(
        fetchModelMedianTokens(scope, windowStart, windowEnd)
      ).resolves.toEqual([]);
    });
  }
);

describe.skipIf(!hasDatabase)(
  "session-analytics screens over a seeded population (ISS-5263)",
  () => {
    it("resolves every Lost-work widget instead of failing the GROUP BY", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId, userId } = await seedPopulation();

        const result = await fetchLostWork(
          {
            organizationId,
            scope: InsightsScope.Org,
            timeZone: "UTC",
            userId,
          },
          InsightsPeriod.Month,
          NOW
        );

        // Before the fix every one of these reads raised 42803 and settled
        // unavailable, blanking the whole screen.
        expect(result.unavailableWidgets).toEqual([]);

        // ...and the reads actually described the seeded population, so the
        // empty list above is not an empty-result artifact.
        expect(result.totals.sessionCount).toBe(5);
        expect(result.totals.sessionsByClass[LossClass.Systemic]).toBe(1);
        expect(result.totals.sessionsByClass[LossClass.Actionable]).toBe(2);
        expect(result.totals.sessionsByClass[LossClass.Unattributed]).toBe(1);
        expect(
          result.totals.minutesByClass[LossClass.Systemic]
        ).toBeGreaterThan(0);
        expect(result.totals.totalMinutes).toBeGreaterThan(0);
        expect(result.totals.productiveMinutes).toBeGreaterThan(0);
        expect(result.systemicCauses.length).toBeGreaterThan(0);
        expect(result.behavioralCauses.length).toBeGreaterThan(0);
        // Every lost session the totals above counted also reaches the table:
        // the systemic one, both coachable ones, and the unattributed
        // still-running one. Both halves of ISS-5263's totals-vs-table split
        // are covered here rather than asserted in passing. The seeded rows
        // leave `pull_requests` NULL — the shape a session that never recorded
        // a PR array actually has — which made `PRODUCED_ARTIFACT` evaluate to
        // NULL and `NOT NULL` drop them from the prefilter; the running row
        // carries `ends_with_error: false`, which the prefilter's old outcome
        // clause dropped; and the systemic row holds a non-array
        // `pull_requests`, which `jsonb_array_length` raises on unless the type
        // test is a `CASE`. Any of the three leaves the table short of this
        // count, or settles the whole screen unavailable.
        expect(result.lostSessions.length).toBe(4);
        expect(
          result.lostSessions.filter(
            (row) => row.lossClass === LossClass.Unattributed
          )
        ).toHaveLength(result.totals.sessionsByClass[LossClass.Unattributed]);
        expect(result.trend.length).toBeGreaterThan(0);
        expect(result.people.length).toBe(1);
      });
    });

    it("resolves the Lost-work per-engineer grid, whose split bound is a per-request parameter", async () => {
      // `fetchLossPersonGrid` projects `(session_started_at < $splitAt)` and
      // groups by its OUTPUT ALIAS. Repeating the expression in the GROUP BY
      // renders a second placeholder and reintroduces 42803 — a parameter-free
      // fragment cannot express a per-request bound, so the alias is the fix.
      await autoRollbackTransaction(async () => {
        const { organizationId, userId } = await seedPopulation();

        const result = await fetchLostWork(
          {
            organizationId,
            scope: InsightsScope.Org,
            timeZone: "UTC",
            userId,
          },
          InsightsPeriod.Month,
          NOW
        );

        expect(result.unavailableWidgets).toEqual([]);
        expect(result.people).toHaveLength(1);
        expect(result.people[0]?.sessionCount).toBe(5);
        expect(result.people[0]?.systemicSessions).toBe(1);
        // Two coachable losses, one on each side of the early/late split — the
        // grid must emit both buckets and the fold must sum them.
        expect(result.people[0]?.actionableSessions).toBe(2);
        expect(result.people[0]?.unattributedSessions).toBe(1);
      });
    });

    it("resolves every TokenOps waste widget instead of failing the GROUP BY", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId, userId } = await seedPopulation();

        const result = await fetchTokenOpsWaste(
          {
            organizationId,
            scope: InsightsScope.Org,
            timeZone: "UTC",
            userId,
          },
          InsightsPeriod.Month,
          NOW
        );

        expect(result.unavailableWidgets).toEqual([]);
        expect(result.totalSpendUsd).toBeGreaterThan(0);
        expect(result.outcomes.length).toBeGreaterThan(0);
        expect(result.models.length).toBeGreaterThan(0);
        // The recoverable-waste basis is the errored-and-lost spend: $4.50 +
        // $1.25. A planner failure would have settled this unavailable and
        // reported an empty range instead.
        expect(result.waste.highUsd).toBeGreaterThan(0);
      });
    });

    it("resolves the same reads scoped to a single engineer", async () => {
      // The `Me` scope appends `s.user_id = $n::uuid` to the WHERE clause,
      // shifting every downstream placeholder number. The grouped fragments
      // must render identically regardless of how many parameters precede them.
      await autoRollbackTransaction(async () => {
        const { organizationId, userId } = await seedPopulation();
        const ctx = {
          organizationId,
          scope: InsightsScope.Me,
          timeZone: "America/New_York",
          userId,
        };

        const lostWork = await fetchLostWork(ctx, InsightsPeriod.Month, NOW);
        const tokenOps = await fetchTokenOpsWaste(
          ctx,
          InsightsPeriod.Month,
          NOW
        );

        expect(lostWork.unavailableWidgets).toEqual([]);
        expect(tokenOps.unavailableWidgets).toEqual([]);
        expect(lostWork.totals.sessionCount).toBe(5);
        expect(tokenOps.totalSpendUsd).toBeGreaterThan(0);
      });
    });
  }
);
