/**
 * ISS-9910 — the Branch analytics rollup boundary against a REAL Postgres.
 *
 * Every other suite on this path hands the producer a mocked `$queryRaw` /
 * `$executeRaw` pair that pattern-matches rendered SQL and returns canned rows,
 * so it proves the statement SHAPE and nothing about its RESULT. A mock agrees
 * with itself by construction; these cases execute the whole chain —
 * seed session + artifact_link + agent_session_token_events
 *   -> refreshDueBranchAnalyticsRollups writes branch_analytics_session_rollups
 *   -> readMaterializedBranchEventAggregates takes the materialized path
 * — so the predicates only Postgres can adjudicate are pinned by rows: the
 * valid-event predicate shared by the producer and the refresh queue, the
 * receive-time cutoff at `as_of`, and the watermark comparison in the read's
 * completeness gate (ISS-10565 moved the event-count reconciliation into the
 * refresh queue; `branch-analytics-rollup-completeness.integration.test.ts`
 * pins that side).
 *
 * The clock is INJECTED, not faked. Both entry points take `now`, and the read
 * takes it too, so every cutoff, staleness floor, and sync boundary here is
 * an argument rather than an ambient wall clock — no `setSystemTime`, no frozen
 * clock to leak into a later worker case, and no sleep.
 *
 * Runs inside `autoRollbackTransaction`; `withDb`/`withDb.tx` join the ambient
 * transaction, so the production entry points write into it and nothing
 * persists. The seeding and read helpers live in
 * `__tests__/support/branches/branch-analytics-rollup.test-fixtures.ts`.
 *
 * ISS-9919 — entry point, and what it costs. Only the first case drives the
 * cron sweep; the rest drive `refreshBranchAnalyticsRollupBatch` for the
 * organization they seeded. The sweep's new-organization arm pages by
 * `organizations.created_at ASC`, and a seeded organization is always the
 * NEWEST row, so every case used to depend on how many state-less
 * organizations the database already held: green on a clean CI database,
 * five reds reading as a regression on a working one (measured against a
 * local database with 150). Scoping the four removes that dependency without
 * changing what any of them assert — none was ever about which organizations
 * the cron selects, which is what the case that kept the sweep covers.
 *
 * That remaining case does NOT buy its determinism with a bigger page. A limit
 * cannot: the seeded organization sorts LAST in the arm that can select it, so
 * every page size is a bet on the ambient row count and only moves the number
 * of organizations needed to lose it (measured: the production ceiling of 500
 * lost the fixture against 600 ambient organizations). It parks every other
 * organization on a fresh state row instead, so the candidate population is
 * exactly the one it seeded, and it asserts that population before reading a
 * single rollup row out of it. The ISS-9831 date-window cases below stay on the
 * cron entry point too, so each one parks the population the same way — the
 * default limit of 100 is the one they would otherwise be betting against.
 *
 * The consumer-facing half of this boundary — the call shape that actually
 * ships, and the dedup that keeps a multi-branch session out of the queue
 * twice — is `branch-analytics-rollup-consumer.integration.test.ts`.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  BATCH_AT,
  buildEvent,
  RECEIVED_AFTER_CUTOFF,
  RECEIVED_BEFORE_CUTOFF,
  readAggregates,
  readAvailableAggregates,
  readRollupRows,
  SECOND_BATCH_AT,
  SEEDED_SYNCED_AT,
  type SeededEvent,
  seedBranch,
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
  refreshDueBranchAnalyticsRollups,
} from "@/app/branches/branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES,
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupAggregateRow,
  type BranchAnalyticsRollupDateWindow,
  type BranchAnalyticsRollupReadResult,
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupState,
  BranchAnalyticsRollupUnavailableReason,
} from "@/app/branches/branch-analytics-rollup-contract";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the rollup's SQL — queueing, date windowing, malformed handling, missing-row evidence — not the per-batch commit boundary; BRANCH_ANALYTICS_ROLLUP_TX_TIMEOUT_MS is a production bound no ambient-wrapped case can hold, and that boundary has no committed-fixture coverage anywhere yet"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * Deliberately BEFORE `BATCH_AT` while its event is received after it. The two
 * timestamps straddle the cutoff on opposite axes, so only the receive-time
 * predicate can exclude the event on the first pass — swapping
 * `event.created_at <= asOf` for `event.event_created_at <= asOf` admits it and
 * reddens the case. Still later than the first event's, so the source watermark
 * moves and the next pass re-queues the session.
 */
const LATE_ARRIVAL_EVENT_CREATED_AT = new Date("2026-08-01T11:50:00.000Z");

describeIfDb("branch analytics rollup real boundary (ISS-9910)", () => {
  it("materializes seeded token events and serves them from the rollup", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "happy",
        events: [
          buildEvent({
            suffix: "a",
            inputTokens: 120,
            outputTokens: 60,
            cacheReadTokens: 12,
            cacheWriteTokens: 6,
            estimatedCost: 1.5,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
          buildEvent({
            suffix: "b",
            inputTokens: 80,
            outputTokens: 40,
            cacheReadTokens: 8,
            cacheWriteTokens: 4,
            estimatedCost: 0.75,
            eventCreatedAt: new Date("2026-08-01T11:45:00.000Z"),
          }),
        ],
      });

      // The one case that stays on the CRON entry point, so the due SELECT is
      // executed against real rows somewhere. Its candidate population is made
      // deterministic FIRST, because no page size can do it: the due query's
      // new-organization arm pages by `organizations.created_at ASC` and a
      // seeded organization is always the NEWEST row, so any limit is only a
      // bet on how many state-less organizations the database already holds.
      // Measured at the production ceiling of 500: with 600 ambient ones this
      // case's `readRollupRows` came back EMPTY.
      await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);

      const summary = await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });

      // The population the sweep actually measured, asserted before anything is
      // read out of it: exactly the seeded organization, on the production
      // default limit, with no page truncated. Without this the rows below are
      // the only evidence the cron reached the fixture at all, and a run whose
      // due query never selected it is indistinguishable from a rollup that
      // failed to write. `failedOrganizations` is load-bearing again for the
      // same reason — the sweep can only visit this organization now, where
      // before it counted every unrelated tenant's refresh failure too.
      expect(summary.organizations).toBe(1);
      expect(summary.organizationLimitReached).toBe(false);
      expect(summary.failedOrganizations).toBe(0);

      const rollups = await readRollupRows(seed.organizationId);
      expect(rollups).toHaveLength(1);
      expect(rollups[0]).toMatchObject({
        sessionArtifactId: seed.sessionArtifactId,
        branchArtifactId: seed.branchArtifactId,
        source: BRANCH_ANALYTICS_ROLLUP_SOURCE,
        eventCount: 2,
      });

      const rows = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        BATCH_AT
      );
      expect(totalsFor(rows, seed.sessionArtifactId)).toEqual({
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        estimatedCost: 2.25,
        eventCount: 2,
      });
    });
  });

  it("materializes only Wrote and genuinely unclassified legacy Branch links", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "wrote-only",
        events: [
          buildEvent({
            suffix: "wrote-only",
            inputTokens: 120,
            outputTokens: 60,
            cacheReadTokens: 12,
            cacheWriteTokens: 6,
            estimatedCost: 1.5,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      const [
        explicitReviewedBranchId,
        metadataReviewedBranchId,
        legacyBranchId,
      ] = await Promise.all([
        seedBranch(seed.organizationId, "explicit-reviewed"),
        seedBranch(seed.organizationId, "metadata-reviewed"),
        seedBranch(seed.organizationId, "legacy-unclassified"),
      ]);
      await withDb((db) =>
        db.artifactLink.createMany({
          data: [
            {
              branchParticipation: BranchParticipationKind.Reviewed,
              linkType: LinkType.RelatesTo,
              metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
              organizationId: seed.organizationId,
              sourceId: seed.sessionArtifactId,
              targetId: explicitReviewedBranchId,
            },
            {
              branchParticipation: null,
              linkType: LinkType.RelatesTo,
              metadata: {
                branchParticipation: BranchParticipationKind.Reviewed,
                linkKind: SessionArtifactLinkKind.SessionPr,
              },
              organizationId: seed.organizationId,
              sourceId: seed.sessionArtifactId,
              targetId: metadataReviewedBranchId,
            },
            {
              branchParticipation: null,
              linkType: LinkType.RelatesTo,
              metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
              organizationId: seed.organizationId,
              sourceId: seed.sessionArtifactId,
              targetId: legacyBranchId,
            },
          ],
        })
      );

      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      const rollups = await readRollupRows(seed.organizationId);
      expect(rollups.map((row) => row.branchArtifactId).sort()).toEqual(
        [seed.branchArtifactId, legacyBranchId].sort()
      );
      expect(rollups).toHaveLength(2);
      expect(rollups.every((row) => Number(row.eventCount) === 1)).toBe(true);
    });
  });

  it("does not queue sessions whose only Branch links are Reviewed", async () => {
    await joinAmbientTransaction(async () => {
      const explicit = await seedLinkedBranchSession({
        label: "reviewed-only-explicit",
        events: [
          buildEvent({
            suffix: "reviewed-only-explicit",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      const metadataSessionId = await linkValidSessionToBranch({
        branchArtifactId: explicit.branchArtifactId,
        label: "reviewed-only-metadata",
        linkKind: SessionArtifactLinkKind.SessionPr,
        organizationId: explicit.organizationId,
        userId: explicit.userId,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      await seedTokenEvents(metadataSessionId, [
        buildEvent({
          suffix: "reviewed-only-metadata",
          inputTokens: 80,
          outputTokens: 40,
          estimatedCost: 0.75,
          eventCreatedAt: new Date("2026-08-01T11:45:00.000Z"),
        }),
      ]);
      await withDb(async (db) => {
        await db.artifactLink.updateMany({
          data: { branchParticipation: BranchParticipationKind.Reviewed },
          where: { sourceId: explicit.sessionArtifactId },
        });
        await db.artifactLink.updateMany({
          data: {
            branchParticipation: null,
            metadata: {
              branchParticipation: BranchParticipationKind.Reviewed,
              linkKind: SessionArtifactLinkKind.SessionPr,
            },
          },
          where: { sourceId: metadataSessionId },
        });
      });

      const summary = await refreshBranchAnalyticsRollupBatch({
        organizationId: explicit.organizationId,
        now: BATCH_AT,
      });

      expect(summary.sessionsRefreshed).toBe(0);
      expect(await readRollupRows(explicit.organizationId)).toEqual([]);
    });
  });

  it("excludes an event received after the batch cutoff, then materializes it on the next pass", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "cutoff",
        events: [
          buildEvent({
            suffix: "in-scope",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
          // Receive time is what the cutoff reads, and this event proves that:
          // its `event_created_at` sits INSIDE the batch window while its
          // receive time sits outside, so the first pass may only exclude it on
          // the receive-time axis.
          buildEvent({
            suffix: "late-arrival",
            inputTokens: 7,
            outputTokens: 3,
            estimatedCost: 0.5,
            eventCreatedAt: LATE_ARRIVAL_EVENT_CREATED_AT,
            createdAt: RECEIVED_AFTER_CUTOFF,
          }),
        ],
      });

      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      const beforeCutoff = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        BATCH_AT
      );
      expect(totalsFor(beforeCutoff, seed.sessionArtifactId)).toMatchObject({
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: 1,
        eventCount: 1,
      });

      const secondPass = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
      });
      // The re-queue itself, not just its effect: a session whose rollup already
      // covered every event would not appear in the refresh batch at all.
      expect(secondPass.sessionsRefreshed).toBe(1);

      const afterCutoff = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        SECOND_BATCH_AT
      );
      expect(totalsFor(afterCutoff, seed.sessionArtifactId)).toMatchObject({
        inputTokens: 107,
        outputTokens: 53,
        estimatedCost: 1.5,
        eventCount: 2,
      });
    });
  });

  it("re-materializes an in-place cost correction on the pass after its session syncs (ISS-12779)", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "reprice",
        events: [
          buildEvent({
            suffix: "priced",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1.5,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });

      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      const materialized = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        BATCH_AT
      );
      expect(
        totalsFor(materialized, seed.sessionArtifactId).estimatedCost
      ).toBe(1.5);

      // What a sync slice does: `updateCostEvidence` moves the price, while
      // `event_created_at` and the token counts stay put, so neither the source
      // watermark nor the event-count reconciliation can see the edit. The
      // slice's detail write stamps `last_synced_at`, and that is what queues it.
      const syncedAt = new Date(BATCH_AT.getTime() + 60_000);
      await withDb(async (db) => {
        await db.agentSessionTokenEvent.updateMany({
          where: { agentSessionId: seed.sessionArtifactId },
          data: { estimatedCost: 4.25 },
        });
        await db.sessionDetail.update({
          where: { artifactId: seed.sessionArtifactId },
          data: { lastSyncedAt: syncedAt },
          select: { artifactId: true },
        });
      });

      const nextPass = new Date(syncedAt.getTime() + 60_000);
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: nextPass,
      });
      const corrected = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        nextPass
      );
      expect(totalsFor(corrected, seed.sessionArtifactId).estimatedCost).toBe(
        4.25
      );
    });
  });

  it("never materializes a session holding a malformed event, and keeps serving its sibling", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "malformed",
        events: [
          buildEvent({
            suffix: "valid",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
          // A negative count is not reachable through the type boundary, but
          // the column is, so the writer's exclusion is what actually keeps a
          // total that silently dropped it off the page.
          buildEvent({
            suffix: "negative-tokens",
            inputTokens: -5,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:35:00.000Z"),
          }),
        ],
      });
      const siblingSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "malformed-sibling",
        linkKind: SessionArtifactLinkKind.SessionPr,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      await seedTokenEvents(siblingSessionId, [
        buildEvent({
          suffix: "sibling",
          inputTokens: 900,
          outputTokens: 400,
          estimatedCost: 9,
          eventCreatedAt: new Date("2026-08-01T11:31:00.000Z"),
        }),
      ]);

      const pass = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      // ISS-10565: the bad session gets NO rows rather than rows that exclude
      // the event, and it never occupies a slot in the refresh queue.
      expect(pass.sessionsRefreshed).toBe(1);
      const rollups = await readRollupRows(seed.organizationId);
      expect(rollups.map((row) => row.sessionArtifactId)).toEqual([
        siblingSessionId,
      ]);

      // The read reports it missing, so only a request that includes it falls
      // back — to the source read whose MIN columns surface the bad row.
      const refused = await readAggregates(
        seed.organizationId,
        [seed.sessionArtifactId, siblingSessionId],
        BATCH_AT
      );
      expect(refused).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      });
      // The organization is not refused: a sibling without the bad row is
      // still served from the rollup.
      const served = await readAvailableAggregates(
        seed.organizationId,
        [siblingSessionId],
        BATCH_AT
      );
      expect(totalsFor(served, siblingSessionId)).toMatchObject({
        eventCount: 1,
        inputTokens: 900,
      });
    });
  });

  it("reports session_rows_missing rather than a short total when a rollup row is gone", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "incomplete",
        events: [
          buildEvent({
            suffix: "kept",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      const droppedSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "incomplete-dropped",
        linkKind: SessionArtifactLinkKind.SessionPr,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      await seedTokenEvents(droppedSessionId, [
        buildEvent({
          suffix: "dropped",
          inputTokens: 900,
          outputTokens: 400,
          estimatedCost: 9,
          eventCreatedAt: new Date("2026-08-01T11:31:00.000Z"),
        }),
      ]);

      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      const sessionIds = [seed.sessionArtifactId, droppedSessionId];
      const complete = await readAvailableAggregates(
        seed.organizationId,
        sessionIds,
        BATCH_AT
      );
      expect(complete).toHaveLength(2);

      await withDb((db) =>
        db.branchAnalyticsSessionRollup.deleteMany({
          where: {
            organizationId: seed.organizationId,
            sessionArtifactId: droppedSessionId,
          },
        })
      );

      const afterDelete = await readAggregates(
        seed.organizationId,
        sessionIds,
        BATCH_AT
      );
      expect(afterDelete).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      });
    });
  });

  /**
   * ISS-9831 — the date-window read, against real rows.
   *
   * These are the cases a mock cannot adjudicate. Every other read suite on this
   * path hands `$queryRaw` a canned aggregate row regardless of the window
   * predicate, so it can prove the statement CARRIES a `bucket_start` bound and
   * nothing about the number that bound produces. Here the events are real, the
   * buckets are written by the real producer, and each case asserts the totals
   * the window should yield.
   */
  describe("date-window reads", () => {
    it("serves a day-aligned window from whole buckets and counts only that day", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "aligned-window",
          events: threeDayEvents(),
        });

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });

        // One row per UTC day, not one per session lifetime: the whole fix.
        const rollups = await readRollupRows(seed.organizationId);
        expect(rollups.map((row) => row.bucketStart)).toEqual([
          new Date("2026-07-29T00:00:00.000Z"),
          new Date("2026-07-30T00:00:00.000Z"),
          new Date("2026-07-31T00:00:00.000Z"),
        ]);

        const rows = await readWindowedAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          {
            startDate: new Date("2026-07-30T00:00:00.000Z"),
            endDate: new Date("2026-07-30T23:59:59.999Z"),
          }
        );

        expect(totalsFor(rows, seed.sessionArtifactId)).toEqual({
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          estimatedCost: 0.5,
          eventCount: 2,
        });
      });
    });

    it("completes a non-aligned window with a bounded read of both partial days", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "edge-window",
          events: threeDayEvents(),
        });

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });

        const rows = await readWindowedAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          {
            // 07-29 is half covered (its 08:00 event is out, its 18:00 event in),
            // 07-30 is whole, and 07-31 stops before its 18:00 event.
            startDate: new Date("2026-07-29T12:00:00.000Z"),
            endDate: new Date("2026-07-31T12:00:00.000Z"),
          }
        );

        expect(totalsFor(rows, seed.sessionArtifactId)).toEqual({
          // 07-29 18:00 (2/1) + both 07-30 (20/10) + 07-31 08:00 (300/150).
          inputTokens: 322,
          outputTokens: 161,
          cacheReadTokens: 36,
          cacheWriteTokens: 18,
          estimatedCost: 3.55,
          eventCount: 4,
        });
      });
    });

    it("keeps a whole final bucket only while the source column cannot hold a finer instant", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "sub-millisecond",
          events: [
            buildEvent({
              suffix: "last-millisecond",
              inputTokens: 5,
              outputTokens: 1,
              estimatedCost: 0.05,
              eventCreatedAt: new Date("2026-07-30T23:59:59.999Z"),
            }),
          ],
        });
        // The read treats `…T23:59:59.999Z` as covering its whole day, which is
        // exact only while `event_created_at` is `TIMESTAMP(3)` and rounds this
        // instant into the NEXT day. A wider column would keep it inside
        // 07-30's bucket while the caller's `<= endDate` excludes it, and the
        // window total would silently over-count by 777 input tokens.
        await insertSubMillisecondTokenEvent(seed.sessionArtifactId);

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });

        const rows = await readWindowedAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          {
            startDate: new Date("2026-07-30T00:00:00.000Z"),
            endDate: new Date("2026-07-30T23:59:59.999Z"),
          }
        );

        expect(totalsFor(rows, seed.sessionArtifactId).inputTokens).toBe(5);
      });
    });

    it("returns no row for a session whose buckets all sit outside the window", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "empty-window",
          events: threeDayEvents(),
        });

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });

        const rows = await readWindowedAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          {
            startDate: new Date("2026-07-20T00:00:00.000Z"),
            endDate: new Date("2026-07-22T23:59:59.999Z"),
          }
        );

        // Available and empty, not unavailable: the rollup answered, and the
        // truthful answer for that window is that the session spent nothing.
        expect(rows).toEqual([]);
      });
    });

    it("refuses rather than answer a window from a lifetime-grain row left by the old writer", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "legacy-grain",
          events: threeDayEvents(),
        });

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });
        // Exactly the rollout state: the organization reads `fresh` while its
        // rows are the ones the PREVIOUS writer left behind.
        expect(await demoteRollupRowsToLegacyGrain(seed.organizationId)).toBe(
          3
        );

        const result = await readWindowedAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          {
            startDate: new Date("2026-07-30T00:00:00.000Z"),
            endDate: new Date("2026-07-30T23:59:59.999Z"),
          }
        );

        expect(result).toMatchObject({
          status: BranchAnalyticsRollupReadStatus.Unavailable,
          reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
        });
      });
    });

    it("reclaims a session's lifetime-grain rows as it re-materializes it", async () => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "legacy-reclaim",
          events: threeDayEvents(),
        });

        await parkEveryOtherOrganizationFresh(seed.organizationId, BATCH_AT);
        await refreshDueBranchAnalyticsRollups({ now: BATCH_AT });
        await demoteRollupRowsToLegacyGrain(seed.organizationId);
        await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: SECOND_BATCH_AT,
        });

        // No orphans: the re-backfill is also the cleanup, so the table is not
        // left carrying both grains of every session indefinitely.
        const rollups = await readRollupRows(seed.organizationId);
        expect(rollups).toHaveLength(3);
        expect(
          rollups.every((row) => row.source === BRANCH_ANALYTICS_ROLLUP_SOURCE)
        ).toBe(true);
      });
    });
  });
});

/**
 * Make the cron's candidate population exactly `organizationId`.
 *
 * Both arms of the due query are closed against every OTHER organization by
 * the same row: `new_state_organizations` selects only organizations with no
 * `branch_analytics_rollup_states` row, and `due_state_organizations` selects
 * only rows that are not fresh, not backfilled, undated, stale, or lagging —
 * so a fresh, backfilled, `as_of = now`, zero-lag row disqualifies an
 * organization from both. The seeded organization is left with no state row at
 * all, which is what keeps it a candidate.
 *
 * Runs inside the case's `autoRollbackTransaction`, so nothing here outlives
 * the test.
 */
async function parkEveryOtherOrganizationFresh(
  organizationId: string,
  asOf: Date
): Promise<void> {
  await withDb(async (db) => {
    const others = await db.organization.findMany({
      where: { id: { not: organizationId } },
      select: { id: true },
    });
    await db.branchAnalyticsRollupState.deleteMany({
      where: { organizationId: { not: organizationId } },
    });
    await db.branchAnalyticsRollupState.createMany({
      data: others.map((other) => ({
        organizationId: other.id,
        state: BranchAnalyticsRollupState.Fresh,
        asOf,
        lagSeconds: 0,
        backfillCompletedAt: asOf,
      })),
    });
  });
}

function readWindowedAggregates(
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: BranchAnalyticsRollupDateWindow
): Promise<BranchAnalyticsRollupReadResult> {
  return withDb((db) =>
    readMaterializedBranchEventAggregates(
      db,
      organizationId,
      sessionIds,
      dateWindow,
      BATCH_AT
    )
  );
}

async function readWindowedAvailableAggregates(
  organizationId: string,
  sessionIds: readonly string[],
  dateWindow: BranchAnalyticsRollupDateWindow
): Promise<BranchAnalyticsRollupAggregateRow[]> {
  const result = await readWindowedAggregates(
    organizationId,
    sessionIds,
    dateWindow
  );
  if (result.status !== BranchAnalyticsRollupReadStatus.Available) {
    throw new Error(
      `expected an available windowed rollup read, got unavailable: ${result.reason}`
    );
  }
  return result.rows;
}

/**
 * Rewrite an organization's rollup rows as the previous writer would have left
 * them: one lifetime total per session, filed under the retired grain.
 * `Prisma.createMany` cannot express the sub-day arithmetic, and the point is to
 * produce rows no current writer can produce.
 */
function demoteRollupRowsToLegacyGrain(
  organizationId: string
): Promise<number> {
  return withDb((db) =>
    db.$executeRaw(Prisma.sql`
      UPDATE branch_analytics_session_rollups
      SET source = ${BRANCH_ANALYTICS_ROLLUP_LEGACY_SOURCES[0]},
          bucket_start = source_min_event_created_at
      WHERE organization_id = ${organizationId}::uuid
    `)
  );
}

/**
 * An event at a sub-millisecond offset, which a JS `Date` cannot express and
 * `TIMESTAMP(3)` rounds into the following day.
 */
function insertSubMillisecondTokenEvent(
  sessionArtifactId: string
): Promise<number> {
  return withDb((db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO agent_session_token_events (
        id, agent_session_id, external_event_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        estimated_cost, event_created_at, created_at
      )
      VALUES (
        gen_random_uuid(), ${sessionArtifactId}::uuid,
        'iss9831-sub-millisecond-overflow', 'claude-opus-5',
        777, 1, 0, 0, 0.01,
        '2026-07-30T23:59:59.9995'::timestamp, ${RECEIVED_BEFORE_CUTOFF}
      )
    `)
  );
}

/**
 * Three UTC days of events, two per day, so a window can cut a day in half at
 * either edge and the expected total differs from both that day's total and the
 * session's lifetime total. Rebuilt per case so no suite shares event rows.
 */
function threeDayEvents(): SeededEvent[] {
  return [
    buildEvent({
      suffix: "day1-early",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      estimatedCost: 0.01,
      eventCreatedAt: new Date("2026-07-29T08:00:00.000Z"),
    }),
    buildEvent({
      suffix: "day1-late",
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estimatedCost: 0.05,
      eventCreatedAt: new Date("2026-07-29T18:00:00.000Z"),
    }),
    buildEvent({
      suffix: "day2-early",
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estimatedCost: 0.2,
      eventCreatedAt: new Date("2026-07-30T08:00:00.000Z"),
    }),
    buildEvent({
      suffix: "day2-late",
      inputTokens: 12,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      estimatedCost: 0.3,
      eventCreatedAt: new Date("2026-07-30T18:00:00.000Z"),
    }),
    buildEvent({
      suffix: "day3-early",
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 30,
      cacheWriteTokens: 15,
      estimatedCost: 3,
      eventCreatedAt: new Date("2026-07-31T08:00:00.000Z"),
    }),
    buildEvent({
      suffix: "day3-late",
      inputTokens: 500,
      outputTokens: 250,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      estimatedCost: 5,
      eventCreatedAt: new Date("2026-07-31T18:00:00.000Z"),
    }),
  ];
}
