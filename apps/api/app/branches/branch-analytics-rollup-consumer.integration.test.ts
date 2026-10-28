/**
 * ISS-9919 — the Branch analytics rollup driven through the call shape that
 * actually SHIPS, and the queue dedup that shape depends on.
 *
 * `branch-analytics-rollup.integration.test.ts` reaches the materialized read
 * through `readMaterializedBranchEventAggregates(db, org, ids, undefined, now)`
 * — five arguments, the last of them an injected clock. No production caller
 * passes that fifth argument: `resolveSessionEventEvidence` calls the reader
 * with four, the reader defaults to `new Date()`, and
 * `ResolveSessionEventEvidenceOptions` has no `now` to thread. Fixtures pinned
 * to a fixed calendar date are therefore weeks past the staleness floor by the
 * time the SHIPPING caller reads them, so through it those same rows take the
 * raw-aggregate fallback and the materialized path is never exercised.
 *
 * So: no injected read clock and no `setSystemTime` here either. Every fixture
 * is anchored a few minutes behind the WALL clock, which is what makes the
 * rollup state legitimately fresh when the consumer reads it. The producer
 * still takes `now` — that argument ships, the cron passes it — and nothing
 * about the assertions below depends on which UTC day the run lands in, so the
 * ISS-9831 re-grain from one row per session lifetime to one row per session
 * per day changes none of them.
 *
 * Runs inside `autoRollbackTransaction`; `withDb`/`withDb.tx` join the ambient
 * transaction, so the production entry points write into it and nothing
 * persists. Scoped to one organization's batch rather than the cron sweep, so
 * no case depends on how many organizations the database already holds.
 */
import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { SEEDED_SYNCED_AT } from "@/__tests__/support/branches/branch-analytics-rollup.test-fixtures";
import {
  autoRollbackTransactionJoining,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  readMaterializedBranchEventAggregates,
  refreshBranchAnalyticsRollupBatch,
} from "@/app/branches/branch-analytics-rollup";
import { BranchAnalyticsRollupReadStatus } from "@/app/branches/branch-analytics-rollup-contract";
import {
  type LinkedSession,
  readSessionUsageLinks,
} from "@/app/branches/branch-read-service/session-usage-link-read";
import { resolveSessionEventEvidence } from "@/app/branches/branch-session-cost-evidence";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin what the shipping caller receives — dedupe, coverage, truncation — not the per-batch commit boundary or its timeout, which have no committed-fixture coverage anywhere yet"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * The producer's `as_of`, five minutes behind the wall clock the CONSUMER will
 * read against. Well inside `BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS` (15
 * minutes) with room for a slow run, and old enough that an event may be
 * received on either side of it without any timestamp landing in the future.
 */
const REFRESH_AT = new Date(Date.now() - 5 * 60 * 1000);
const RECEIVED_BEFORE_CUTOFF = new Date(REFRESH_AT.getTime() - 60 * 1000);
const RECEIVED_AFTER_CUTOFF = new Date(REFRESH_AT.getTime() + 60 * 1000);

const FIRST_EVENT = {
  suffix: "first",
  inputTokens: 120,
  outputTokens: 60,
  cacheReadTokens: 12,
  cacheWriteTokens: 6,
  estimatedCost: 1.5,
  eventCreatedAt: new Date(REFRESH_AT.getTime() - 3 * 60 * 1000),
};
const SECOND_EVENT = {
  suffix: "second",
  inputTokens: 80,
  outputTokens: 40,
  cacheReadTokens: 8,
  cacheWriteTokens: 4,
  estimatedCost: 0.75,
  eventCreatedAt: new Date(REFRESH_AT.getTime() - 2 * 60 * 1000),
};
/**
 * Received AFTER the producer's cutoff while its own `event_created_at` sits
 * before it — the shape a late-delivering collector produces. Only the rollup
 * excludes it; the evidence sample and the raw aggregate both carry no
 * receive-time predicate at all.
 */
const LATE_ARRIVAL_EVENT = {
  suffix: "late-arrival",
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0.5,
  eventCreatedAt: new Date(REFRESH_AT.getTime() - 60 * 1000),
  createdAt: RECEIVED_AFTER_CUTOFF,
};

const IN_SCOPE_COST = 2.25;
const LIFETIME_COST_WITH_LATE_ARRIVAL = 2.75;

describeIfDb(
  "branch analytics rollup through the shipping caller (ISS-9919)",
  () => {
    it("serves the rollup to resolveSessionEventEvidence with no injected clock", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "shipping-shape",
          events: [FIRST_EVENT, SECOND_EVENT],
        });

        await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: REFRESH_AT,
        });

        // The seam itself, in isolation and before the consumer is involved:
        // the reader called exactly as `readMaterializedEventAggregatesBest-
        // Effort` calls it — FOUR arguments, no `now`, so the reader's own
        // `new Date()` adjudicates staleness against a fixture anchored to the
        // wall clock. That defaulted parameter is the gap the ISS-9910 suite
        // left open: every call there injects the fifth argument, which no
        // production caller has. Unavailable here and every consumer assertion
        // below still passes, off the raw-aggregate fallback.
        const materialized = await withDb((db) =>
          readMaterializedBranchEventAggregates(
            db,
            seed.organizationId,
            [seed.sessionArtifactId],
            undefined
          )
        );
        expect(materialized.status).toBe(
          BranchAnalyticsRollupReadStatus.Available
        );

        const evidence = await resolveEvidenceThroughProductionReaders(seed);

        // The reconciled answer: one contribution per event, none of them
        // flagged. This half is the control for the case below — the same call
        // on a population the rollup can answer completely — so the
        // contributions do NOT on their own say which side produced the
        // aggregate; the assertion above is what pins that.
        expect(evidence.contributions).toHaveLength(2);
        expect(evidence.contributions).toEqual(
          expect.arrayContaining([
            { fallbackSubtotalUsd: FIRST_EVENT.estimatedCost },
            { fallbackSubtotalUsd: SECOND_EVENT.estimatedCost },
          ])
        );
        expect(
          evidence.contributions.some(
            (contribution) => contribution.coverageIncomplete
          )
        ).toBe(false);
      });
    });

    it("reports coverage incomplete rather than a short subtotal when an event arrived after the cutoff", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "late-arrival",
          events: [FIRST_EVENT, SECOND_EVENT, LATE_ARRIVAL_EVENT],
          lifetimeEstimatedCost: LIFETIME_COST_WITH_LATE_ARRIVAL,
        });

        await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: REFRESH_AT,
        });

        const evidence = await resolveEvidenceThroughProductionReaders(seed);

        // THIS is the assertion that can only pass on the materialized path. The
        // rollup's receive-time cutoff holds the aggregate to two events while
        // the evidence sample, which has no such cutoff, returns three; the
        // populations cannot reconcile, so the consumer reports the gap and falls
        // back to the session's lifetime subtotal instead of serving the rollup's
        // short one. On the raw-aggregate fallback the third event is inside the
        // aggregate too, the populations agree, and this is three unflagged
        // per-event contributions.
        expect(evidence.contributions).toEqual([
          {
            coverageIncomplete: true,
            fallbackSubtotalUsd: LIFETIME_COST_WITH_LATE_ARRIVAL,
          },
        ]);
      });
    });

    it("queues a session linked to two branches once and counts each event once", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "two-branches",
          events: [FIRST_EVENT, SECOND_EVENT],
        });
        const secondBranchArtifactId = await seedBranch(
          seed.organizationId,
          "two-branches-second"
        );
        await linkSessionToBranch(
          seed.organizationId,
          seed.sessionArtifactId,
          secondBranchArtifactId,
          SessionArtifactLinkKind.SessionBranch
        );

        // A page with room for exactly one entry beyond the session under test.
        // The refresh queue's `SELECT DISTINCT al.source_id` is what keeps this
        // session to ONE entry: the branch join makes it reachable through two
        // `artifact_links` rows, and without the dedup both fill the page, the
        // last one still needing backfill, so the batch reports itself
        // incomplete and the organization's state goes `pending` — every read of
        // it then takes the fallback. At the production page size of 2000 the
        // same duplication spends a slot per extra branch instead, which is the
        // form this starves an organization in.
        const summary = await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          sessionLimit: 2,
          now: REFRESH_AT,
        });

        expect(summary.complete).toBe(true);
        // Deduplicated again in TypeScript before the write, so this one cannot
        // fail on the SQL dedup alone — it pins the write set, not the queue.
        expect(summary.sessionsRefreshed).toBe(1);

        // One rollup row per branch, each carrying the session's own totals...
        const rollups = await readRollupRows(seed.organizationId);
        expect(new Set(rollups.map((row) => row.branchArtifactId))).toEqual(
          new Set([seed.branchArtifactId, secondBranchArtifactId])
        );
        // ...and the read collapses them, so a two-branch session is not counted
        // twice into its own total.
        const rows = await readAvailableAggregates(seed.organizationId, [
          seed.sessionArtifactId,
        ]);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]?.eventCount)).toBe(2);
        expect(Number(rows[0]?.sumInputTokens)).toBe(
          FIRST_EVENT.inputTokens + SECOND_EVENT.inputTokens
        );
        expect(Number(rows[0]?.sumEstimatedCost)).toBe(IN_SCOPE_COST);
      });
    });

    it("reports the batch incomplete when the page really did truncate a backlog", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "truncated-page",
          events: [FIRST_EVENT],
        });
        const secondSessionArtifactId = await linkValidSessionToBranch({
          organizationId: seed.organizationId,
          userId: seed.userId,
          branchArtifactId: seed.branchArtifactId,
          label: "truncated-page-second",
          linkKind: SessionArtifactLinkKind.SessionPr,
          lastSyncedAt: SEEDED_SYNCED_AT,
        });
        await seedTokenEvents(secondSessionArtifactId, [SECOND_EVENT]);

        // The sibling of the case above: two DISTINCT sessions and a page of one,
        // so `complete` is false for the reason it exists. Without this, a
        // `complete: true` assertion would be satisfied by a flag that is never
        // false.
        const summary = await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          sessionLimit: 1,
          now: REFRESH_AT,
        });

        expect(summary.complete).toBe(false);
        expect(summary.sessionsRefreshed).toBe(1);
      });
    });
  }
);

type SeededEvent = {
  suffix: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  eventCreatedAt: Date;
  /** Receive time. Defaults inside the producer's cutoff. */
  createdAt?: Date;
};

type SeededBranchSession = {
  organizationId: string;
  userId: string;
  branchArtifactId: string;
  sessionArtifactId: string;
};

/**
 * Seed one branch, one session linked to it, and its token events — with the
 * session's LIFETIME columns set to what ingest would have written for that
 * event set, because `resolveSessionEventEvidence` reconciles the event
 * population against them and a session carrying the schema-default zeros would
 * report every population as incomplete.
 */
async function seedLinkedBranchSession(input: {
  label: string;
  events: readonly SeededEvent[];
  /** Lifetime cost, when it must differ from the in-scope event subtotal. */
  lifetimeEstimatedCost?: number;
}): Promise<SeededBranchSession> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const branchArtifactId = await seedBranch(organizationId, input.label);
  const sessionArtifactId = await linkValidSessionToBranch({
    organizationId,
    userId: user.id,
    branchArtifactId,
    label: input.label,
    linkKind: SessionArtifactLinkKind.SessionPr,
    cost: {
      estimatedCost:
        input.lifetimeEstimatedCost ?? sumOf(input.events, "estimatedCost"),
    },
    lastSyncedAt: SEEDED_SYNCED_AT,
  });
  await seedTokenEvents(sessionArtifactId, input.events);
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId: sessionArtifactId },
      data: {
        inputTokens: BigInt(sumOf(input.events, "inputTokens")),
        outputTokens: BigInt(sumOf(input.events, "outputTokens")),
        cacheReadTokens: BigInt(sumOf(input.events, "cacheReadTokens")),
        cacheWriteTokens: BigInt(sumOf(input.events, "cacheWriteTokens")),
      },
      select: { artifactId: true },
    })
  );
  return {
    organizationId,
    userId: user.id,
    branchArtifactId,
    sessionArtifactId,
  };
}

function seedBranch(organizationId: string, label: string): Promise<string> {
  return withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `iss9919-${label}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: "closedloop-ai/closedloop-ai",
        branchName: `iss9919-${label}`,
        firstPushedAt: RECEIVED_BEFORE_CUTOFF,
        pushSource: BranchPushSource.Session,
        lastActivityAt: RECEIVED_BEFORE_CUTOFF,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}

async function linkSessionToBranch(
  organizationId: string,
  sessionArtifactId: string,
  branchArtifactId: string,
  linkKind: SessionArtifactLinkKind
): Promise<void> {
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: { linkKind },
      },
    })
  );
}

async function seedTokenEvents(
  sessionArtifactId: string,
  events: readonly SeededEvent[]
): Promise<void> {
  await withDb((db) =>
    db.agentSessionTokenEvent.createMany({
      data: events.map((event) => ({
        agentSessionId: sessionArtifactId,
        externalEventId: `iss9919-${sessionArtifactId}-${event.suffix}`,
        model: "claude-opus-5",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        estimatedCost: event.estimatedCost,
        eventCreatedAt: event.eventCreatedAt,
        createdAt: event.createdAt ?? RECEIVED_BEFORE_CUTOFF,
      })),
    })
  );
}

/**
 * The whole shipping read: the production link reader produces the
 * `LinkedSession[]` the consumer takes, and the consumer is called with the
 * argument shape `getSessionUsageWithCostCompleteness` calls it with
 * (`branch-read-service/session-usage-window.ts`) — an absent date window, and
 * the `includeCostEvidence` option the branch read passes whenever it asks for
 * cost completeness. Five arguments, none of them a clock: nothing in that
 * shape can reach the reader's `now`, so the reader's own `new Date()` is what
 * decides whether the rollup is fresh.
 */
async function resolveEvidenceThroughProductionReaders(
  seed: SeededBranchSession
) {
  const sessions = await withDb(async (db) => {
    const links = await readSessionUsageLinks(
      db,
      seed.organizationId,
      [seed.branchArtifactId],
      { includeReviewedIdentityEvidence: false }
    );
    return links.flatMap<LinkedSession>((link) =>
      link.source.session ? [link.source.session] : []
    );
  });
  if (sessions.length !== 1) {
    throw new Error(
      `expected the production link reader to return exactly one linked session, got ${sessions.length}`
    );
  }
  return await withDb((db) =>
    resolveSessionEventEvidence(db, seed.organizationId, sessions, undefined, {
      includeCostEvidence: true,
    })
  );
}

function readRollupRows(organizationId: string) {
  return withDb((db) =>
    db.branchAnalyticsSessionRollup.findMany({
      where: { organizationId },
      orderBy: [{ sessionArtifactId: "asc" }, { branchArtifactId: "asc" }],
    })
  );
}

async function readAvailableAggregates(
  organizationId: string,
  sessionIds: readonly string[]
) {
  const result = await withDb((db) =>
    readMaterializedBranchEventAggregates(
      db,
      organizationId,
      sessionIds,
      undefined
    )
  );
  if (result.status !== BranchAnalyticsRollupReadStatus.Available) {
    throw new Error(
      `expected an available rollup read, got unavailable: ${result.reason}`
    );
  }
  return result.rows;
}

function sumOf(
  events: readonly SeededEvent[],
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "estimatedCost"
): number {
  return events.reduce((total, event) => total + event[key], 0);
}
