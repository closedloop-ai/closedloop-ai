import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { fetchAgentPipelineGraph } from "@/app/insights/agent-pipeline";
import { sessionScopeSql } from "@/app/insights/service/scope";

/**
 * ISS-7511 — the agent-pipeline graph SQL, asserted against ROWS a real
 * Postgres returned rather than against generated query text. The unit suite in
 * `service.test.ts` drives this through a fake `$queryRaw` that hands back
 * finished node/edge rows as soon as it recognizes the CTE name, so it can only
 * prove the wiring (one round-trip, org-scoped, one unnest) and the JS mapping
 * on top — never the aggregation itself. Every clause the statement relies on
 * to build a correct graph is therefore only covered here.
 *
 * The fixture is built so each clause has a row that FAILS if the clause is
 * dropped, not merely one that passes while it holds:
 *
 *   - `p.session_id = c.session_id` on the edge self-join — session A and
 *     session B both contain an agent whose `externalAgentId` is "shared-1",
 *     with DIFFERENT subagent types. Drop the session equality and each child
 *     matches the parent in the other session too, inflating both edge weights.
 *   - `COUNT(DISTINCT session_id)` for a node's `sessions` — "reviewer" runs
 *     three times across two sessions, so `sessions` (2) and `total` (3) differ.
 *     A plain `COUNT(session_id)` reports 3.
 *   - the `session_started_at >= start` / `<= end` window — one session sits
 *     before the window and one after, each contributing a subagent type that
 *     appears nowhere else. Losing either bound admits a node the assertions
 *     enumerate against.
 *   - the org scope predicate — a second organization runs a type that appears
 *     nowhere else, so a leak shows up as an extra node.
 *
 * Runs inside `autoRollbackTransaction`; nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T23:59:59.000Z");
const IN_WINDOW = new Date("2026-06-15T00:00:00.000Z");
const BEFORE_WINDOW = new Date("2026-05-15T00:00:00.000Z");
const AFTER_WINDOW = new Date("2026-07-15T00:00:00.000Z");

/**
 * One `agents` JSON element as the desktop sync writes it. Only the fields the
 * pipeline SQL reads are modelled.
 */
type SeedAgent = {
  externalAgentId: string;
  parentExternalAgentId?: string;
  subagentType?: string;
  type?: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
};

describeIfDb("fetchAgentPipelineGraph", () => {
  it("aggregates one node per subagent type over the scoped window", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId } = await seedPipelineFixture();

      const graph = await fetchAgentPipelineGraph(
        orgScopeSql(organizationId),
        WINDOW_START,
        WINDOW_END
      );

      // Enumerated and ordered, not sampled: an extra node is how a lost window
      // bound or a lost org predicate shows itself, and the order pins the
      // statement's `total DESC, subagent_type ASC` tiebreak — planner and
      // reviewer both ran three times.
      expect(graph.nodes.map((node) => node.subagentType)).toEqual([
        "planner",
        "reviewer",
        "builder",
      ]);
    });
  });

  it("counts a type's runs, outcomes, distinct sessions, and mean duration", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId } = await seedPipelineFixture();

      const graph = await fetchAgentPipelineGraph(
        orgScopeSql(organizationId),
        WINDOW_START,
        WINDOW_END
      );

      // "reviewer" ran three times across TWO sessions, so `sessions` and
      // `total` disagree — the only shape in which a non-distinct count is
      // visible. Two of the three succeeded and one failed, matched through the
      // shared success/failure term sets.
      expect(
        graph.nodes.find((node) => node.subagentType === "reviewer")
      ).toEqual({
        subagentType: "reviewer",
        total: 3,
        completed: 2,
        errors: 1,
        sessions: 2,
        successRate: (2 / 3) * 100,
        avgDuration: null,
        trend: [],
      });
      // The planner pair spans 10s and 30s; the mean is over the two elements
      // that carry BOTH timestamps, not over all three of its runs.
      expect(
        graph.nodes.find((node) => node.subagentType === "planner")?.avgDuration
      ).toBe(20);
    });
  });

  it("joins a child to its parent only within the same session", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId } = await seedPipelineFixture();

      const graph = await fetchAgentPipelineGraph(
        orgScopeSql(organizationId),
        WINDOW_START,
        WINDOW_END
      );

      // Both sessions hold an agent id of "shared-1" under different types, so
      // a cross-session match would raise BOTH weights and give planner→reviewer
      // the builder's child as well.
      expect(graph.edges).toEqual([
        { source: "planner", target: "reviewer", weight: 2 },
        { source: "builder", target: "reviewer", weight: 1 },
      ]);
    });
  });

  it("excludes sessions outside the window and outside the scope", async () => {
    await autoRollbackTransaction(async () => {
      const { organizationId } = await seedPipelineFixture();

      const graph = await fetchAgentPipelineGraph(
        orgScopeSql(organizationId),
        WINDOW_START,
        WINDOW_END
      );

      const types = graph.nodes.map((node) => node.subagentType);
      // Each of these types exists in exactly one excluded session, so it names
      // which predicate failed rather than just reporting a wrong count.
      expect(types).not.toContain("archivist");
      expect(types).not.toContain("futurist");
      expect(types).not.toContain("intruder");
    });
  });
});

function orgScopeSql(organizationId: string): Prisma.Sql {
  return sessionScopeSql({
    organizationId,
    userId: organizationId,
    scope: InsightsScope.Org,
  });
}

/**
 * The whole fixture, seeded once per case. Returns the org the assertions scope
 * to; the second organization is deliberately not returned, so no case can
 * accidentally read it back.
 */
async function seedPipelineFixture(): Promise<{ organizationId: string }> {
  const organizationId = await createTestOrganization();
  const otherOrganizationId = await createTestOrganization();

  await seedSession(organizationId, "a", IN_WINDOW, [
    {
      externalAgentId: "shared-1",
      subagentType: "planner",
      status: "completed",
      startedAt: "2026-06-15T00:00:00.000Z",
      endedAt: "2026-06-15T00:00:10.000Z",
    },
    {
      externalAgentId: "a-child-1",
      parentExternalAgentId: "shared-1",
      subagentType: "reviewer",
      status: "completed",
    },
    {
      externalAgentId: "a-child-2",
      parentExternalAgentId: "shared-1",
      subagentType: "reviewer",
      status: "failed",
    },
    // Same type as the parent above but no timestamps, so the duration mean is
    // over the timestamped elements rather than over every run of the type.
    { externalAgentId: "a-solo", subagentType: "planner", status: "completed" },
  ]);

  await seedSession(organizationId, "b", IN_WINDOW, [
    {
      externalAgentId: "shared-1",
      subagentType: "builder",
      status: "completed",
    },
    {
      externalAgentId: "b-child-1",
      parentExternalAgentId: "shared-1",
      subagentType: "reviewer",
      status: "completed",
    },
    {
      externalAgentId: "b-planner",
      subagentType: "planner",
      status: "completed",
      startedAt: "2026-06-15T00:00:00.000Z",
      endedAt: "2026-06-15T00:00:30.000Z",
    },
  ]);

  await seedSession(organizationId, "before", BEFORE_WINDOW, [
    { externalAgentId: "c-1", subagentType: "archivist", status: "completed" },
  ]);
  await seedSession(organizationId, "after", AFTER_WINDOW, [
    { externalAgentId: "d-1", subagentType: "futurist", status: "completed" },
  ]);
  await seedSession(otherOrganizationId, "other", IN_WINDOW, [
    { externalAgentId: "e-1", subagentType: "intruder", status: "completed" },
  ]);

  return { organizationId };
}

async function seedSession(
  organizationId: string,
  label: string,
  startedAt: Date,
  agents: SeedAgent[]
): Promise<void> {
  const user = await createTestUser(organizationId);
  await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `pipeline-session-${label}`,
        status: SESSION_STATUS.INACTIVE,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `pipeline-machine-${label}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `pipeline-ext-${label}`,
        harness: "claude",
        sessionStartedAt: startedAt,
        sessionUpdatedAt: startedAt,
        lastActivityAt: startedAt,
        agents,
      },
      select: { artifactId: true },
    });
  });
}
