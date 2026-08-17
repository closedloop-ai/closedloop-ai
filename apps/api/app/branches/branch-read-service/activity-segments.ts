import { MAX_STORED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchPhaseAttributionCompletenessReason,
  BranchPhaseAttributionCompletenessReason as PhaseCompletenessReason,
} from "@repo/api/src/types/branch-phase-attribution";
import type { PrismaClient } from "@repo/database";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "@repo/lib/branches/activity-attribution";
import { log } from "@repo/observability/log";
import { numberFromDecimal } from "./session-usage-window";

type ActivitySegmentReadClient = {
  agentSessionActivitySegment: Pick<
    PrismaClient["agentSessionActivitySegment"],
    "findMany"
  >;
  agentSessionTokenEvent: Pick<
    PrismaClient["agentSessionTokenEvent"],
    "findMany"
  >;
};

const BRANCH_ACTIVITY_SEGMENT_MAX_ROWS = MAX_STORED_ACTIVITY_SEGMENTS;
const BRANCH_ACTIVITY_TOKEN_EVENT_MAX_ROWS = 10_000;

/**
 * Attaches the canonical priced activity tiling to each Branch session.
 * Child-table reads stay organization-scoped through their owning Session.
 */
export async function attachBranchActivitySegments(
  db: ActivitySegmentReadClient,
  organizationId: string,
  sessions: BranchPageDetail["sessions"]
): Promise<BranchPhaseAttributionCompletenessReason[]> {
  const coverageReasons = new Set<BranchPhaseAttributionCompletenessReason>();
  const sessionIds = [...new Set(sessions.map((session) => session.sessionId))];
  if (sessionIds.length === 0) {
    return [];
  }
  const orgScopedSession = { session: { artifact: { organizationId } } };
  const tokenEventCap = BRANCH_ACTIVITY_TOKEN_EVENT_MAX_ROWS;
  const [segmentRows, eventRows] = await Promise.all([
    db.agentSessionActivitySegment.findMany({
      where: { agentSessionId: { in: sessionIds }, ...orgScopedSession },
      orderBy: [{ agentSessionId: "asc" }, { startMs: "asc" }],
      take: BRANCH_ACTIVITY_SEGMENT_MAX_ROWS,
      select: {
        agentSessionId: true,
        phase: true,
        startMs: true,
        endMs: true,
        confidence: true,
      },
    }),
    db.agentSessionTokenEvent.findMany({
      where: { agentSessionId: { in: sessionIds }, ...orgScopedSession },
      take: tokenEventCap,
      orderBy: [
        { agentSessionId: "asc" },
        { eventCreatedAt: "asc" },
        { externalEventId: "asc" },
      ],
      select: {
        agentSessionId: true,
        externalEventId: true,
        eventCreatedAt: true,
        estimatedCost: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    }),
  ]);
  if (eventRows.length === tokenEventCap) {
    log.warn("[attachBranchActivitySegments] token-event pool cap hit", {
      organizationId,
      sessionCount: sessionIds.length,
      cap: tokenEventCap,
    });
    coverageReasons.add(PhaseCompletenessReason.CoverageCapped);
  }
  if (segmentRows.length === BRANCH_ACTIVITY_SEGMENT_MAX_ROWS) {
    coverageReasons.add(PhaseCompletenessReason.CoverageCapped);
  }
  const sessionsWithSegments = new Set(
    segmentRows.map((row) => row.agentSessionId)
  );
  if (sessionIds.some((sessionId) => !sessionsWithSegments.has(sessionId))) {
    coverageReasons.add(PhaseCompletenessReason.MissingActivitySegments);
  }

  const spansBySession = new Map<string, ActivitySegmentSpan[]>();
  for (const row of segmentRows) {
    const startMs = Number(row.startMs);
    const endMs = Number(row.endMs);
    if (!isValidActivityInterval(startMs, endMs)) {
      coverageReasons.add(PhaseCompletenessReason.MalformedEvidence);
    }
    const spans = spansBySession.get(row.agentSessionId) ?? [];
    spans.push({
      phase: row.phase,
      startMs,
      endMs,
      confidence: row.confidence,
    });
    spansBySession.set(row.agentSessionId, spans);
  }

  const eventsBySession = new Map<string, ActivitySpendEvent[]>();
  for (const row of eventRows) {
    const event = toActivitySpendEvent(row);
    if (!isValidActivitySpendEvent(event)) {
      coverageReasons.add(PhaseCompletenessReason.PricingIncomplete);
      continue;
    }
    const events = eventsBySession.get(row.agentSessionId) ?? [];
    events.push(event);
    eventsBySession.set(row.agentSessionId, events);
  }

  for (const session of sessions) {
    const spans = spansBySession.get(session.sessionId);
    if (!spans) {
      continue;
    }
    session.activitySegments = attributeBranchSessionActivity(
      spans,
      eventsBySession.get(session.sessionId) ?? []
    );
  }
  return [...coverageReasons];
}

function toActivitySpendEvent(row: {
  agentSessionId: string;
  externalEventId: string;
  eventCreatedAt: Date;
  estimatedCost: Parameters<typeof numberFromDecimal>[0];
  inputTokens: bigint;
  outputTokens: bigint;
  cacheReadTokens: bigint;
  cacheWriteTokens: bigint;
}): CompleteActivitySpendEvent {
  return {
    tMs: row.eventCreatedAt.getTime(),
    costUsd: numberFromDecimal(row.estimatedCost),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
    ...(row.externalEventId ? { sourceId: row.externalEventId } : {}),
  };
}

function isValidActivityInterval(startMs: number, endMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

function isValidActivitySpendEvent(event: CompleteActivitySpendEvent): boolean {
  return (
    Number.isFinite(event.tMs) &&
    Number.isFinite(event.costUsd) &&
    event.costUsd >= 0 &&
    event.inputTokens >= 0 &&
    event.outputTokens >= 0 &&
    event.cacheReadTokens >= 0 &&
    event.cacheWriteTokens >= 0
  );
}

type CompleteActivitySpendEvent = Omit<
  ActivitySpendEvent,
  "costUsd" | "cacheReadTokens" | "cacheWriteTokens"
> & {
  costUsd: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
