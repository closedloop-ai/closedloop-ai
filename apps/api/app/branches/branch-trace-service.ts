import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  type BranchTraceSessionHydration,
  BranchTraceSessionHydrationState,
  type BranchTraceSessionIdentity,
  BranchTraceUnavailableReason,
  mergedTraceItemSchema,
} from "@repo/api/src/types/branch-trace";
import type { PrismaClient } from "@repo/database";
import {
  buildMergedTrace,
  type MergedTraceSessionInput,
} from "@repo/lib/branches/merged-trace";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { sessionLinkWhere } from "./branch-read-service/session-usage-window";

const BRANCH_TRACE_SESSION_CONCURRENCY = 4;

type BranchTraceReadClient = Pick<PrismaClient, "artifactLink">;

export type QualifyingBranchTraceSession = {
  identity: BranchTraceSessionIdentity;
  observedAtMs: number;
};

type HydrationResult = {
  session: BranchTraceSessionHydration;
  detail: AgentSessionDetail | null;
};

const requiredSessionDetailSchema = z
  .object({
    id: z.string().min(1),
    startedAt: z.date(),
    harness: z.string(),
    name: z.string().nullable(),
    primaryModel: z.string().nullable().optional(),
    model: z.string().nullable(),
    turnItems: z.array(z.unknown()).optional(),
  })
  .loose();

const errorEvidenceSchema = z
  .object({
    name: z.string().optional(),
    status: z.number().int().optional(),
  })
  .loose();

/**
 * Enumerate the full canonical qualifying population and hydrate it through a
 * bounded batch scheduler. No provider or acquisition path participates.
 */
async function buildCompleteBranchTrace(
  organizationId: string,
  qualifyingSessions: readonly QualifyingBranchTraceSession[],
  signal?: AbortSignal
): Promise<BranchTraceResult> {
  const hydrationResults = await hydrateSessionsBounded(
    organizationId,
    qualifyingSessions,
    signal
  );
  const loadedDetails = hydrationResults.flatMap((result) =>
    result.detail ? [result.detail] : []
  );
  const items = buildMergedTrace(loadedDetails.map(toMergedTraceSessionInput));
  const states = completenessForHydration(
    qualifyingSessions.length,
    loadedDetails.length,
    // ISS-5075: a session whose event stream hit the detail read's row ceiling
    // hydrates fine but contributes only a chronological PREFIX of its turns, so
    // the merged trace is built from partial evidence. Count-based completeness
    // can't see that — without this the trace would assert `complete` over a cut
    // stream, a stronger claim than the uncapped read it replaced ever made.
    loadedDetails.some((detail) => detail.eventsTruncated === true)
  );
  return {
    items,
    sessions: hydrationResults.map((result) => result.session),
    qualifyingSessionCount: qualifyingSessions.length,
    completeness: states.completeness,
    aggregateCompleteness: states.aggregateCompleteness,
  };
}

async function findQualifyingBranchTraceSessions(
  db: BranchTraceReadClient,
  organizationId: string,
  branchId: string
): Promise<QualifyingBranchTraceSession[]> {
  const links = await db.artifactLink.findMany({
    where: sessionLinkWhere(organizationId, [branchId], {
      includeReviewedParticipation: true,
    }),
    orderBy: [
      { branchParticipationObservedAt: "desc" },
      { createdAt: "desc" },
      { sourceId: "asc" },
      { id: "asc" },
    ],
    select: {
      branchParticipationObservedAt: true,
      createdAt: true,
      source: {
        select: {
          id: true,
          name: true,
          slug: true,
          session: {
            select: { artifactId: true, externalSessionId: true },
          },
        },
      },
    },
  });
  const newestBySession = new Map<string, QualifyingBranchTraceSession>();
  for (const link of links) {
    const session = link.source.session;
    if (!session) {
      continue;
    }
    const artifactId = session.artifactId;
    const observedAtMs = (
      link.branchParticipationObservedAt ?? link.createdAt
    ).getTime();
    const existing = newestBySession.get(artifactId);
    if (existing && existing.observedAtMs >= observedAtMs) {
      continue;
    }
    newestBySession.set(artifactId, {
      observedAtMs,
      identity: {
        artifactId,
        name: link.source.name,
        slug: link.source.slug,
        navigableRef: link.source.slug ?? artifactId,
        ...(session.externalSessionId
          ? { externalSessionId: session.externalSessionId }
          : {}),
      },
    });
  }
  return [...newestBySession.values()].sort(compareQualifyingSessions);
}

function compareQualifyingSessions(
  left: QualifyingBranchTraceSession,
  right: QualifyingBranchTraceSession
): number {
  const byObservation = right.observedAtMs - left.observedAtMs;
  return byObservation === 0
    ? left.identity.artifactId.localeCompare(right.identity.artifactId)
    : byObservation;
}

async function hydrateSessionsBounded(
  organizationId: string,
  sessions: readonly QualifyingBranchTraceSession[],
  signal?: AbortSignal
): Promise<HydrationResult[]> {
  const results = new Array<HydrationResult>(sessions.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    BRANCH_TRACE_SESSION_CONCURRENCY,
    sessions.length
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < sessions.length) {
      signal?.throwIfAborted();
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await hydrateSession(
        organizationId,
        sessions[index].identity
      );
    }
  });
  await Promise.all(workers);
  signal?.throwIfAborted();
  return results;
}

async function hydrateSession(
  organizationId: string,
  identity: BranchTraceSessionIdentity
): Promise<HydrationResult> {
  try {
    const detail = await agentSessionsService.findSessionDetail(
      { id: identity.artifactId, organizationId },
      { includeActivitySegments: false }
    );
    if (!detail) {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.NotFound
      );
    }
    if (
      !(
        requiredSessionDetailSchema.safeParse(detail).success &&
        isTraceDetailProjectable(detail)
      )
    ) {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.Malformed
      );
    }
    return {
      session: { identity, state: BranchTraceSessionHydrationState.Loaded },
      detail,
    };
  } catch (error) {
    const reason = classifyHydrationFailure(error);
    log.warn("[getBranchTrace] Session hydration unavailable", {
      sessionId: identity.artifactId,
      reason,
    });
    return unavailableHydration(identity, reason);
  }
}

function isTraceDetailProjectable(detail: AgentSessionDetail): boolean {
  try {
    return buildMergedTrace([toMergedTraceSessionInput(detail)]).every(
      (item) => mergedTraceItemSchema.safeParse(item).success
    );
  } catch {
    return false;
  }
}

function unavailableHydration(
  identity: BranchTraceSessionIdentity,
  reason: BranchTraceUnavailableReason
): HydrationResult {
  return {
    session: {
      identity,
      state: BranchTraceSessionHydrationState.Unavailable,
      reason,
    },
    detail: null,
  };
}

function classifyHydrationFailure(
  error: unknown
): BranchTraceUnavailableReason {
  const evidence = errorEvidenceSchema.safeParse(error);
  if (!evidence.success) {
    if (error instanceof z.ZodError) {
      return BranchTraceUnavailableReason.Malformed;
    }
    return BranchTraceUnavailableReason.Unknown;
  }
  if (evidence.data.status === 401) {
    return BranchTraceUnavailableReason.Authentication;
  }
  if (evidence.data.status === 403) {
    return BranchTraceUnavailableReason.Permission;
  }
  if (error instanceof z.ZodError) {
    return BranchTraceUnavailableReason.Malformed;
  }
  if (evidence.data.name === "AbortError") {
    return BranchTraceUnavailableReason.Cancelled;
  }
  if (evidence.data.name === "ZodError") {
    return BranchTraceUnavailableReason.Malformed;
  }
  return BranchTraceUnavailableReason.Unknown;
}

function completenessForHydration(
  qualifyingCount: number,
  loadedCount: number,
  anyDetailTruncated: boolean
): Pick<BranchTraceResult, "completeness" | "aggregateCompleteness"> {
  if (qualifyingCount === loadedCount && !anyDetailTruncated) {
    return {
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Complete,
      },
    };
  }
  if (loadedCount > 0) {
    // ISS-5075 (stage review): say WHY it is incomplete. A consumer reading only
    // the state cannot tell a session that failed to hydrate from one that
    // hydrated and was cut at the row ceiling, and the two need different words
    // on screen. Omitted when nothing was truncated — absence is "nothing cut".
    const truncation: { eventsTruncated?: true } = anyDetailTruncated
      ? { eventsTruncated: true }
      : {};
    return {
      completeness: {
        state: BranchTraceCompletenessState.Incomplete,
        ...truncation,
      },
      aggregateCompleteness: {
        state: BranchTraceCompletenessState.Incomplete,
        ...truncation,
      },
    };
  }
  return {
    completeness: { state: BranchTraceCompletenessState.Unavailable },
    aggregateCompleteness: {
      state: BranchTraceCompletenessState.Unavailable,
    },
  };
}

function toMergedTraceSessionInput(
  detail: AgentSessionDetail
): MergedTraceSessionInput {
  return {
    sessionId: detail.id,
    startedAt: detail.startedAt.toISOString(),
    actorName: detail.name ?? detail.primaryModel ?? detail.model ?? null,
    harness: detail.harness,
    turnItems: detail.turnItems ?? [],
  };
}

/** Branch trace persistence enumeration and bounded hydration service. */
export const branchTraceService = {
  buildCompleteBranchTrace,
  findQualifyingBranchTraceSessions,
};
