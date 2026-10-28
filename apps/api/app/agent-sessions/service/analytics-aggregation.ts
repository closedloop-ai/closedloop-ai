import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  AGENT_FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import type { SyncedAgentSessionAgent } from "@repo/api/src/types/agent-session";
import type {
  AgentSessionAgentRosterIncompleteness,
  AgentSessionAgentTypeBreakdown,
  AgentSessionProjectBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
} from "@repo/api/src/types/agent-session-usage-breakdown";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import {
  type JsonArrayIncompleteness,
  mergeJsonArrayIncompleteness,
} from "./coercion";
import type {
  AnalyticsProjectSummaryRecord,
  AnalyticsSessionRecord,
} from "./records";
import { toSyncedAgentRoster, toUnreadableAgents } from "./synced-payload";
import { buildUsageByRepository } from "./usage-facet-projections";

export function aggregateFullArtifactSessionUsageByModel(input: {
  organizationId: string;
  sessionArtifactIds: string[];
}) {
  return withDb((db) =>
    Promise.all([
      db.sessionDetail.aggregate({
        where: {
          artifactId: { in: input.sessionArtifactIds },
          artifact: { organizationId: input.organizationId },
        },
        _count: { _all: true },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
        },
      }),
      db.agentSessionTokenUsage.groupBy({
        by: ["model"],
        where: {
          agentSessionId: { in: input.sessionArtifactIds },
          session: { artifact: { organizationId: input.organizationId } },
        },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
        },
      }),
    ])
  );
}

/**
 * ISS-6912: fold the org-wide Tool Usage breakdown straight off the persisted
 * `agent_session_events` ROWS.
 *
 * There is deliberately no runtime schema between the read and this fold. Before
 * `20260526000000_normalize_agent_session_events` these events were a JSON blob
 * on `agent_sessions`, so the read safe-parsed them with the DESKTOP WIRE schema
 * (`syncedAgentSessionEventSchema`) and fell back to `[]`. That migration dropped
 * the column and made `events` a relation with typed, NOT NULL columns — but the
 * fold kept the wire parse, and the two shapes do not agree: the wire schema
 * requires `createdAt` to be an ISO **string**, while the row carries a
 * `DateTime`. Every row therefore failed, the all-or-nothing `z.array(...)`
 * fallback returned `[]` for EVERY session, and this breakdown served a
 * confident empty table to every organization for three months.
 *
 * A relation row is not a parse boundary: Postgres, not a validator, is what
 * guarantees `eventType` is a non-null string and `toolName` is a nullable one,
 * and the two fields below are the only ones this fold reads. Iterating
 * `session.events` under its Prisma-derived type is what keeps the read and the
 * schema from drifting apart again — a column change now fails `tsc` here
 * instead of silently emptying the population, which is precisely the failure a
 * `value: unknown` parameter absorbed.
 */
export function aggregateByTool(
  sessions: AnalyticsSessionRecord[]
): AgentSessionToolBreakdown[] {
  const map = new Map<
    string,
    { invocationCount: number; errorCount: number; sessionIds: Set<string> }
  >();

  for (const session of sessions) {
    for (const event of session.events) {
      if (!event.toolName) {
        continue;
      }
      const existing = map.get(event.toolName);
      const isError = ERROR_EVENT_PATTERN.test(event.eventType);
      if (existing) {
        existing.invocationCount += 1;
        if (isError) {
          existing.errorCount += 1;
        }
        existing.sessionIds.add(session.artifactId);
      } else {
        map.set(event.toolName, {
          invocationCount: 1,
          errorCount: isError ? 1 : 0,
          sessionIds: new Set([session.artifactId]),
        });
      }
    }
  }

  return [...map.entries()]
    .map(([toolName, data]) => ({
      toolName,
      invocationCount: data.invocationCount,
      errorCount: data.errorCount,
      sessionCount: data.sessionIds.size,
    }))
    .sort((left, right) => right.invocationCount - left.invocationCount);
}

type AgentTypeAccumulator = {
  count: number;
  successCount: number;
  failedCount: number;
  durations: number[];
};

function accumulateAgentType(
  map: Map<string, AgentTypeAccumulator>,
  agent: SyncedAgentSessionAgent
): void {
  const key = agent.subagentType ?? agent.type ?? "unknown";
  const isSuccess = AGENT_SUCCESS_STATUS_PATTERN.test(agent.status);
  const isFailed = AGENT_FAILED_STATUS_PATTERN.test(agent.status);
  const duration = computeAgentDuration(agent.startedAt, agent.endedAt);

  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.successCount += isSuccess ? 1 : 0;
    existing.failedCount += isFailed ? 1 : 0;
    if (duration !== null) {
      existing.durations.push(duration);
    }
  } else {
    map.set(key, {
      count: 1,
      successCount: isSuccess ? 1 : 0,
      failedCount: isFailed ? 1 : 0,
      durations: duration === null ? [] : [duration],
    });
  }
}

/**
 * ISS-6890: keep every roster member this build CAN read. Dropping a whole
 * session's roster on one bad member used to understate every agent-type bucket
 * that session contributed to.
 *
 * The incompleteness signal is CARRIED, not discarded (#5209 review). This
 * aggregate walks an org-wide population the detail read never visits, so it is
 * the only place that knows the fold came up short, and `count` is then a lower
 * bound rather than the exact population. ISS-10733 deleted the table that
 * summed those counts, so nothing reads the signal today; it is kept because it
 * is additive and optional ({@link AgentSessionAgentRosterIncompleteness}) and
 * this producer still emits it.
 *
 * It is returned SPREAD-SHAPED (`{}` for a whole population) for the same reason
 * `toRosterIntegrity` is: `agentRosterIncomplete` must stay genuinely OMITTED on
 * the served object rather than serialized as a present falsy value, because
 * absence is the contract's only encoding of "complete".
 *
 * Still no per-row emission: `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * forbids that amplification vector, and this is one tally over the whole fold,
 * returned in the response rather than logged.
 */
export function aggregateByAgentType(sessions: AnalyticsSessionRecord[]): {
  byAgentType: AgentSessionAgentTypeBreakdown[];
  integrity: { agentRosterIncomplete?: AgentSessionAgentRosterIncompleteness };
} {
  const map = new Map<string, AgentTypeAccumulator>();
  let affectedSessions = 0;
  let incomplete: JsonArrayIncompleteness | undefined;

  for (const session of sessions) {
    const roster = toSyncedAgentRoster(session.agents);
    for (const agent of roster.agents) {
      accumulateAgentType(map, agent);
    }
    if (roster.incomplete === undefined) {
      continue;
    }
    affectedSessions += 1;
    // One unreadable blob makes the org-wide total unknowable, and it stays
    // unknowable however many readable-but-partial sessions follow — the
    // `unreadable_value` reason absorbs, never resets (ISS-7062 moved that fold
    // onto the canonical helper). `affectedSessions` keeps counting either way,
    // so the response always says HOW MANY sessions were short even when it
    // cannot say by how much.
    incomplete = mergeJsonArrayIncompleteness(incomplete, roster.incomplete);
  }

  const byAgentType = [...map.entries()]
    .map(([agentType, data]) => ({
      agentType,
      count: data.count,
      successCount: data.successCount,
      failedCount: data.failedCount,
      avgDurationMs:
        data.durations.length > 0
          ? Math.round(
              data.durations.reduce((sum, d) => sum + d, 0) /
                data.durations.length
            )
          : null,
    }))
    .sort((left, right) => right.count - left.count);

  return {
    byAgentType,
    integrity:
      incomplete === undefined
        ? {}
        : {
            agentRosterIncomplete: {
              unreadableAgents: toUnreadableAgents(incomplete),
              affectedSessions,
            },
          },
  };
}

/**
 * ISS-9113: the group key arrives as a map keyed by artifact id rather than as a
 * `project` relation nested on each session row, because the sessions are now
 * read in ONE pass that carries no artifact join (`analytics-read.ts`).
 *
 * `sessions` is the FULL analytics population, not the project-parented subset
 * this used to be handed; an unparented session is absent from `projectsBy
 * ArtifactId` and is skipped by the same `continue` that always dropped it.
 * Both reads order by `artifactId` asc, so the parented rows arrive in the same
 * relative order as before and the `Map` insertion order — which is what breaks
 * ties in the `sessionCount` sort below — is unchanged.
 */
export function aggregateByProject(
  sessions: AnalyticsSessionRecord[],
  projectsByArtifactId: Map<string, AnalyticsProjectSummaryRecord>
): AgentSessionProjectBreakdown[] {
  const map = new Map<
    string,
    {
      projectName: string;
      projectSlug: string | null;
      sessionCount: number;
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    }
  >();

  for (const session of sessions) {
    const project = projectsByArtifactId.get(session.artifactId);
    if (!project) {
      continue;
    }
    const existing = map.get(project.id);
    const cost = toNumber(session.estimatedCost);
    if (existing) {
      existing.sessionCount += 1;
      existing.inputTokens += toNumber(session.inputTokens);
      existing.outputTokens += toNumber(session.outputTokens);
      existing.estimatedCost += cost;
    } else {
      map.set(project.id, {
        projectName: project.name,
        projectSlug: project.slug,
        sessionCount: 1,
        inputTokens: toNumber(session.inputTokens),
        outputTokens: toNumber(session.outputTokens),
        estimatedCost: cost,
      });
    }
  }

  return [...map.entries()]
    .map(([projectId, data]) => ({
      projectId,
      ...data,
    }))
    .sort((left, right) => right.sessionCount - left.sessionCount);
}

/**
 * ISS-6823 — the analytics Repository breakdown, as ONE bounded aggregate.
 *
 * It used to be a Node reduction over the whole filtered session population:
 * `/agent-sessions/analytics` paged EVERY matching session into memory and
 * folded `repositoryFullName` in a `Map`. Nothing about that fold needed a
 * session row — it is a `GROUP BY repository_full_name` with four `SUM`s — so
 * Postgres does it now and returns one row per repository.
 *
 * Exactness, clause by clause against the reduction it replaces:
 *
 *  - **NULL — and EMPTY — repository.** The reduction `continue`d on a FALSY
 *    `repositoryFullName`; `GROUP BY` instead emits one group per distinct value,
 *    including a `null` group and an `""` group. `buildUsageByRepository` drops
 *    only the `null` one, so the falsy drop is reproduced HERE, before shaping.
 *    An empty name is reachable: `resolveRepositoryFromBranchRefs`
 *    (`persist-session-children.ts`) writes `normalizeRepoFullName(...)`, which
 *    strips a trailing `.git` and then trailing slashes with no non-empty guard,
 *    so a branch ref naming the repository `.git` persists `""`. Without this
 *    drop the breakdown would grow a NAMELESS row carrying real counts, in one of
 *    the 15 slots the table renders, filterable to nothing — the exact affordance
 *    `buildUsageByRepository`'s own doc says the null drop exists to prevent.
 *    Falsy, not `.trim()`: a whitespace-only name is TRUTHY and the reduction kept
 *    it, so trimming here would drop a group the old fold reported. The usage
 *    summary's own handling of `""` is untouched — a different surface's option
 *    list is not this ticket's to change.
 *  - **Empty population.** No rows ⇒ no groups ⇒ `[]`, the same empty array the
 *    reduction produced from an empty `Map`. No group is invented at zero.
 *  - **No join fan-out.** `SessionDetail` is the grouped table itself and every
 *    summed column lives on it, so there is no join to multiply a row.
 *  - **Ordering.** Both sort by `sessionCount` desc. TIES previously fell out in
 *    `artifactId` scan order (arbitrary, and unstable across reads once paging
 *    changed). ISS-10851 moved the tie decision INTO `buildUsageByRepository`,
 *    which now compares `repositoryFullName` itself, so this read no longer
 *    depends on a query-level `orderBy` for it — and the answer is the JS
 *    `localeCompare` order, not the Postgres collation an `ORDER BY` would have
 *    given, which disagree on case and punctuation.
 *  - **`estimatedCost`.** Summed by Postgres as `NUMERIC` rather than accumulated
 *    as a JS float, so a repository's total can differ in the final ulp — and now
 *    matches the usage summary's `byRepository`, which has always been this
 *    aggregate, for the same population.
 *
 * The shaping is deliberately the SAME `buildUsageByRepository` the usage
 * summary uses: both surfaces emit `AgentSessionRepositoryBreakdown`, and two
 * hand-written folds of one dimension is how the two ended up able to disagree.
 */
export async function fetchAnalyticsRepositoryBreakdown(
  where: Prisma.SessionDetailWhereInput
): Promise<AgentSessionRepositoryBreakdown[]> {
  const groups = await withDb((db) =>
    db.sessionDetail.groupBy({
      by: ["repositoryFullName"],
      where,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        estimatedCost: true,
        errorCount: true,
      },
    })
  );
  return buildUsageByRepository(
    groups.filter((group) => Boolean(group.repositoryFullName))
  );
}

function computeAgentDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const duration = end - start;
  return duration >= 0 ? duration : null;
}
