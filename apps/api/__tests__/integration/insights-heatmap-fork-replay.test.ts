/**
 * ISS-8659: a `/fork` child replays its parent's records verbatim, each stamped
 * `isForkReplayed`. `agentLegacyMessageRowsSql` is the cloud half of the Event
 * Activity heatmap's `$.messages` reading, and its desktop twin
 * (`collectLegacyAgentMessageUnits`) was gated in the same change — so a fork
 * must not be credited with its parent's turns on EITHER surface.
 *
 * Runs against a REAL Postgres (self-skips when DATABASE_URL is unset) because
 * the filter is SQL: a unit test that mocks `withDb` never runs the query, and
 * before this file `apps/api` seeded no `isForkReplayed` anywhere, so deleting
 * the filter left the whole suite green while the cloud heatmap silently
 * disagreed with desktop.
 *
 * Two properties, failing for different reasons:
 *   1. A replayed turn is excluded from the buckets. Deleting the filter
 *      reddens this.
 *   2. A NON-BOOLEAN `isForkReplayed` degrades instead of 500-ing. Nothing
 *      validates this synced blob's element shape, so writing the filter as a
 *      `::boolean` cast makes one junk row RAISE and take the endpoint with it.
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

type SeededMessage = {
  role: string;
  timestamp: string;
  isForkReplayed?: unknown;
};

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "heatmap-fork-replay-machine",
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function seedForkSession(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  computeTargetId: string;
  messages: SeededMessage[];
}) {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "Fork-replay heatmap session",
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
        lastActivityAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        // No token events are seeded, so this session takes the legacy
        // `$.messages` arm of the heatmap — the arm the filter lives in.
        metadata: {
          entrypoint: "cli",
          messages: input.messages,
        } as Prisma.InputJsonValue,
      },
      // The row is not read back. An explicit projection keeps this write out of
      // the default-projection population `session-detail-state-inventory` gates
      // — the sibling suites predate that gate and are listed in it instead.
      select: { artifactId: true },
    })
  );
  return artifact.id;
}

async function bucketTotals(organizationId: string, userId: string) {
  const result = await insightsService.getUtilization(
    {
      organizationId,
      userId,
      scope: InsightsScope.Org,
      // Bucket in UTC so the seeded turns' hours are deterministic.
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
    agentHours: cells.filter((cell) => cell.agent > 0).map((cell) => cell.hour),
    human: cells.reduce((sum, cell) => sum + cell.human, 0),
  };
}

describe.skipIf(!hasDatabase)(
  "insights utilization heatmap — a fork is not credited with its parent's turns",
  () => {
    it("omits replayed turns from the buckets and counts only the fork's own", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id
        );

        await seedForkSession({
          organizationId,
          projectId,
          userId: user.id,
          computeTargetId,
          messages: [
            // The parent's work, replayed into the fork verbatim.
            {
              role: "assistant",
              timestamp: "2026-06-10T10:00:00.000Z",
              isForkReplayed: true,
            },
            {
              role: "assistant",
              timestamp: "2026-06-10T10:30:00.000Z",
              isForkReplayed: true,
            },
            // The fork's own turn.
            { role: "assistant", timestamp: "2026-06-10T11:00:00.000Z" },
          ],
        });

        const totals = await bucketTotals(organizationId, user.id);
        // Ungated this is 3 — the two inherited turns plus the own one.
        expect(totals.agent).toBe(1);
        // And it is the fork's OWN 11:00 turn that survives, not an inherited
        // one: a count alone cannot tell those apart.
        expect(totals.agentHours).toEqual([11]);
      });
    });

    it("keeps a turn whose isForkReplayed is a non-boolean, and does not error", async () => {
      // The filter compares jsonb to jsonb precisely so these rows cannot RAISE.
      // A `::boolean` cast on any one of them aborts the whole query, which is a
      // 500 on the Insights surface for the entire org rather than a dropped row.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id
        );

        await seedForkSession({
          organizationId,
          projectId,
          userId: user.id,
          computeTargetId,
          messages: [
            { role: "assistant", timestamp: "2026-06-10T10:00:00.000Z" },
            {
              role: "assistant",
              timestamp: "2026-06-10T10:15:00.000Z",
              isForkReplayed: 2,
            },
            {
              role: "assistant",
              timestamp: "2026-06-10T10:30:00.000Z",
              isForkReplayed: "maybe",
            },
            {
              role: "assistant",
              timestamp: "2026-06-10T10:45:00.000Z",
              isForkReplayed: {},
            },
            {
              role: "assistant",
              timestamp: "2026-06-10T11:00:00.000Z",
              isForkReplayed: null,
            },
          ],
        });

        // Junk is not the flag, so every turn is the fork's own: nothing is
        // dropped and, above all, nothing throws.
        const totals = await bucketTotals(organizationId, user.id);
        expect(totals.agent).toBe(5);
      });
    });
  }
);
