/**
 * FEA-3684 (codex P2 — Thread 1): the cloud Utilization endpoint computes the
 * Event Activity heatmap from each session's synced `metadata.messages[]`,
 * casting `m ->> 'timestamp'` to `::timestamp` in the SELECT. A synced row whose
 * timestamp is a calendar-invalid date (Feb 30, month 13, hour 25) or a valid
 * prefix followed by trailing junk would pass a prefix-only regex guard and then
 * make Postgres RAISE during that cast — 500-ing the ENTIRE endpoint on one bad
 * row.
 *
 * This runs against a REAL Postgres (self-skips when DATABASE_URL is unset) so it
 * exercises the actual SQL — a unit test that mocks `withDb` cannot, since it
 * never runs the query. Two hardening properties are covered:
 *   1. `pg_input_is_valid(text, 'timestamp')` full-string guard (Thread 1):
 *      `getUtilization` returns a heatmap (does NOT throw) and only the
 *      well-formed turns land in the buckets while every malformed turn is
 *      silently omitted.
 *   2. `COALESCE(headless, false)` (stage bot P1): a Human turn from a session
 *      whose headless predicate is NULL (no entrypoint/permissionMode) is still
 *      counted, not dropped by NULL-propagation through the CASE aggregates.
 *
 * ISS-5408 narrowed which halves of the chart read `metadata.messages[]`: Agent
 * turns now come from the synced billable round-trip series, and `$.messages` is
 * the source for Human turns plus the legacy Agent fallback for sessions that
 * synced no round-trips. Both seeded sessions here are of that legacy shape (no
 * token events), so both `$.messages` paths — and therefore both hardening
 * properties above — remain exercised exactly as before.
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

async function createComputeTarget(organizationId: string, userId: string) {
  const target = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "heatmap-malformed-ts-machine",
        organizationId,
        platform: "darwin",
        userId,
      },
      select: { id: true },
    })
  );
  return target.id;
}

async function seedSessionWithMessages(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  computeTargetId: string;
  messages: Array<{ role: string; timestamp: string }>;
  // Extra top-level metadata keys (e.g. `entrypoint`). Omit to seed a session
  // with NO entrypoint/permissionMode — the headless predicate is then NULL.
  extraMetadata?: Record<string, unknown>;
}) {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "Heatmap malformed-timestamp session",
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
        // The heatmap reads turns straight out of metadata.messages[]. Cast to
        // the Prisma JSON input type — the array-of-objects shape is valid JSON
        // but TS can't infer the structural index signature Prisma requires.
        metadata: {
          ...input.extraMetadata,
          messages: input.messages,
        } as Prisma.InputJsonValue,
      },
    })
  );
  return artifact.id;
}

describe.skipIf(!hasDatabase)(
  "insights utilization heatmap — malformed/edge rows are hardened, not fatal",
  () => {
    it("returns 200 with the bad turn omitted when a synced row has a calendar-invalid / junk timestamp", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id
        );

        await seedSessionWithMessages({
          organizationId,
          projectId,
          userId: user.id,
          computeTargetId,
          extraMetadata: { entrypoint: "cli" },
          messages: [
            // One well-formed HUMAN turn @ 10:00 UTC.
            { role: "human", timestamp: "2026-06-10T10:00:00.000Z" },
            // One well-formed ASSISTANT turn @ 11:00 UTC.
            { role: "assistant", timestamp: "2026-06-10T11:00:00.000Z" },
            // Calendar-invalid date — passes a prefix regex but the ::timestamp
            // cast RAISEs. Must be dropped, not fatal.
            { role: "human", timestamp: "2026-02-30T10:00:00.000Z" },
            // Month 13 — out of range, cast RAISEs.
            { role: "assistant", timestamp: "2026-13-01T10:00:00.000Z" },
            // Hour 25 — out of range, cast RAISEs.
            { role: "human", timestamp: "2026-06-10T25:00:00.000Z" },
            // Valid prefix + trailing junk — cast RAISEs on the whole string.
            { role: "assistant", timestamp: "2026-06-10T12:00:00ZZjunk" },
            // Empty / non-date text — never valid.
            { role: "human", timestamp: "" },
            { role: "assistant", timestamp: "not-a-date" },
          ],
        });

        const ctx = {
          organizationId,
          userId: user.id,
          scope: InsightsScope.Org,
          // Bucket in UTC so the seeded turns' hours are deterministic.
          timeZone: "UTC",
        };

        // The whole point of the fix: this call must NOT throw. Before the fix,
        // the malformed rows reached the cast and Postgres 500'd the endpoint.
        const result = await insightsService.getUtilization(
          ctx,
          InsightsPeriod.Month,
          NOW
        );

        const heatmap = result.charts.activityHeatmap;
        expect(heatmap).toBeDefined();

        // Only the two well-formed turns survive: a Human cell at 10:00 and an
        // Agent cell at 11:00 on 2026-06-10. Every malformed turn is omitted.
        const cellsForDay = (heatmap?.cells ?? []).filter(
          (c) => c.day === "2026-06-10"
        );
        const totalHuman = cellsForDay.reduce((sum, c) => sum + c.human, 0);
        const totalAgent = cellsForDay.reduce((sum, c) => sum + c.agent, 0);
        expect(totalHuman).toBe(1);
        expect(totalAgent).toBe(1);

        const humanCell = cellsForDay.find((c) => c.human > 0);
        expect(humanCell?.hour).toBe(10);
        expect(humanCell?.human).toBe(1);

        const agentCell = cellsForDay.find((c) => c.agent > 0);
        expect(agentCell?.hour).toBe(11);
        expect(agentCell?.agent).toBe(1);
      });
    });

    it("counts a Human turn from a session whose headless predicate is NULL (no entrypoint/permissionMode)", async () => {
      // stage bot P1: headlessSessionSql is an OR of LIKE/`=` terms over
      // entrypoint/permissionMode; when BOTH are absent the whole predicate is
      // NULL, not false. Without COALESCE(headless, false) the projected NULL
      // makes `role='human' AND NOT headless` evaluate NULL, dropping the Human
      // turn from BOTH the human and agent buckets. With the COALESCE it is
      // correctly counted as Human (absent signal ⇒ not headless).
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const projectId = await createTestProject(organizationId, user.id);
        const computeTargetId = await createComputeTarget(
          organizationId,
          user.id
        );

        await seedSessionWithMessages({
          organizationId,
          projectId,
          userId: user.id,
          computeTargetId,
          // No entrypoint and no permissionMode ⇒ headless predicate is NULL.
          extraMetadata: {},
          messages: [
            { role: "human", timestamp: "2026-06-10T10:00:00.000Z" },
            { role: "assistant", timestamp: "2026-06-10T11:00:00.000Z" },
          ],
        });

        const ctx = {
          organizationId,
          userId: user.id,
          scope: InsightsScope.Org,
          timeZone: "UTC",
        };

        const result = await insightsService.getUtilization(
          ctx,
          InsightsPeriod.Month,
          NOW
        );

        const cellsForDay = (result.charts.activityHeatmap?.cells ?? []).filter(
          (c) => c.day === "2026-06-10"
        );
        const totalHuman = cellsForDay.reduce((sum, c) => sum + c.human, 0);
        const totalAgent = cellsForDay.reduce((sum, c) => sum + c.agent, 0);
        // The Human turn is counted (not dropped by a NULL predicate); the
        // assistant turn is Agent as always.
        expect(totalHuman).toBe(1);
        expect(totalAgent).toBe(1);
      });
    });
  }
);
