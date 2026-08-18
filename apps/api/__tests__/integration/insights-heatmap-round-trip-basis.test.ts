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

import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { insightsService } from "@/app/insights/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// A fixed "now" inside the seeded turns' window so the capped trend range covers
// them regardless of when the suite runs.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const SESSION_STARTED_AT = new Date("2026-06-10T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-06-10T13:00:00.000Z");
const DAY = "2026-06-10";
// Every seeded round-trip lands in this hour so the assertion is a single cell.
const AGENT_HOUR = 11;
const HUMAN_HOUR = 10;

/**
 * The ISS-5395 delegation shape, scaled down but keeping the ratio: one
 * produce-loop session measured 13,589 of 14,226 round-trips attributed to
 * folded sub-agents (~95.5%). A live desktop store showed the same shape at
 * 18,052 round-trips against 786 parent-only turn buckets (95.6% delegated).
 */
const TOTAL_ROUND_TRIPS = 1000;
const PARENT_ROUND_TRIPS = 44;
const SUBAGENT_ROUND_TRIPS = TOTAL_ROUND_TRIPS - PARENT_ROUND_TRIPS;

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "heatmap-round-trip-basis-machine",
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function seedSession(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  computeTargetId: string;
  messages: Array<{ role: string; timestamp: string }>;
  /** Count of synced billable round-trips. Zero ⇒ an older/OTel-only desktop. */
  roundTrips: number;
  /**
   * `metadata.entrypoint`. Defaults to the interactive CLI; pass a headless one
   * (`codex exec` matches `HEADLESS_ENTRYPOINT_TOKENS`) to exercise the headless
   * classifier.
   */
  entrypoint?: string;
}) {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "Round-trip basis session",
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
        externalSessionId: `session-${artifact.id}`,
        harness: "claude",
        model: "claude-opus-4",
        sessionStartedAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        userId: input.userId,
        // Cast to the Prisma JSON input type — the array-of-objects shape is
        // valid JSON but TS can't infer the structural index signature.
        metadata: {
          entrypoint: input.entrypoint ?? "cli",
          messages: input.messages,
        } as Prisma.InputJsonValue,
      },
    })
  );
  if (input.roundTrips > 0) {
    await withDb((db) =>
      db.agentSessionTokenEvent.createMany({
        data: Array.from({ length: input.roundTrips }, (_, i) => ({
          agentSessionId: artifact.id,
          // Mirrors the desktop transport identity: stable and unique per
          // round-trip. The cloud carries NO subagent discriminator — the
          // desktop `token_events` table has no such column — so a folded
          // sub-agent's round-trip is an ordinary row here, which is exactly
          // why the cloud can count the session's true billable total.
          externalEventId: `token-event-${i}`,
          model: "claude-opus-4",
          eventCreatedAt: new Date(`${DAY}T${AGENT_HOUR}:00:00.000Z`),
        })),
      })
    );
  }
  return artifact.id;
}

/** One assistant `$.messages` row per content block — the OLD, inflated basis. */
function assistantRows(count: number) {
  return Array.from({ length: count }, () => ({
    role: "assistant",
    timestamp: `${DAY}T${AGENT_HOUR}:00:00.000Z`,
  }));
}

function humanRows(count: number) {
  return Array.from({ length: count }, () => ({
    role: "human",
    timestamp: `${DAY}T${HUMAN_HOUR}:00:00.000Z`,
  }));
}

async function readHeatmapTotals(organizationId: string, userId: string) {
  const result = await insightsService.getUtilization(
    {
      organizationId,
      userId,
      scope: InsightsScope.Org,
      // Bucket in UTC so the seeded hours are deterministic.
      timeZone: "UTC",
    },
    InsightsPeriod.Month,
    NOW
  );
  const cells = (result.charts.activityHeatmap?.cells ?? []).filter(
    (cell) => cell.day === DAY
  );
  return {
    agent: cells.reduce((sum, cell) => sum + cell.agent, 0),
    human: cells.reduce((sum, cell) => sum + cell.human, 0),
    cells,
  };
}

async function seedScope() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  return { organizationId, projectId, userId: user.id, computeTargetId };
}

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
  }
);
