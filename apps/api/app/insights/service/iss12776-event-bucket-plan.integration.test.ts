import { randomUUID } from "node:crypto";
import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { requireScanNode } from "@repo/database/__tests__/test-helpers/explain-plan";
import { purgeFixtureOrganizations } from "@repo/database/__tests__/test-helpers/planner-fixture";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  explainCapturedStatement,
  explainWithoutIndex,
} from "@/__tests__/support/captured-statement-plan.test-helpers";
import {
  matching,
  type ObservedStatement,
  observeStatements,
} from "@/__tests__/support/db-statement-observer";
import {
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { withFixtureRawClient } from "@/__tests__/utils/fixture-db";
import {
  fetchEventTypeBuckets,
  fetchToolUsageBuckets,
} from "@/app/insights/service/event-queries";
import type { InsightsScopeContext } from "@/app/insights/service/scope";

/**
 * ISS-12776 — the by-type (/insights/utilization) and by-tool (/insights/agents)
 * bucket reads must scan `agent_session_events` index-only.
 *
 * Both group on a column the `(agent_session_id, event_created_at)` index does
 * not carry, so without the covering index every matched event is a heap visit.
 * On production that was 724k buffers and 38.7 s for the largest org's 90-day
 * by-type read. Results are identical either way, so no value test can see the
 * difference; only the plan can.
 *
 * The statements are captured from the real reads with Prisma's bound values,
 * not transcribed. The counterfactual drops the covering index in a rolled-back
 * transaction and re-plans the same statements.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const EVENTS_TABLE = "agent_session_events";
const COVERING_INDEX = "agent_session_events_session_time_cover_idx";
const INDEX_ONLY_SCAN = "Index Only Scan";
const EVENTS_TABLE_PATTERN = /agent_session_events/;
const PLAN_DESCRIPTION = "insights event bucket read";
const FIXTURE_CLERK_PREFIX = "org_iss12776_plan_";

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const SESSIONS = 40;
const EVENTS_PER_SESSION = 50;
const EVENT_TYPES = ["tool_use", "assistant_message", "user_message"];
const TOOL_NAMES = ["Read", "Edit", null];

describeIfDb("insights event bucket plans (ISS-12776)", () => {
  let statements: ObservedStatement[];

  beforeAll(async () => {
    await purge();
    const ctx = await seed();
    // VACUUM sets the visibility map, which is what lets the planner cost an
    // index-only scan below a heap scan. Owner-only, so it runs on the fixture
    // connection (ISS-5978).
    await withFixtureRawClient("the ISS-12776 fixture VACUUM", (client) =>
      client.$executeRawUnsafe(
        `VACUUM (ANALYZE) ${EVENTS_TABLE}, session_detail, artifacts`
      )
    );
    statements = await captureBucketStatements(ctx);
  });

  afterAll(async () => {
    await purge();
  });

  it("captures one non-empty statement from each bucket read", () => {
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.rows).toBeGreaterThan(0);
    }
  });

  it("scans the events table index-only", async () => {
    for (const [index, statement] of statements.entries()) {
      const plan = await explainCapturedStatement(statement, PLAN_DESCRIPTION);
      expect(
        requireScanNode(plan, EVENTS_TABLE),
        `statement ${index}`
      ).toContain(INDEX_ONLY_SCAN);
    }
  });

  it("falls back to heap visits without the covering index", async () => {
    const plans = await explainWithoutIndex(
      statements,
      COVERING_INDEX,
      PLAN_DESCRIPTION
    );

    expect(plans).toHaveLength(statements.length);
    for (const [index, plan] of plans.entries()) {
      expect(
        requireScanNode(plan, EVENTS_TABLE),
        `statement ${index}`
      ).not.toContain(INDEX_ONLY_SCAN);
    }
  });
});

async function captureBucketStatements(
  ctx: InsightsScopeContext
): Promise<ObservedStatement[]> {
  const byType = await observeStatements(() =>
    fetchEventTypeBuckets(ctx, WINDOW_START, WINDOW_END)
  );
  const byTool = await observeStatements(() =>
    fetchToolUsageBuckets(ctx, WINDOW_START, WINDOW_END)
  );
  return [
    ...matching(byType.statements, EVENTS_TABLE_PATTERN),
    ...matching(byTool.statements, EVENTS_TABLE_PATTERN),
  ];
}

async function seed(): Promise<InsightsScopeContext> {
  const organizationId = await createTestOrganization({
    clerkId: `${FIXTURE_CLERK_PREFIX}${randomUUID()}`,
  });
  const user = await createTestUser(organizationId);
  const sessionIds = Array.from({ length: SESSIONS }, () => randomUUID());

  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `iss12776-plan-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.artifact.createMany({
      data: sessionIds.map((id, s) => ({
        id,
        organizationId,
        type: ArtifactType.SESSION,
        name: `iss12776-plan-session-${s}`,
        status: SESSION_STATUS.INACTIVE,
      })),
    });
    await db.sessionDetail.createMany({
      data: sessionIds.map((artifactId) => ({
        artifactId,
        computeTargetId: computeTarget.id,
        externalSessionId: `iss12776-plan-${artifactId}`,
        harness: "claude",
        sessionStartedAt: WINDOW_START,
        sessionUpdatedAt: WINDOW_START,
        lastActivityAt: WINDOW_END,
      })),
    });
    await db.agentSessionEvent.createMany({
      data: sessionIds.flatMap((agentSessionId) =>
        Array.from({ length: EVENTS_PER_SESSION }, (_unused, n) => ({
          agentSessionId,
          externalEventId: `${agentSessionId}-${n}`,
          eventType: EVENT_TYPES[n % EVENT_TYPES.length],
          toolName: TOOL_NAMES[n % TOOL_NAMES.length],
          eventCreatedAt: new Date(WINDOW_START.getTime() + n * 3_600_000),
        }))
      ),
    });
  });

  return { organizationId, userId: user.id, scope: InsightsScope.Org };
}

function purge(): Promise<void> {
  const selector = "SELECT id FROM organizations WHERE clerk_id LIKE $1 || '%'";
  const scope = `(${selector})`;
  return withFixtureRawClient("the ISS-12776 fixture purge", (client) =>
    purgeFixtureOrganizations(client, {
      selector,
      leafDeletes: [
        `DELETE FROM session_detail WHERE artifact_id IN (
           SELECT id FROM artifacts WHERE organization_id IN ${scope})`,
        `DELETE FROM artifacts WHERE organization_id IN ${scope}`,
        `DELETE FROM compute_targets WHERE organization_id IN ${scope}`,
        `DELETE FROM users WHERE organization_id IN ${scope}`,
      ],
      values: [FIXTURE_CLERK_PREFIX],
      label: `${FIXTURE_CLERK_PREFIX} fixture sweep failed`,
    })
  );
}
