/**
 * ISS-7513 — corpus seeding and inspection for the insights section profiler.
 *
 * Split out of `perf-insights-sections.ts`, which owns MEASUREMENT: building a
 * deterministic corpus and describing an existing one is a separate
 * responsibility, and keeping both in one file pushed it past the ~500-line
 * smell in AGENTS.md.
 *
 * Nothing here is production code — it writes rows directly rather than through
 * the ingest fold, because the profile measures READ paths and the fold's own
 * cost would dominate seeding without changing what is read back. The caller
 * enforces the local-`closedloop_perf`-only guard before any of this runs.
 */

import { randomUUID } from "node:crypto";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";

const MS_PER_DAY = 86_400_000;
const EVENT_TYPES = [
  "tool_use",
  "assistant_message",
  "user_message",
  "tool_result",
];
const TOOL_NAMES = ["Read", "Edit", "Bash", "Grep", "Write"];
const MODELS = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"];
/** Per-model cost every seeded session's `agent_session_token_usage` rows carry. */
const PER_MODEL_ESTIMATED_COST = 0.25;
/**
 * ISS-8515: named explicitly on the session row, because `estimated_cost` lost
 * its `DEFAULT 0` in that change and an omission here would seed NULL — an
 * "unpriced" session that nonetheless carries one priced per-model row per
 * model. Derived from those rows rather than written as a literal so the two
 * cannot drift apart when MODELS or the per-model cost changes.
 */
const SESSION_ESTIMATED_COST = MODELS.length * PER_MODEL_ESTIMATED_COST;
const SUBAGENT_TYPES = ["planner", "reviewer", "builder", "explorer"];
const INSERT_CHUNK = 2000;
const SEEDED_ORG_PREFIX = "insights-perf";

export type SeedArgs = {
  sessions: number;
  eventsPerSession: number;
  historyDays: number;
};

export async function describePopulation(
  organizationId: string
): Promise<string> {
  return await withDb(async (db) => {
    const [sessions, events, tokenUsage, tokenEvents] = await Promise.all([
      db.sessionDetail.count({ where: { artifact: { organizationId } } }),
      db.agentSessionEvent.count({
        where: { session: { artifact: { organizationId } } },
      }),
      db.agentSessionTokenUsage.count({
        where: { session: { artifact: { organizationId } } },
      }),
      db.agentSessionTokenEvent.count({
        where: { session: { artifact: { organizationId } } },
      }),
    ]);
    return [
      `- organization: \`${organizationId}\``,
      `- sessions: ${sessions}`,
      `- agent_session_events: ${events}`,
      `- agent_session_token_usage: ${tokenUsage}`,
      `- agent_session_token_events: ${tokenEvents}`,
    ].join("\n");
  });
}

/** The org the last `--seed` built, identified by the marker name it carries. */
export async function resolveSeededOrganization(): Promise<string | null> {
  return await withDb(async (db) => {
    const org = await db.organization.findFirst({
      where: { name: { startsWith: SEEDED_ORG_PREFIX } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return org?.id ?? null;
  });
}

/**
 * A deterministic corpus spread over the profiled window. Rows go in through
 * `createMany` rather than the ingest fold: this measures READ paths, and the
 * fold's own cost would dominate seeding without changing what is read back.
 */
export async function seedCorpus(args: SeedArgs): Promise<string> {
  const organizationId = await withDb(async (db) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const org = await db.organization.create({
      data: {
        clerkId: `org_insights_perf_${suffix}`,
        name: `${SEEDED_ORG_PREFIX} ${suffix}`,
        slug: `insights-perf-${suffix}`,
      },
      select: { id: true },
    });
    return org.id;
  });

  const userIds = await withDb(async (db) => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const user = await db.user.create({
        data: {
          organizationId,
          clerkId: `clerk_insights_perf_${suffix}`,
          email: `perf-${i}-${suffix}@example.com`,
          firstName: "Perf",
          lastName: `User${i}`,
        },
        select: { id: true },
      });
      ids.push(user.id);
    }
    return ids;
  });

  const computeTargetId = await withDb(async (db) => {
    const target = await db.computeTarget.create({
      data: {
        organizationId,
        userId: userIds[0],
        machineName: "perf-machine",
        platform: "darwin",
      },
      select: { id: true },
    });
    return target.id;
  });

  const now = Date.now();
  const artifactRows: { id: string; startedAt: Date; userId: string }[] = [];
  for (let i = 0; i < args.sessions; i++) {
    artifactRows.push({
      id: randomUUID(),
      // Spread across the HISTORY, deterministically. The stride is a prime in
      // DAYS — an earlier revision strode in milliseconds, which put every
      // session within a few hours of now, silently made the 90-day window
      // 100%-selective, and so measured a planner correctly preferring a
      // sequential scan while appearing to measure a windowed read.
      startedAt: new Date(
        now -
          ((i * 7919) % args.historyDays) * MS_PER_DAY -
          ((i * 97) % 86_400) * 1000
      ),
      userId: userIds[i % userIds.length],
    });
  }

  await chunked(artifactRows, (chunk) =>
    withDb((db) =>
      db.artifact.createMany({
        data: chunk.map((row) => ({
          id: row.id,
          organizationId,
          type: ArtifactType.SESSION,
          name: `perf-session-${row.id}`,
          status: SESSION_STATUS.INACTIVE,
          createdById: row.userId,
        })),
      })
    )
  );

  await chunked(artifactRows, (chunk) =>
    withDb((db) =>
      db.sessionDetail.createMany({
        data: chunk.map((row, index) => ({
          artifactId: row.id,
          computeTargetId,
          externalSessionId: `perf-ext-${row.id}`,
          harness: "claude",
          sessionStartedAt: row.startedAt,
          sessionUpdatedAt: row.startedAt,
          lastActivityAt: row.startedAt,
          estimatedCost: SESSION_ESTIMATED_COST,
          agents: buildAgents(index),
        })),
      })
    )
  );

  const eventRows = artifactRows.flatMap((row) =>
    Array.from({ length: args.eventsPerSession }, (_unused, n) => ({
      agentSessionId: row.id,
      externalEventId: `${row.id}-${n}`,
      eventType: EVENT_TYPES[n % EVENT_TYPES.length],
      toolName: n % 2 === 0 ? TOOL_NAMES[n % TOOL_NAMES.length] : null,
      eventCreatedAt: new Date(row.startedAt.getTime() + n * 1000),
    }))
  );
  await chunked(eventRows, (chunk) =>
    withDb((db) => db.agentSessionEvent.createMany({ data: chunk }))
  );

  const usageRows = artifactRows.flatMap((row) =>
    MODELS.map((model) => ({
      agentSessionId: row.id,
      model,
      inputTokens: BigInt(1000),
      outputTokens: BigInt(500),
      cacheReadTokens: BigInt(200),
      cacheWriteTokens: BigInt(100),
      estimatedCost: PER_MODEL_ESTIMATED_COST,
    }))
  );
  await chunked(usageRows, (chunk) =>
    withDb((db) => db.agentSessionTokenUsage.createMany({ data: chunk }))
  );

  const tokenEventRows = artifactRows.flatMap((row) =>
    Array.from({ length: 10 }, (_unused, n) => ({
      agentSessionId: row.id,
      externalEventId: `${row.id}-tok-${n}`,
      model: MODELS[n % MODELS.length],
      inputTokens: BigInt(100),
      outputTokens: BigInt(50),
      estimatedCost: 0.01,
      eventCreatedAt: new Date(row.startedAt.getTime() + n * 60_000),
    }))
  );
  await chunked(tokenEventRows, (chunk) =>
    withDb((db) => db.agentSessionTokenEvent.createMany({ data: chunk }))
  );

  // Without this the first profile after a seed measures a planner working from
  // stale statistics while autovacuum is still catching up, which reads as a
  // slow QUERY rather than as a cold corpus. Measured on this harness: the
  // agent-pipeline read came out at 100ms immediately after seeding and 12ms on
  // the same rows once statistics had settled — an 8x error in the number the
  // whole ticket is about.
  await withDb((db) => db.$executeRawUnsafe("ANALYZE"));

  return organizationId;
}

/** One `agents` JSON element, limited to the fields the pipeline SQL reads. */
type SeedAgent = {
  externalAgentId: string;
  parentExternalAgentId?: string;
  subagentType: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
};

/** Agents JSON shaped like the desktop sync writes it, with parent hand-offs. */
function buildAgents(index: number): SeedAgent[] {
  const parentId = `agent-${index}-root`;
  return [
    {
      externalAgentId: parentId,
      subagentType: SUBAGENT_TYPES[index % SUBAGENT_TYPES.length],
      status: "completed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    },
    ...Array.from({ length: 3 }, (_unused, n) => ({
      externalAgentId: `agent-${index}-child-${n}`,
      parentExternalAgentId: parentId,
      subagentType: SUBAGENT_TYPES[(index + n + 1) % SUBAGENT_TYPES.length],
      status: n === 0 ? "failed" : "completed",
    })),
  ];
}

async function chunked<T>(
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await write(rows.slice(i, i + INSERT_CHUNK));
  }
}
