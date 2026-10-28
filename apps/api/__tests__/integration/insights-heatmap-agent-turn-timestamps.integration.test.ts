/**
 * ISS-9864: on a session that synced NO token events, the cloud Event Activity
 * heatmap's Agent half is two disjoint per-session arms — the desktop-derived
 * `metadata.agentTurnTimestamps` key when present, and the pre-existing raw
 * `$.messages` read (still capped at `MAX_METADATA_MESSAGES`) otherwise.
 * `hasTurnTimestampsSql` is the one expression that splits them, and both
 * sit behind the same `NOT EXISTS (token events)` as before, so a round-trip
 * session is never counted on either.
 *
 * Runs against a REAL Postgres (self-skips when DATABASE_URL is unset) so the
 * SQL — the `jsonb_array_elements` over the key, the `NOT` on the fallback arm,
 * the absence of a headless guard — actually executes. The harness is shared
 * with the ISS-5408/ISS-7896 suite in `insights-heatmap-round-trip-basis.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_HOUR,
  assistantRows,
  DAY,
  hasDatabase,
  humanRows,
  readHeatmapTotals,
  seedScope,
  seedSession,
} from "@/__tests__/support/insights/heatmap-round-trip-basis.test-helpers";
import { autoRollbackTransaction } from "../utils/db-helpers";

const stamps = (count: number) =>
  Array.from({ length: count }, () => `${DAY}T${AGENT_HOUR}:00:00.000Z`);

describe.skipIf(!hasDatabase)(
  "insights utilization heatmap — agent-turn basis for token-event-less sessions (ISS-9864)",
  () => {
    it("counts the derived key past the 100-row window the synced messages are capped at", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // THE TICKET'S OWN SHAPE. The synced `messages` array reaches the cloud
        // capped at exactly 100 assistant rows; the desktop derived the key from
        // its full 150. A reader that still counted rows, or applied any 100
        // bound (a generic array cap, an accidental LIMIT) to the key, reports
        // 100 here.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(100),
          agentTurnTimestamps: stamps(150),
        });

        const { agent, human } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(150);
        expect(human).toBe(0);
      });
    });

    it("counts the key and ignores the $.messages rows it displaces", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // Disjointness of the two token-event-less arms: 9, never 9 + 3.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(3),
          agentTurnTimestamps: stamps(9),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(9);
      });
    });

    it("falls back to $.messages when the key is absent", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // An older desktop, or a producer that withheld the key.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(3),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(3);
      });
    });

    it("treats an EMPTY array as an authoritative zero and ignores $.messages", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // The producer derived `[]` — the desktop chart renders no agent cells
        // for this session — while the rows it left in `messages` would have
        // counted 3 on the fallback. Taking authority keeps the surfaces equal.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(3),
          agentTurnTimestamps: [],
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(0);
      });
    });

    it("falls back when the key is present but not an array", async () => {
      for (const notAnArray of ["not-an-array", 5, null, { count: 5 }]) {
        await autoRollbackTransaction(async () => {
          const scope = await seedScope();
          await seedSession({
            ...scope,
            roundTrips: 0,
            messages: assistantRows(3),
            agentTurnTimestamps: notAnArray,
          });

          const { agent } = await readHeatmapTotals(
            scope.organizationId,
            scope.userId
          );

          expect(
            agent,
            `agentTurnTimestamps=${JSON.stringify(notAnArray)}`
          ).toBe(3);
        });
      }
    });

    it("keeps the two arms disjoint across a mixed population", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(3),
          agentTurnTimestamps: stamps(9),
        });
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: assistantRows(4),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        // 9 from the key arm + 4 from the fallback arm; never 9 + 3 + 4.
        expect(agent).toBe(13);
      });
    });

    it("ignores the key on a session that synced round-trips — token events win", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // The producer omits the key on such a session (D2); this side does not
        // depend on that. The three agent arms split on token-event presence
        // FIRST, so a stray key can never double-count a round-trip session.
        await seedSession({
          ...scope,
          roundTrips: 7,
          messages: assistantRows(20),
          agentTurnTimestamps: stamps(40),
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(7);
      });
    });

    it("counts a headless session's key as Agent with no headless guard", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // The desktop folded the FEA-2641 promotion into the unit list: this
        // key already holds the session's injected prompts. Unlike the human
        // key arm there is nothing to suppress and no role to re-check, so the
        // array is taken whole — and the human half stays at zero.
        await seedSession({
          ...scope,
          roundTrips: 0,
          entrypoint: "codex exec",
          messages: [...humanRows(2), ...assistantRows(3)],
          agentTurnTimestamps: stamps(5),
        });

        const { agent, human } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(5);
        expect(human).toBe(0);
      });
    });

    it("drops malformed entries without failing the request", async () => {
      await autoRollbackTransaction(async () => {
        const scope = await seedScope();
        // A second `jsonb_array_elements -> ::timestamp` path. A bad value must
        // drop out of the buckets, never 500 `/insights/utilization`.
        await seedSession({
          ...scope,
          roundTrips: 0,
          messages: [],
          agentTurnTimestamps: [
            `${DAY}T${AGENT_HOUR}:00:00.000Z`,
            "not-a-date",
            "2026-02-30T00:00:00.000Z",
            "",
            20_260_101,
            null,
            { at: `${DAY}T${AGENT_HOUR}:00:00.000Z` },
            [`${DAY}T${AGENT_HOUR}:00:00.000Z`],
          ],
        });

        const { agent } = await readHeatmapTotals(
          scope.organizationId,
          scope.userId
        );

        expect(agent).toBe(1);
      });
    });
  }
);
