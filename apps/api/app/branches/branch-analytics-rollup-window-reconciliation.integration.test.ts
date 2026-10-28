/**
 * ISS-9899 — a windowed Branch spend read must give the same numbers whether
 * the daily rollup answers it or the source events do.
 *
 * `resolveSessionEventEvidence` takes the rollup when it is fresh and falls
 * back to aggregating `agent_session_token_events` when it is not, so the two
 * paths serve the same request depending only on rollup freshness. Each case
 * reads one window through that shipping caller twice — before the producer has
 * run (no state row, so the source path) and after (the rollup path) — and
 * requires identical per-session spend for both of a branch's sessions, plus
 * the totals each window's own event list implies on both paths.
 *
 * The one input on which the two paths legitimately differ is an event received
 * after the producer's cutoff: the rollup cannot see it yet and the source can.
 * The last case pins what the shipping caller reports for that.
 *
 * Fixtures are anchored behind the WALL clock, as in
 * `branch-analytics-rollup-consumer.integration.test.ts`, because the shipping
 * caller has no clock argument and judges freshness with `new Date()`.
 */
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  buildEvent,
  SEEDED_SYNCED_AT,
  type SeededBranchSession,
  type SeededEvent,
  seedLinkedBranchSession,
  seedTokenEvents,
  totalsFor,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-fixtures";
import {
  autoRollbackTransactionJoining,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  readMaterializedBranchEventAggregates,
  refreshBranchAnalyticsRollupBatch,
} from "@/app/branches/branch-analytics-rollup";
import {
  type BranchAnalyticsRollupDateWindow,
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
} from "@/app/branches/branch-analytics-rollup-contract";
import {
  type LinkedSession,
  readSessionUsageLinks,
} from "@/app/branches/branch-read-service/session-usage-link-read";
import type { ResolvedSessionSpend } from "@/app/branches/branch-read-service/session-usage-window";
import { resolveSessionEventEvidence } from "@/app/branches/branch-session-cost-evidence";

const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases compare the numbers two read paths return for one window, not the producer's per-batch commit boundary or its timeout"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REFRESH_AT = new Date(Date.now() - 5 * 60 * 1000);
const RECEIVED_AT = new Date(REFRESH_AT.getTime() - 60 * 1000);
const RECEIVED_LATE = new Date(REFRESH_AT.getTime() + 60 * 1000);
const TODAY = new Date(
  Date.UTC(
    REFRESH_AT.getUTCFullYear(),
    REFRESH_AT.getUTCMonth(),
    REFRESH_AT.getUTCDate()
  )
);
/** Under the tier's 30s `testTimeout`; each case seeds two sessions and reads four times. */
const RECONCILIATION_TX_TIMEOUT_MS = 20_000;
/** The second session's weights, so an edge row credited to the wrong session changes both totals. */
const SECOND_SESSION_SCALE = 3;

// [daysBack, hour]. The hour-0 events sit on the UTC-midnight seams where the
// rollup splits a window into partial edge days and whole buckets, and the
// hour-12 events sit exactly on the partial window's bounds, so an off-by-one
// inclusivity bound on either path counts or drops one of them.
const EVENT_TIMES = [
  [3, 8],
  [3, 12],
  [3, 18],
  [2, 0],
  [2, 8],
  [2, 18],
  [1, 0],
  [1, 8],
  [1, 12],
  [1, 18],
] as const;

const ALL_TIME_WINDOW: BranchAnalyticsRollupDateWindow = {
  startDate: at(365, 0),
  endDate: lastInstantOf(0),
};

type WindowCase = {
  name: string;
  window: BranchAnalyticsRollupDateWindow;
  includes: number[];
};

const PARTIAL_DAYS: WindowCase = {
  name: "partial first and last day",
  window: { startDate: at(3, 12), endDate: at(1, 12) },
  includes: range(1, 8),
};

// `includes` indexes EVENT_TIMES. Event `i` carries 2^i input tokens, and the
// same weight shifted into each other column, so each window's expected totals
// name exactly which events it must contain.
const WINDOWS: WindowCase[] = [
  { name: "all-time", window: ALL_TIME_WINDOW, includes: range(0, 9) },
  {
    name: "single whole day",
    window: { startDate: at(2, 0), endDate: lastInstantOf(2) },
    includes: [3, 4, 5],
  },
  PARTIAL_DAYS,
  {
    name: "open-start whole-day",
    window: { endDate: lastInstantOf(2) },
    includes: range(0, 5),
  },
  {
    name: "open-start partial-day",
    window: { endDate: at(1, 12) },
    includes: range(0, 8),
  },
  {
    name: "open-end partial-day",
    window: { startDate: at(2, 12) },
    includes: range(5, 9),
  },
];

// Inside PARTIAL_DAYS but received after the producer's cutoff: one in a whole
// daily bucket, one on the partial head day, so both halves of the rollup's
// answer have to leave it out.
const LATE_ARRIVALS: SeededEvent[] = [at(2, 6), at(3, 15)].map(
  (eventCreatedAt, index) =>
    buildEvent({
      suffix: `iss9899-late-${index}`,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 1,
      eventCreatedAt,
      createdAt: RECEIVED_LATE,
    })
);

describeIfDb("branch rollup windowed read reconciliation (ISS-9899)", () => {
  it.each(WINDOWS)(
    "answers the $name window identically from the rollup and from the source events",
    async ({ window, includes }) => {
      await joinAmbientTransaction(
        async () => {
          const seed = await seedTwoSessionBranch("iss9899-reconcile");

          expect((await readRollup(seed, window)).status).toBe(
            BranchAnalyticsRollupReadStatus.Unavailable
          );
          const fromSource = await readWindowedSpend(seed, window);

          await refreshBranchAnalyticsRollupBatch({
            organizationId: seed.organizationId,
            now: REFRESH_AT,
          });
          const rollup = await readRollup(seed, window);
          if (rollup.status !== BranchAnalyticsRollupReadStatus.Available) {
            throw new Error(
              `expected an available rollup read, got ${rollup.reason}`
            );
          }
          const fromRollup = await readWindowedSpend(seed, window);

          const scales: [string, number][] = [
            [seed.sessionArtifactId, 1],
            [seed.secondSessionArtifactId, SECOND_SESSION_SCALE],
          ];
          for (const [sessionId, scale] of scales) {
            expect(fromSource.get(sessionId)).toEqual(
              expectedSpend(includes, scale)
            );
            // Taken off the rollup rows directly, so a caller that stopped
            // taking the rollup branch cannot make these agree by construction.
            expect(totalsFor(rollup.rows, sessionId)).toEqual(
              expectedRollupTotals(includes, scale)
            );
          }
          expect(fromRollup).toEqual(fromSource);
        },
        { timeout: RECONCILIATION_TX_TIMEOUT_MS }
      );
    }
  );

  it("answers an all-time window with the unwindowed lifetime rollup total", async () => {
    await joinAmbientTransaction(
      async () => {
        const seed = await seedTwoSessionBranch("iss9899-lifetime");
        await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: REFRESH_AT,
        });

        const lifetime = await withDb((db) =>
          readMaterializedBranchEventAggregates(
            db,
            seed.organizationId,
            seed.sessions.map((session) => session.artifactId),
            undefined
          )
        );
        if (lifetime.status !== BranchAnalyticsRollupReadStatus.Available) {
          throw new Error(
            `expected an available lifetime rollup read, got ${lifetime.reason}`
          );
        }
        const allTime = await readWindowedSpend(seed, ALL_TIME_WINDOW);

        for (const session of seed.sessions) {
          const lifetimeTotals = totalsFor(lifetime.rows, session.artifactId);
          expect(lifetimeTotals.eventCount).toBe(EVENT_TIMES.length);
          expect(allTime.get(session.artifactId)).toEqual({
            inputTokens: lifetimeTotals.inputTokens,
            outputTokens: lifetimeTotals.outputTokens,
            cacheReadTokens: lifetimeTotals.cacheReadTokens,
            cacheWriteTokens: lifetimeTotals.cacheWriteTokens,
            estimatedCostUsd: lifetimeTotals.estimatedCost,
            hasPricedCost: true,
          });
        }
      },
      { timeout: RECONCILIATION_TX_TIMEOUT_MS }
    );
  });

  it("reports coverage incomplete for an in-window event received after the rollup's cutoff", async () => {
    await joinAmbientTransaction(
      async () => {
        const seed = await seedTwoSessionBranch("iss9899-late");
        await seedTokenEvents(seed.sessionArtifactId, LATE_ARRIVALS);
        const { window, includes } = PARTIAL_DAYS;

        // Control: the source aggregate and the evidence sample both carry the
        // late events, so the populations reconcile.
        const fromSource = await readCostEvidence(seed, window);
        expect(
          fromSource.contributions.some(
            (contribution) => contribution.coverageIncomplete
          )
        ).toBe(false);

        await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: REFRESH_AT,
        });
        const fromRollup = await readCostEvidence(seed, window);

        // The rollup stops at its `as_of` and the evidence sample does not, so
        // the caller flags the gap and falls back to the subtotal the rollup
        // did materialize. `closeTo` because the two sessions' subtotals are
        // added in floating point; 6 digits is the cost column's scale.
        expect(fromRollup.contributions).toEqual([
          {
            coverageIncomplete: true,
            fallbackSubtotalUsd: expect.closeTo(
              expectedSpend(includes, 1).estimatedCostUsd +
                expectedSpend(includes, SECOND_SESSION_SCALE).estimatedCostUsd,
              6
            ),
          },
        ]);
      },
      { timeout: RECONCILIATION_TX_TIMEOUT_MS }
    );
  });
});

function at(daysBack: number, hour: number): Date {
  return new Date(TODAY.getTime() - daysBack * DAY_MS + hour * HOUR_MS);
}

function lastInstantOf(daysBack: number): Date {
  return new Date(at(daysBack - 1, 0).getTime() - 1);
}

function range(first: number, last: number): number[] {
  return Array.from(
    { length: last - first + 1 },
    (_, offset) => first + offset
  );
}

function eventsScaledBy(scale: number): SeededEvent[] {
  return EVENT_TIMES.map(([daysBack, hour], index) =>
    buildEvent({
      suffix: `iss9899-${index}`,
      inputTokens: scale * 2 ** index,
      outputTokens: scale * 2 ** (index + 10),
      cacheReadTokens: scale * 2 ** (index + 20),
      cacheWriteTokens: scale * 2 ** (index + 30),
      estimatedCost: (scale * 2 ** index) / 100,
      eventCreatedAt: at(daysBack, hour),
      createdAt: RECEIVED_AT,
    })
  );
}

type TwoSessionBranch = SeededBranchSession & {
  secondSessionArtifactId: string;
  sessions: LinkedSession[];
};

async function seedTwoSessionBranch(label: string): Promise<TwoSessionBranch> {
  const seed = await seedLinkedBranchSession({
    label,
    events: eventsScaledBy(1),
  });
  const secondSessionArtifactId = await linkValidSessionToBranch({
    organizationId: seed.organizationId,
    userId: seed.userId,
    branchArtifactId: seed.branchArtifactId,
    label: `${label}-second`,
    linkKind: SessionArtifactLinkKind.SessionPr,
    lastSyncedAt: SEEDED_SYNCED_AT,
  });
  await seedTokenEvents(
    secondSessionArtifactId,
    eventsScaledBy(SECOND_SESSION_SCALE)
  );
  const links = await withDb((db) =>
    readSessionUsageLinks(db, seed.organizationId, [seed.branchArtifactId], {
      includeReviewedIdentityEvidence: false,
    })
  );
  const sessions = links.flatMap<LinkedSession>((link) =>
    link.source.session ? [link.source.session] : []
  );
  if (sessions.length !== 2) {
    throw new Error(`expected two linked sessions, got ${sessions.length}`);
  }
  return { ...seed, secondSessionArtifactId, sessions };
}

function readRollup(
  seed: TwoSessionBranch,
  window: BranchAnalyticsRollupDateWindow
): Promise<BranchAnalyticsRollupReadResult> {
  return withDb((db) =>
    readMaterializedBranchEventAggregates(
      db,
      seed.organizationId,
      seed.sessions.map((session) => session.artifactId),
      window
    )
  );
}

async function readWindowedSpend(
  seed: TwoSessionBranch,
  window: BranchAnalyticsRollupDateWindow
): Promise<Map<string, ResolvedSessionSpend>> {
  const evidence = await withDb((db) =>
    resolveSessionEventEvidence(
      db,
      seed.organizationId,
      seed.sessions,
      window,
      {
        includeCostEvidence: false,
      }
    )
  );
  if (!evidence.windowedSpend) {
    throw new Error("expected a windowed read to return windowed spend");
  }
  return evidence.windowedSpend;
}

/** The option shape the Branch read passes whenever it asks for cost completeness. */
function readCostEvidence(
  seed: TwoSessionBranch,
  window: BranchAnalyticsRollupDateWindow
) {
  return withDb((db) =>
    resolveSessionEventEvidence(
      db,
      seed.organizationId,
      seed.sessions,
      window,
      {
        includeCostEvidence: true,
      }
    )
  );
}

/** What `eventsScaledBy(scale)` puts in the window, derived from its weights. */
function expectedSpend(
  includes: readonly number[],
  scale: number
): ResolvedSessionSpend {
  const weight =
    scale * includes.reduce((total, index) => total + 2 ** index, 0);
  return {
    inputTokens: weight,
    outputTokens: weight * 2 ** 10,
    cacheReadTokens: weight * 2 ** 20,
    cacheWriteTokens: weight * 2 ** 30,
    estimatedCostUsd: weight / 100,
    hasPricedCost: true,
  };
}

function expectedRollupTotals(includes: readonly number[], scale: number) {
  const spend = expectedSpend(includes, scale);
  return {
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    cacheReadTokens: spend.cacheReadTokens,
    cacheWriteTokens: spend.cacheWriteTokens,
    estimatedCost: spend.estimatedCostUsd,
    eventCount: includes.length,
  };
}
