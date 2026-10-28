/**
 * ISS-10565 — what the rollup read pays to decide it may serve, and who finds
 * the drift it no longer looks for, against a REAL Postgres.
 *
 * The read's completeness gate used to recount every source event of every
 * requested session. It was correct, it was pinned by suites that asserted its
 * SQL text, and in production it cost 11,269 ms to guard a 32 ms rollup read —
 * no mock could see that, and neither could a fixture of two events. These
 * cases pin the two properties that replaced it: the gate's work is bounded by
 * the SESSION count, and the refresh queue finds what a watermark cannot.
 */
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
  seedLinkedBranchSession,
  seedTokenEvents,
  totalsFor,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-fixtures";
import {
  COMPLETENESS_GATE_MARKER,
  REFRESH_QUEUE_MARKER,
  SOURCE_WATERMARK_MARKER,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-markers";
import {
  autoRollbackTransactionJoining,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  readMaterializedBranchEventAggregates,
  refreshBranchAnalyticsRollupBatch,
  refreshBranchAnalyticsRollupBatchTx,
  refreshBranchAnalyticsSessionRollupsTx,
} from "@/app/branches/branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS,
  BranchAnalyticsRollupFailureCategory,
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupUnavailableReason,
} from "@/app/branches/branch-analytics-rollup-contract";
import { recordBranchAnalyticsRollupFailure } from "@/app/branches/branch-analytics-rollup-write";

/**
 * ISS-11104 — this suite lets its ambient transaction absorb the nested
 * `withDb.tx` its production path opens, discarding that call's own budget.
 * The reason below is the whole statement: it is what a reviewer reads to tell
 * a suite that does not need the real boundary from one that is blind to it.
 */
const joinAmbientTransaction = autoRollbackTransactionJoining(
  "these cases pin the completeness gate over malformed and late events, not the per-batch commit boundary or its timeout, which have no committed-fixture coverage anywhere yet"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const SOURCE_EVENTS_RELATION = "agent_session_token_events";

describeIfDb("branch analytics rollup completeness (ISS-10565)", () => {
  it("gates a read with one source probe per session, however many events each session holds", async () => {
    await joinAmbientTransaction(async () => {
      const eventsPerSession = 40;
      const seed = await seedLinkedBranchSession({
        label: "gate-cost",
        events: manyEvents("first", eventsPerSession),
      });
      const secondSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "gate-cost-second",
        linkKind: SessionArtifactLinkKind.SessionPr,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      await seedTokenEvents(
        secondSessionId,
        manyEvents("second", eventsPerSession)
      );
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      const sessionIds = [seed.sessionArtifactId, secondSessionId];

      const sourceRowsTouched = await withDb(async (db) => {
        // At fixture scale every plan costs the same, so the planner's pick
        // varies run to run and would measure the fixture, not the statement.
        // With its alternatives priced out, the plan shows what the statement
        // REQUIRES: answered from the ordered index a watermark probe visits
        // one event per session, while a recount — or a probe whose index is
        // gone — still has to visit every one.
        await db.$executeRaw`SET LOCAL enable_seqscan = off`;
        await db.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        await db.$executeRaw`SET LOCAL enable_sort = off`;
        let touched: number | undefined;
        const result = await readMaterializedBranchEventAggregates(
          {
            $queryRaw: async (statement: Prisma.Sql) => {
              if (statement.text.includes(COMPLETENESS_GATE_MARKER)) {
                touched = sourceRowsTouchedBy(
                  await db.$queryRaw(
                    Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`
                  )
                );
              }
              return db.$queryRaw(statement);
            },
          } as Parameters<typeof readMaterializedBranchEventAggregates>[0],
          seed.organizationId,
          sessionIds,
          undefined,
          BATCH_AT
        );
        expect(result.status).toBe(BranchAnalyticsRollupReadStatus.Available);
        return touched;
      });

      // The gate this replaced would read 80 here. It read 824,685 for one
      // production request.
      expect(sourceRowsTouched).toBe(sessionIds.length);
    });
  });

  it("re-materializes a session whose late event landed below its watermark, on the very next pass", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "out-of-order",
        events: [
          buildEvent({
            suffix: "newest-first",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      // Occurred BEFORE the materialized watermark and was received after the
      // first pass, so no watermark moves and the session has not re-synced:
      // only the refresh queue's count term can see it. 81% of production
      // events arrive more than six hours after they occurred, so an event
      // landing below a watermark is ordinary traffic, not a corner.
      await seedTokenEvents(seed.sessionArtifactId, [
        buildEvent({
          suffix: "older-arrives-later",
          inputTokens: 900,
          outputTokens: 400,
          estimatedCost: 9,
          eventCreatedAt: new Date("2026-08-01T11:00:00.000Z"),
          createdAt: RECEIVED_AFTER_CUTOFF,
        }),
      ]);

      const secondPass = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
        sessionLimit: 1,
      });
      expect(secondPass.sessionsRefreshed).toBe(1);
      // Count drift fills this batch, but is maintenance, not org backfill.
      expect(secondPass.complete).toBe(true);

      const served = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        SECOND_BATCH_AT
      );
      expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
        eventCount: 2,
        inputTokens: 1000,
        estimatedCost: 10,
      });
    });
  });

  it("drops a materialized session's rows once a malformed event arrives, and keeps serving its sibling", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "turns-malformed",
        events: [
          buildEvent({
            suffix: "valid",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      const siblingSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "turns-malformed-sibling",
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
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      expect(
        await readAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId, siblingSessionId],
          BATCH_AT
        )
      ).toHaveLength(2);

      // Below the watermark and outside the in-scope count on both sides, so
      // neither queue term sees it: only the refresh pass's malformed listing
      // can take the session's rows back.
      await seedTokenEvents(seed.sessionArtifactId, [
        buildEvent({
          suffix: "negative-tokens-later",
          inputTokens: -5,
          outputTokens: 50,
          estimatedCost: 1,
          eventCreatedAt: new Date("2026-08-01T11:00:00.000Z"),
          createdAt: RECEIVED_AFTER_CUTOFF,
        }),
      ]);
      const secondPass = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
      });
      expect(secondPass.sessionsRefreshed).toBe(0);

      const refused = await readAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        SECOND_BATCH_AT
      );
      expect(refused).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      });
      const served = await readAvailableAggregates(
        seed.organizationId,
        [siblingSessionId],
        SECOND_BATCH_AT
      );
      expect(totalsFor(served, siblingSessionId)).toMatchObject({
        eventCount: 1,
        inputTokens: 900,
      });
    });
  });

  it("writes no rollup row for a malformed session even when a caller asks for it by id", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "writer-invariant",
        events: [
          buildEvent({
            suffix: "valid",
            inputTokens: 100,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
          buildEvent({
            suffix: "negative-tokens",
            inputTokens: -5,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:35:00.000Z"),
          }),
        ],
      });

      // The refresh pass keeps such a session out of its queue, so the writer
      // is normally never asked. The set-based operation is shared with future
      // ingest hooks that name sessions directly, and the invariant has to
      // hold there too: a row that merely excluded the event would serve a
      // total that silently dropped it.
      const written = await withDb.tx((tx) =>
        refreshBranchAnalyticsSessionRollupsTx(tx, {
          organizationId: seed.organizationId,
          sessionArtifactIds: [seed.sessionArtifactId],
          asOf: BATCH_AT,
        })
      );
      expect(written.upsertedRows).toBe(0);
      expect(await readRollupRows(seed.organizationId)).toHaveLength(0);
    });
  });

  it("refuses a session whose every event is malformed instead of serving it as zero usage", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "all-malformed",
        events: [
          buildEvent({
            suffix: "negative-tokens",
            inputTokens: -5,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
          }),
        ],
      });
      const siblingSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "all-malformed-sibling",
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
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      // No in-scope event at all: a gate keyed on the newest IN-SCOPE event
      // would find nothing, drop the session from its result, and let the
      // read come back Available with the session simply absent — zero usage,
      // no malformed signal. Keyed on the newest RECEIVED event it is missing.
      const refused = await readAggregates(
        seed.organizationId,
        [seed.sessionArtifactId, siblingSessionId],
        BATCH_AT
      );
      expect(refused).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
      });
      expect(
        await readAvailableAggregates(
          seed.organizationId,
          [siblingSessionId],
          BATCH_AT
        )
      ).toHaveLength(1);
    });
  });

  it.each([false, true])(
    "does not let a malformed session hold the organization stale (mixed=%s)",
    async (mixed) => {
      await joinAmbientTransaction(async () => {
        const seed = await seedLinkedBranchSession({
          label: "lag-anchor",
          events: [
            buildEvent({
              suffix: "valid",
              inputTokens: 100,
              outputTokens: 50,
              estimatedCost: 1,
              eventCreatedAt: new Date("2026-08-01T11:30:00.000Z"),
            }),
          ],
        });
        const malformedSessionId = await linkValidSessionToBranch({
          organizationId: seed.organizationId,
          userId: seed.userId,
          branchArtifactId: seed.branchArtifactId,
          label: "lag-anchor-malformed",
          linkKind: SessionArtifactLinkKind.SessionPr,
          lastSyncedAt: SEEDED_SYNCED_AT,
        });
        // Ninety minutes past the newest valid event: a watermark taken over
        // every event would sit that far ahead of anything the rollup can hold,
        // six times the lag ceiling.
        await seedTokenEvents(malformedSessionId, [
          buildEvent({
            suffix: "negative-tokens-newest",
            inputTokens: -5,
            outputTokens: 50,
            estimatedCost: 1,
            eventCreatedAt: new Date("2026-08-01T13:00:00.000Z"),
          }),
        ]);
        if (mixed) {
          await seedTokenEvents(malformedSessionId, [
            buildEvent({
              suffix: "valid-newest-in-malformed-session",
              inputTokens: 10,
              outputTokens: 5,
              estimatedCost: 1,
              eventCreatedAt: new Date("2026-08-01T13:01:00.000Z"),
            }),
          ]);
        }

        const pass = await refreshBranchAnalyticsRollupBatch({
          organizationId: seed.organizationId,
          now: BATCH_AT,
        });
        expect(pass.lagSeconds).toBe(0);

        const served = await readAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          BATCH_AT
        );
        expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
          eventCount: 1,
          inputTokens: 100,
        });
      });
    }
  );

  it("materializes valid events until a malformed event reaches the same receive cutoff", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "malformed-receive-cutoff",
        events: [
          ...manyEvents("valid-at-cutoff", 1),
          buildEvent({
            suffix: "malformed-after-cutoff",
            inputTokens: -1,
            outputTokens: 0,
            estimatedCost: 0,
            eventCreatedAt: new Date("2026-08-01T09:00:00.000Z"),
            createdAt: RECEIVED_AFTER_CUTOFF,
          }),
        ],
      });
      const first = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      expect(first.upsertedRows).toBe(1);
      expect(
        await readAvailableAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          BATCH_AT
        )
      ).toHaveLength(1);
      const second = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
      });
      expect(second.deletedRows).toBe(1);
      expect(await readRollupRows(seed.organizationId)).toHaveLength(0);
    });
  });

  it("returns scalar refresh evidence for a replay with thousands of malformed events", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "malformed-replay",
        events: manyEvents("before-replay", 1),
      });
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      await seedTokenEvents(
        seed.sessionArtifactId,
        manyEvents("malformed-replay", 2048).map((event) => ({
          ...event,
          inputTokens: -1,
          createdAt: RECEIVED_AFTER_CUTOFF,
        }))
      );
      let watermarkRows: unknown;
      const pass = await withDb.tx((tx) =>
        refreshBranchAnalyticsRollupBatchTx(
          {
            $executeRaw: tx.$executeRaw.bind(tx),
            $queryRaw: async (statement: Prisma.Sql) => {
              const rows = await tx.$queryRaw(statement);
              if (
                statement.text.includes('AS "sourceWatermarkEventCreatedAt"')
              ) {
                watermarkRows = rows;
              }
              return rows;
            },
          } as Parameters<typeof refreshBranchAnalyticsRollupBatchTx>[0],
          { organizationId: seed.organizationId, now: SECOND_BATCH_AT }
        )
      );
      expect(watermarkRows).toEqual([
        {
          sourceWatermarkEventCreatedAt: null,
          malformedSessionCount: 1n,
          purgedRows: 1n,
          sessionRefreshBatch: [],
        },
      ]);
      expect(pass.deletedRows).toBe(1);
      expect(pass.sessionsRefreshed).toBe(0);
      expect(await readRollupRows(seed.organizationId)).toHaveLength(0);
    });
  });

  it("re-reads only the history of a session that received an event since it was materialized or last confirmed", async () => {
    await joinAmbientTransaction(async () => {
      const activeEvents = 40;
      const quietEvents = 200;
      const seed = await seedLinkedBranchSession({
        label: "refresh-cost",
        events: manyEvents("active", activeEvents, RECEIVED_LONG_BEFORE_CUTOFF),
      });
      const quietSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "refresh-cost-quiet",
        linkKind: SessionArtifactLinkKind.SessionPr,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      // Inside the overlap before the first pass, so the second pass re-reads
      // it and finds it unchanged. The third must not read it again.
      await seedTokenEvents(
        quietSessionId,
        manyEvents("quiet", quietEvents, RECEIVED_INSIDE_OVERLAP)
      );
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      await seedTokenEvents(seed.sessionArtifactId, [
        lateActiveEvent("active-late", RECEIVED_AFTER_CUTOFF),
      ]);
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
      });
      await seedTokenEvents(seed.sessionArtifactId, [
        lateActiveEvent("active-later", RECEIVED_AFTER_SECOND_BATCH),
      ]);

      const sourceRowsByStatement = await withDb(async (db) => {
        // Priced out for the same reason as the gate-cost case above. Nested
        // loops and merge joins too: a read keyed to one session by a JOIN
        // rather than by the statement itself is then a hash join over the
        // whole table, every organization's events included, which the
        // planner also picks unforced when the table's statistics make one
        // session look like all of it (ISS-10565, merge group 2026-10-07).
        await db.$executeRaw`SET LOCAL enable_seqscan = off`;
        await db.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        await db.$executeRaw`SET LOCAL enable_sort = off`;
        await db.$executeRaw`SET LOCAL enable_nestloop = off`;
        await db.$executeRaw`SET LOCAL enable_mergejoin = off`;
        const touched = new Map<string, number>();
        const pass = await refreshBranchAnalyticsRollupBatchTx(
          {
            $executeRaw: (statement: Prisma.Sql) => db.$executeRaw(statement),
            $queryRaw: async (statement: Prisma.Sql) => {
              const markers = REFRESH_PASS_SOURCE_MARKERS.filter((candidate) =>
                statement.text.includes(candidate)
              );
              if (markers.length > 0) {
                const sourceRowsTouched = sourceRowsTouchedBy(
                  await db.$queryRaw(
                    Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`
                  )
                );
                for (const marker of markers) {
                  touched.set(marker, sourceRowsTouched);
                }
              }
              return db.$queryRaw(statement);
            },
          } as Parameters<typeof refreshBranchAnalyticsRollupBatchTx>[0],
          { organizationId: seed.organizationId, now: THIRD_BATCH_AT }
        );
        expect(pass.sessionsRefreshed).toBe(1);
        return touched;
      });

      // The combined refresh read re-reads the active session's history, and never
      // the quiet one's: before ISS-10565 both read every event of both, and
      // with the overlap measured from `as_of` alone the quiet session was
      // re-read on every pass.
      for (const marker of REFRESH_PASS_SOURCE_MARKERS) {
        expect(sourceRowsByStatement.get(marker)).toBeGreaterThanOrEqual(
          activeEvents + 2
        );
        expect(sourceRowsByStatement.get(marker)).toBeLessThan(quietEvents);
      }
      const served = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        THIRD_BATCH_AT
      );
      expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
        eventCount: activeEvents + 2,
      });
    });
  });

  it("re-materializes an event stamped before a pass's cutoff that committed after that pass read the session", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "late-commit",
        events: manyEvents("settled", 1, RECEIVED_LONG_BEFORE_CUTOFF),
      });
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });

      // `created_at` is stamped when the ingest transaction writes the row, so
      // a row stamped inside the first pass's cutoff can still be invisible to
      // it. It moves no watermark, and it was not received after `as_of`.
      await seedTokenEvents(seed.sessionArtifactId, [
        buildEvent({
          suffix: "stamped-before-cutoff",
          inputTokens: 900,
          outputTokens: 400,
          estimatedCost: 9,
          eventCreatedAt: new Date("2026-08-01T09:00:00.000Z"),
          createdAt: RECEIVED_BEFORE_CUTOFF,
        }),
      ]);
      const secondPass = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: SECOND_BATCH_AT,
      });
      expect(secondPass.sessionsRefreshed).toBe(1);

      const served = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        SECOND_BATCH_AT
      );
      expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
        eventCount: 2,
        inputTokens: 910,
      });
    });
  });

  it("still finds a changed session a full batch left behind once its event is older than the overlap", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "bound-cut",
        events: manyEvents("first", 1, RECEIVED_LONG_BEFORE_CUTOFF),
      });
      const secondSessionId = await linkValidSessionToBranch({
        organizationId: seed.organizationId,
        userId: seed.userId,
        branchArtifactId: seed.branchArtifactId,
        label: "bound-cut-second",
        linkKind: SessionArtifactLinkKind.SessionPr,
        lastSyncedAt: SEEDED_SYNCED_AT,
      });
      await seedTokenEvents(
        secondSessionId,
        manyEvents("second", 1, RECEIVED_LONG_BEFORE_CUTOFF)
      );
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      await seedTokenEvents(seed.sessionArtifactId, [
        lateActiveEvent("first-late", RECEIVED_AFTER_CUTOFF),
      ]);
      await seedTokenEvents(secondSessionId, [
        lateActiveEvent("second-late", RECEIVED_AFTER_CUTOFF),
      ]);

      const bounded = await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: PAST_OVERLAP_BATCH_AT,
        sessionLimit: 1,
      });
      expect(bounded.sessionsRefreshed).toBe(1);
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: AFTER_BOUNDED_BATCH_AT,
      });

      const served = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId, secondSessionId],
        AFTER_BOUNDED_BATCH_AT
      );
      expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
        eventCount: 2,
      });
      expect(totalsFor(served, secondSessionId)).toMatchObject({
        eventCount: 2,
      });
    });
  });

  it("keeps serving the last materialized rollup after a refresh pass fails, until it ages past the staleness ceiling, and refuses an organization that never had one", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "failed-pass",
        events: manyEvents("served", 1),
      });
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      await recordBranchAnalyticsRollupFailure(
        seed.organizationId,
        new Error("refresh transaction closed"),
        SECOND_BATCH_AT
      );
      const served = await readAvailableAggregates(
        seed.organizationId,
        [seed.sessionArtifactId],
        SECOND_BATCH_AT
      );
      expect(totalsFor(served, seed.sessionArtifactId)).toMatchObject({
        eventCount: 1,
      });

      // A failure must not restamp the clock, or a refresh that never succeeds
      // again would be served indefinitely.
      const pastStaleness = new Date(
        BATCH_AT.getTime() + BRANCH_ANALYTICS_ROLLUP_MAX_STALENESS_MS + 60_000
      );
      await recordBranchAnalyticsRollupFailure(
        seed.organizationId,
        new Error("refresh transaction closed"),
        pastStaleness
      );
      expect(
        await readAggregates(
          seed.organizationId,
          [seed.sessionArtifactId],
          pastStaleness
        )
      ).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.StaleClock,
      });

      const neverRolledUp = await seedLinkedBranchSession({
        label: "failed-first-pass",
        events: manyEvents("unserved", 1),
      });
      await recordBranchAnalyticsRollupFailure(
        neverRolledUp.organizationId,
        new Error("refresh transaction closed"),
        SECOND_BATCH_AT
      );
      expect(
        await readAggregates(
          neverRolledUp.organizationId,
          [neverRolledUp.sessionArtifactId],
          SECOND_BATCH_AT
        )
      ).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: BranchAnalyticsRollupUnavailableReason.StateError,
      });
    });
  });

  it("keeps the newer failure when an older one finishes after it", async () => {
    await joinAmbientTransaction(async () => {
      const seed = await seedLinkedBranchSession({
        label: "failure-order",
        events: manyEvents("served", 1),
      });
      await refreshBranchAnalyticsRollupBatch({
        organizationId: seed.organizationId,
        now: BATCH_AT,
      });
      // Both failures are newer than the last good pass, so `as_of` alone
      // lets either one write.
      await recordBranchAnalyticsRollupFailure(
        seed.organizationId,
        Object.assign(new Error("Transaction already closed"), {
          code: "P2028",
        }),
        SECOND_BATCH_AT
      );
      await recordBranchAnalyticsRollupFailure(
        seed.organizationId,
        new Error("refresh transaction closed"),
        OLDER_FAILURE_AT
      );

      expect(await readRollupFailure(seed.organizationId)).toEqual({
        lastErrorAt: SECOND_BATCH_AT,
        lastErrorCode: `${BranchAnalyticsRollupFailureCategory.PrismaCodePrefix}P2028`,
      });
    });
  });
});

/** Received well before the overlap the refresh pass re-reads, unlike `RECEIVED_BEFORE_CUTOFF`. */
const RECEIVED_LONG_BEFORE_CUTOFF = new Date("2026-08-01T11:00:00.000Z");
/** Inside the overlap before `BATCH_AT`, outside the one before `SECOND_BATCH_AT`. */
const RECEIVED_INSIDE_OVERLAP = new Date("2026-08-01T11:50:00.000Z");
const RECEIVED_AFTER_SECOND_BATCH = new Date("2026-08-01T12:10:00.000Z");
const THIRD_BATCH_AT = new Date("2026-08-01T12:12:00.000Z");
/** Far enough past `RECEIVED_AFTER_CUTOFF` that its overlap no longer reaches it. */
const PAST_OVERLAP_BATCH_AT = new Date("2026-08-01T12:30:00.000Z");
const AFTER_BOUNDED_BATCH_AT = new Date("2026-08-01T12:35:00.000Z");
/** Between `BATCH_AT` and `SECOND_BATCH_AT`. */
const OLDER_FAILURE_AT = new Date("2026-08-01T12:03:00.000Z");

const REFRESH_PASS_SOURCE_MARKERS = [
  SOURCE_WATERMARK_MARKER,
  REFRESH_QUEUE_MARKER,
] as const;

/** Below the session's watermark, so only its count can show it arrived. */
function lateActiveEvent(suffix: string, createdAt: Date): SeededEvent {
  return buildEvent({
    suffix,
    inputTokens: 10,
    outputTokens: 5,
    estimatedCost: 1,
    eventCreatedAt: new Date("2026-08-01T09:00:00.000Z"),
    createdAt,
  });
}

function manyEvents(
  suffix: string,
  count: number,
  createdAt?: Date
): SeededEvent[] {
  return Array.from({ length: count }, (_, index) =>
    buildEvent({
      suffix: `${suffix}-${index}`,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 1,
      eventCreatedAt: new Date(Date.UTC(2026, 7, 1, 10, 0, index)),
      createdAt,
    })
  );
}

type ExplainPlanNode = {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: ExplainPlanNode[];
};

/** Source-event rows the executor visited, from `EXPLAIN (ANALYZE, FORMAT JSON)`. */
function sourceRowsTouchedBy(explainRows: unknown): number {
  const [row] = explainRows as { "QUERY PLAN": { Plan: ExplainPlanNode }[] }[];
  return sourceRowsUnder(row["QUERY PLAN"][0].Plan);
}

function sourceRowsUnder(node: ExplainPlanNode): number {
  const own =
    node["Relation Name"] === SOURCE_EVENTS_RELATION
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0;
  return (node.Plans ?? []).reduce(
    (sum, child) => sum + sourceRowsUnder(child),
    own
  );
}

function readRollupFailure(
  organizationId: string
): Promise<{ lastErrorAt: Date | null; lastErrorCode: string | null } | null> {
  return withDb((db) =>
    db.branchAnalyticsRollupState.findUnique({
      where: { organizationId },
      select: { lastErrorAt: true, lastErrorCode: true },
    })
  );
}
