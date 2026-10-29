/**
 * ISS-5408: the cloud Event Activity heatmap must count an Agent turn as one
 * BILLABLE ROUND-TRIP, not one `$.messages` assistant ROW.
 *
 * Claude Code writes one JSONL line per content BLOCK, so a single round-trip
 * splits across text/tool_use/thinking rows. The desktop's `session_turn_bucket`
 * abandoned the row basis for that reason (FEA-3597); the cloud could not follow
 * because it derives from `metadata.tokenSeries`, which is stripped before sync.
 * It does not need to: the same parsed series is materialized into the desktop's
 * `token_events` table and synced verbatim into `agent_session_token_events`,
 * one row per round-trip, INCLUDING round-trips performed by folded sub-agents.
 *
 * These run against a REAL Postgres (self-skip when DATABASE_URL is unset) so
 * they exercise the actual SQL — a unit test that mocks `withDb` never runs the
 * query and cannot prove any of this.
 *
 * Covered:
 *  1. The ~95%-delegation shape from ISS-5395: cloud renders every round-trip,
 *     not the parent-only subset and not the inflated assistant-row count.
 *  2. The non-delegating common case is NOT moved: with no folded sub-agent
 *     round-trips the parent-only rule and the all-round-trips rule are
 *     arithmetically identical, so cloud and desktop agree either way.
 *  3. Disjointness: a session counted on the round-trip basis must NOT also have
 *     its assistant rows counted (that would double-count).
 *  4. Version skew, both directions: an older desktop that syncs no token events
 *     still renders (legacy assistant-row fallback, never a false idle), and a
 *     newer one that syncs them gets the corrected basis.
 *  5. The intersection of the two fallback classes — a session that is HEADLESS
 *     and synced no token events. `humanTurnsSql` suppresses its injected
 *     `human` prompts, so the legacy Agent fallback has to keep the prior
 *     headless→Agent promotion or those rows land in neither half and leave the
 *     grid. Case 4 above is the non-headless control: same branch, same message
 *     mix, interactive entrypoint, prompts stay Human.
 */

import { describe, expect, it } from "vitest";
import {
  assistantRows,
  DAY,
  HUMAN_HOUR,
  hasDatabase,
  humanRows,
  PARENT_ROUND_TRIPS,
  readHeatmapTotals,
  SUBAGENT_ROUND_TRIPS,
  seedScope,
  seedSession,
  TOTAL_ROUND_TRIPS,
} from "@/__tests__/support/insights/heatmap-round-trip-basis.test-helpers";
import { autoRollbackTransaction } from "../utils/db-helpers";

describe.skipIf(!hasDatabase)(
  "insights utilization heatmap — Agent turns are billable round-trips (ISS-5408)",
  () => {
    it("renders every round-trip of a ~95%-delegating session, not the parent-only subset", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // The session performed TOTAL_ROUND_TRIPS billable round-trips; all but
        // PARENT_ROUND_TRIPS of them were performed by folded sub-agents. Only
        // a handful of assistant ROWS survive the cloud's MAX_METADATA_MESSAGES
        // cap — which is exactly why the old row-counting rule collapsed a very
        // busy session into a nearly idle cell.
        await seedSession({
          ...scope,
          roundTrips: TOTAL_ROUND_TRIPS,
          messages: assistantRows(12),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        // The whole point of the ticket: the busy period reads busy.
        expect(agent).toBe(TOTAL_ROUND_TRIPS);
        // Not the parent-only subset the desktop's local table still shows.
        expect(agent).not.toBe(PARENT_ROUND_TRIPS);
        // Not the assistant-ROW count the cloud used before.
        expect(agent).not.toBe(12);
        // And the delegated work is the overwhelming majority of the cell, so a
        // regression back to a parent-only rule cannot pass this.
        expect(agent - PARENT_ROUND_TRIPS).toBe(SUBAGENT_ROUND_TRIPS);
      });
    });

    it("does not move the non-delegating common case: with no folded sub-agent round-trips the two rules agree", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // A session whose every round-trip is the parent's own. The desktop's
        // parent-ONLY predicate and this side's all-round-trips predicate select
        // the identical set here, so cloud and desktop agree under BOTH rules —
        // the correction is inert on the common case by construction.
        await seedSession({
          ...scope,
          roundTrips: PARENT_ROUND_TRIPS,
          messages: [...assistantRows(9), ...humanRows(3)],
        });

        const { agent, human } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(PARENT_ROUND_TRIPS);
        // Human turns still come from `$.messages` and are untouched by ISS-5408.
        expect(human).toBe(3);
      });
    });

    it("counts a round-trip session on exactly one basis — assistant rows are not added on top", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // Both sources are populated and land in the SAME cell. If the legacy
        // assistant-row branch were not disjoint from the round-trip branch the
        // cell would read 25, double-counting the same work.
        await seedSession({
          ...scope,
          roundTrips: 15,
          messages: assistantRows(10),
        });

        const { agent, cells } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(15);
        expect(agent).not.toBe(25);
        // One session, one hour, one cell.
        expect(cells.filter((cell) => cell.agent > 0)).toHaveLength(1);
      });
    });

    it("skew — an OLDER desktop that syncs no token events still renders its agent activity", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // A pre-FEA-2730 row, or a Codex session whose OTel writer populates
        // `token_usage` but not `token_events`. Counting it as zero would show a
        // genuinely busy period as idle, so it degrades to the legacy basis.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: [...assistantRows(7), ...humanRows(2)],
        });

        const { agent, human } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(7);
        expect(human).toBe(2);
      });
    });

    it("skew — old and new sessions in one window each contribute on their own basis", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // NEW: 20 synced round-trips, plus assistant rows that must be ignored.
        await seedSession({
          ...scope,
          roundTrips: 20,
          messages: assistantRows(6),
        });
        // OLD: no token events, so its 5 assistant rows are the best basis
        // available for it.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(5),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        // 20 round-trips + 5 legacy rows. Neither session is dropped, and the
        // new session's assistant rows are not added a second time.
        expect(agent).toBe(25);
      });
    });

    it("headless session with no token events — its injected human prompts stay on the grid as Agent", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // The intersection of the two fallback classes: headless AND no synced
        // round-trip series. `codex exec` matches HEADLESS_ENTRYPOINT_TOKENS
        // while the Codex OTel writer persists `token_usage` and not
        // `token_events`, so this shape is real, not hypothetical.
        //
        // `humanTurnsSql` suppresses these `human` rows via
        // `NOT COALESCE(headless, false)`. If the legacy Agent fallback counted
        // `role = 'assistant'` ONLY, they would be counted in NEITHER half and
        // would simply leave the grid — a day whose only activity was
        // `codex exec` runs going from lit to blank, the exact false-idle
        // failure this ticket exists to prevent.
        await seedSession({
          ...scope,
          entrypoint: "codex exec",
          roundTrips: 0,
          messages: [...assistantRows(7), ...humanRows(2)],
        });

        const { agent, human, cells } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        // 7 assistant rows + the 2 promoted headless prompts. Counting only the
        // assistant rows (7) is the regression this pins.
        expect(agent).toBe(9);
        // Suppressed as Human because the session is headless — that half is
        // unchanged, and is precisely why the promotion has to stay.
        expect(human).toBe(0);
        // Every seeded row is accounted for: nothing left the grid.
        const totalTurns = cells.reduce(
          (sum, cell) => sum + cell.human + cell.agent,
          0
        );
        expect(totalTurns).toBe(9);
        // The promoted prompts bucket at the hour they were injected, not at the
        // assistant hour — they are individually attributed, not session-rolled.
        const humanHourCell = cells.find((cell) => cell.hour === HUMAN_HOUR);
        expect(humanHourCell?.agent).toBe(2);
      });
    });

    it("counts round-trips for a session with no `$.messages` at all", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();

        // The two halves read INDEPENDENT sources and are guarded independently
        // (mirroring the desktop's deriveSessionTurnBuckets): absent messages
        // must not suppress the Agent cells.
        await seedSession({ ...scope, roundTrips: 8, messages: [] });

        const { agent, human } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(8);
        expect(human).toBe(0);
      });
    });
    // ISS-7896 — the HUMAN half is now two disjoint per-session arms. Arm 1 reads
    // `metadata.humanTurnTimestamps` (derived by the desktop from the FULL local
    // messages array, so it is not bounded by MAX_METADATA_MESSAGES); arm 2 is
    // the pre-existing `$.messages` path. `hasTurnTimestampsSql` is the one
    // expression that splits them.
    describe("human-turn basis (ISS-7896)", () => {
      const stamps = (count: number) =>
        Array.from({ length: count }, () => `${DAY}T${HUMAN_HOUR}:00:00.000Z`);

      it("counts the derived key and ignores the $.messages rows it displaces", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          // The real shape of the bug: `messages` reaches the cloud capped, the
          // derived key carries the true count. Arm 1 must not also add the 3
          // rows arm 2 would have counted.
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: humanRows(3),
            humanTurnTimestamps: stamps(9),
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(9);
        });
      });

      it("falls back to $.messages when the key is absent", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: humanRows(3),
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(3);
        });
      });

      it("treats an EMPTY array as an authoritative zero and ignores $.messages", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          // The version-skew case that separates the two readings: the producer
          // derived `[]` (it classified this session headless) while the rows
          // it left in `messages` are that session's INJECTED prompts. The
          // desktop chart renders no human cells for it, so counting the 3 rows
          // here would report MORE human activity than the oracle.
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: humanRows(3),
            humanTurnTimestamps: [],
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(0);
          expect(human).not.toBe(3);
        });
      });

      it("falls back when the key is present but not an array", async () => {
        for (const notAnArray of [
          "2026-06-10T10:00:00.000Z",
          5,
          null,
          { a: 1 },
        ]) {
          await autoRollbackTransaction(async () => {
            const scope = await seedScope();
            await seedSession({
              ...scope,
              roundTrips: 0,
              messages: humanRows(3),
              humanTurnTimestamps: notAnArray,
            });

            const { human } = await readHeatmapTotals(
              scope.organizationId,
              scope.userId
            );

            expect(
              human,
              `humanTurnTimestamps=${JSON.stringify(notAnArray)}`
            ).toBe(3);
          });
        }
      });

      it("keeps the two arms disjoint across a mixed population", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          // One old session and one new one in the SAME query. If the arms
          // overlapped, the new session would be counted twice (9 + 4 = 13).
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: humanRows(4),
            humanTurnTimestamps: stamps(9),
          });
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: humanRows(3),
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(12);
        });
      });

      it("excludes a headless session on the derived arm too", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          // The producer already excludes headless sessions, but this side does
          // not depend on that agreement — the two classifiers run on different
          // machines and different versions.
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: [],
            entrypoint: "codex exec",
            humanTurnTimestamps: stamps(5),
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(0);
        });
      });

      it("drops malformed entries without failing the request", async () => {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          // Arm 1 is a SECOND jsonb_array_elements -> ::timestamp path. A bad
          // value must drop out of the buckets, never 500 /insights/utilization.
          // `20260101` is PostgreSQL-valid and so is the value that kills a
          // missing `jsonb_typeof(t) = 'string'` guard; an epoch string is not.
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: [],
            humanTurnTimestamps: [
              `${DAY}T${HUMAN_HOUR}:00:00.000Z`,
              "not-a-date",
              "2026-02-30T00:00:00.000Z",
              "",
              20_260_101,
              null,
              { at: `${DAY}T${HUMAN_HOUR}:00:00.000Z` },
              [`${DAY}T${HUMAN_HOUR}:00:00.000Z`],
            ],
          });

          const { human } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(human).toBe(1);
        });
      });
    });
  }
);
