import { SESSION_TOKEN_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-token-event-limits";
import { type AgentSessionUsageRollup, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";

/**
 * FEA-2730 (G1): read view for one raw per-event token row. Token counts and
 * cost are narrowed from BigInt/Decimal to JS numbers within the 2^53 envelope.
 * A missing cost remains null so readers never confuse unknown with real zero.
 */
export type AgentSessionTokenEventView = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
  eventCreatedAt: Date;
};

/** FEA-2730 (G10): read view for the per-session usage rollup. */
export type AgentSessionUsageRollupView = {
  startedAt: Date | null;
  startedDay: string | null;
  status: string | null;
  harness: string | null;
  isHuman: boolean;
  humanTurns: number;
  agentTurns: number;
  eventCount: number;
  toolInvocations: number;
  errorEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  runtimeMs: number | null;
  rollupUpdatedAt: Date | null;
};

/**
 * ISS-9857: what {@link readSessionTokenEvents} answers. `truncated` is
 * present (and `true`) only when the store held a row past
 * `SESSION_TOKEN_EVENT_MAX_ROWS`; ABSENCE is the only encoding of "complete",
 * so one truthy check catches every capped read and a serialized `false` can
 * never be mistaken for a measured whole.
 */
export type AgentSessionTokenEventsRead = {
  events: AgentSessionTokenEventView[];
  truncated?: true;
};

/**
 * FEA-2730 (G1): raw per-event token rows for one session, ordered by event
 * time and optionally bounded to a date window (the Dashboard/Branches focus
 * pages read bounded 7/30/90-day windows — PRD-510 assumption 2). Org-scoped
 * through the session→artifact join (D4: join-reached — the table has no
 * organizationId), so a caller only ever reads events for sessions its org
 * owns; a foreign session id yields an empty result.
 *
 * Bounded at the shared `SESSION_TOKEN_EVENT_MAX_ROWS` owner
 * (`@repo/api/src/types/agent-session-token-event-limits`), a safety limit
 * rather than a functional page size: the focus pages read date windows well
 * under it. The query reads ONE row past the cap so the probe row, not a
 * count, decides `truncated`; the served set is the chronological prefix.
 * ISS-9857 scoped this read to a truncation SIGNAL — there is still no cursor
 * here, so a consumer that needs the rows past the cap has none to follow.
 */
export async function readSessionTokenEvents(input: {
  organizationId: string;
  sessionArtifactId: string;
  start?: Date;
  end?: Date;
}): Promise<AgentSessionTokenEventsRead> {
  const rows = await withDb((db) =>
    db.agentSessionTokenEvent.findMany({
      where: {
        agentSessionId: input.sessionArtifactId,
        session: { artifact: { organizationId: input.organizationId } },
        ...(input.start || input.end
          ? {
              eventCreatedAt: {
                ...(input.start ? { gte: input.start } : {}),
                ...(input.end ? { lte: input.end } : {}),
              },
            }
          : {}),
      },
      orderBy: { eventCreatedAt: "asc" },
      take: SESSION_TOKEN_EVENT_MAX_ROWS + 1,
      select: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        estimatedCost: true,
        eventCreatedAt: true,
      },
    })
  );
  const truncated = rows.length > SESSION_TOKEN_EVENT_MAX_ROWS;
  // The probe row is the only row past the cap, so dropping the last one
  // serves exactly the chronological prefix.
  const served = truncated ? rows.slice(0, -1) : rows;
  const events = served.map((row) => ({
    model: row.model,
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    cacheReadTokens: toNumber(row.cacheReadTokens),
    cacheWriteTokens: toNumber(row.cacheWriteTokens),
    estimatedCostUsd:
      row.estimatedCost === null ? null : toNumber(row.estimatedCost),
    eventCreatedAt: row.eventCreatedAt,
  }));
  return {
    events,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * FEA-2730 (G10): the per-session analytics rollup (1:1), org-scoped through
 * the session→artifact join. Returns null when the session has no synced
 * rollup or belongs to another org.
 */
export async function readSessionUsageRollup(input: {
  organizationId: string;
  sessionArtifactId: string;
}): Promise<AgentSessionUsageRollupView | null> {
  const row = await withDb((db) =>
    db.agentSessionUsageRollup.findFirst({
      where: {
        artifactId: input.sessionArtifactId,
        session: { artifact: { organizationId: input.organizationId } },
      },
      select: AGENT_SESSION_USAGE_ROLLUP_SELECT,
    })
  );
  if (!row) {
    return null;
  }
  return {
    startedAt: row.startedAt,
    startedDay: row.startedDay,
    status: row.status,
    harness: row.harness,
    isHuman: row.isHuman,
    humanTurns: row.humanTurns,
    agentTurns: row.agentTurns,
    eventCount: row.eventCount,
    toolInvocations: row.toolInvocations,
    errorEvents: row.errorEvents,
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    cacheReadTokens: toNumber(row.cacheReadTokens),
    cacheWriteTokens: toNumber(row.cacheWriteTokens),
    estimatedCostUsd: toNumber(row.estimatedCost),
    // runtime_ms is BigInt in the DB (widened to avoid int4 overflow on long
    // sessions); the view exposes it as number|null, preserving null.
    runtimeMs: row.runtimeMs == null ? null : Number(row.runtimeMs),
    rollupUpdatedAt: row.rollupUpdatedAt,
  };
}

/**
 * The row shape {@link readSessionUsageRollup} maps. Named separately from
 * {@link AgentSessionUsageRollupView} because two column names are renamed on
 * the way out (`estimatedCost` -> `estimatedCostUsd`), so the view's keys are
 * not the table's.
 *
 * Anchored to the Prisma model rather than spelled as its own literal: a
 * `satisfies Record<keyof …, true>` whose anchor is a hand-written copy of the
 * select proves only that the two copies agree, so a column name that no longer
 * exists — or never did — would typecheck on both sides. `Pick` makes the model
 * the authority, so only real columns can be named here at all.
 */
type AgentSessionUsageRollupRow = Pick<
  AgentSessionUsageRollup,
  | "startedAt"
  | "startedDay"
  | "status"
  | "harness"
  | "isHuman"
  | "humanTurns"
  | "agentTurns"
  | "eventCount"
  | "toolInvocations"
  | "errorEvents"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "estimatedCost"
  | "runtimeMs"
  | "rollupUpdatedAt"
>;

/**
 * Every column the rollup mapper reads — and no other. `artifactId` is the
 * caller's own input, and `lastSyncedAt` / `createdAt` / `updatedAt` are cloud
 * bookkeeping the view never exposes.
 */
const AGENT_SESSION_USAGE_ROLLUP_SELECT = {
  startedAt: true,
  startedDay: true,
  status: true,
  harness: true,
  isHuman: true,
  humanTurns: true,
  agentTurns: true,
  eventCount: true,
  toolInvocations: true,
  errorEvents: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  runtimeMs: true,
  rollupUpdatedAt: true,
} satisfies Record<keyof AgentSessionUsageRollupRow, true>;
