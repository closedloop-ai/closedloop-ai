/**
 * Shared seeding + reading harness for the cloud activity-heatmap integration
 * suites (`insights-heatmap-round-trip-basis.test.ts`,
 * `insights-heatmap-agent-turn-timestamps.integration.test.ts`). Extracted by
 * ISS-9864 when the second suite would have pushed the first past the 500-line
 * smell; the constants and seeders describe ONE fixture shape, so they live
 * here rather than in each file.
 *
 * Runs against a REAL Postgres (`hasDatabase` self-skips when DATABASE_URL is
 * unset) so the SQL under test actually executes.
 */
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { AGENT_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/agent-turn-timestamps";
import { HUMAN_TURN_TIMESTAMPS_METADATA_KEY } from "@repo/lib/agent-sessions/human-turn-timestamps";
import { insightsService } from "@/app/insights/service";
import {
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../../utils/db-helpers";

const env = keys();
export const hasDatabase = !!env.DATABASE_URL;

// A fixed "now" inside the seeded turns' window so the capped trend range covers
// them regardless of when the suite runs.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const SESSION_STARTED_AT = new Date("2026-06-10T09:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-06-10T13:00:00.000Z");
export const DAY = "2026-06-10";
// Every seeded round-trip lands in this hour so the assertion is a single cell.
export const AGENT_HOUR = 11;
export const HUMAN_HOUR = 10;

/**
 * The ISS-5395 delegation shape, scaled down but keeping the ratio: one
 * produce-loop session measured 13,589 of 14,226 round-trips attributed to
 * folded sub-agents (~95.5%). A live desktop store showed the same shape at
 * 18,052 round-trips against 786 parent-only turn buckets (95.6% delegated).
 */
export const TOTAL_ROUND_TRIPS = 1000;
export const PARENT_ROUND_TRIPS = 44;
export const SUBAGENT_ROUND_TRIPS = TOTAL_ROUND_TRIPS - PARENT_ROUND_TRIPS;

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

export async function seedSession(input: {
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
  /**
   * ISS-7896 `metadata.humanTurnTimestamps`. `undefined` omits the key (an older
   * desktop, or a producer that declined to carry it) so the session reads on the
   * `$.messages` fallback arm.
   */
  humanTurnTimestamps?: unknown;
  /**
   * ISS-9864 `metadata.agentTurnTimestamps`. Same three states as the human
   * key: `undefined` omits it (the session reads on the raw `$.messages`
   * fallback arm), an array is authoritative, anything else falls back.
   */
  agentTurnTimestamps?: unknown;
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
        lastActivityAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_UPDATED_AT,
        // Cast to the Prisma JSON input type — the array-of-objects shape is
        // valid JSON but TS can't infer the structural index signature.
        metadata: {
          entrypoint: input.entrypoint ?? "cli",
          messages: input.messages,
          ...(HUMAN_TURN_TIMESTAMPS_METADATA_KEY in input
            ? {
                [HUMAN_TURN_TIMESTAMPS_METADATA_KEY]: input.humanTurnTimestamps,
              }
            : {}),
          ...(AGENT_TURN_TIMESTAMPS_METADATA_KEY in input
            ? {
                [AGENT_TURN_TIMESTAMPS_METADATA_KEY]: input.agentTurnTimestamps,
              }
            : {}),
        } as Prisma.InputJsonValue,
      },
      // The row is never read back here; naming one column keeps this write
      // off the default-projection inventory `session-detail-state-inventory`
      // guards (the projection would otherwise carry `state`).
      select: { artifactId: true },
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
export function assistantRows(count: number) {
  return Array.from({ length: count }, () => ({
    role: "assistant",
    timestamp: `${DAY}T${AGENT_HOUR}:00:00.000Z`,
  }));
}

export function humanRows(count: number) {
  return Array.from({ length: count }, () => ({
    role: "human",
    timestamp: `${DAY}T${HUMAN_HOUR}:00:00.000Z`,
  }));
}

export async function readHeatmapTotals(
  organizationId: string,
  userId: string
) {
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

export async function seedScope() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const computeTargetId = await createComputeTarget(organizationId, user.id);
  return { organizationId, projectId, userId: user.id, computeTargetId };
}
