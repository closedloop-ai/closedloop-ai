import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  type BranchTraceSessionHydration,
  BranchTraceSessionHydrationState,
  type BranchTraceSessionIdentity,
  BranchTraceUnavailableReason,
  partitionReadableTraceItems,
  withUnreadableItemCount,
} from "@repo/api/src/types/branch-trace";
import type { PrismaClient } from "@repo/database";
import {
  collectSessionTraceItems,
  type MergedTraceSessionInput,
  mergeCollectedTraceSessions,
} from "@repo/lib/branches/merged-trace";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  type AgentSessionDetailProjectionInput,
  projectAgentSessionDetail,
  readAgentSessionDetailInputs,
} from "@/app/agent-sessions/service/session-detail-read";
import { sessionLinkWhere } from "./branch-read-service/session-usage-link-read";
import { branchParticipationForLink } from "./branch-read-service/session-usage-window";
import {
  warnOnUnreadableTraceItems,
  warnOnUntrustworthyTraceExtents,
} from "./merged-trace-extent-report";

type BranchTraceReadClient = Pick<PrismaClient, "artifactLink">;

export type QualifyingBranchTraceSession = {
  identity: BranchTraceSessionIdentity;
  observedAtMs: number;
  updatedAt?: string;
};

type HydrationResult = {
  session: BranchTraceSessionHydration;
  detail: AgentSessionDetail | null;
  collected?: ReturnType<typeof collectSessionTraceItems> & {
    sessionId: string;
  };
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
 * Enumerate the full canonical qualifying population and hydrate it in one
 * batched read. No provider or acquisition path participates.
 */
async function buildCompleteBranchTrace(
  organizationId: string,
  qualifyingSessions: readonly QualifyingBranchTraceSession[],
  signal?: AbortSignal
): Promise<BranchTraceResult> {
  const result = await buildSessionTimelineTrace(
    organizationId,
    qualifyingSessions,
    signal
  );
  return result.trace;
}

async function buildSessionTimelineTrace(
  organizationId: string,
  qualifyingSessions: readonly QualifyingBranchTraceSession[],
  signal?: AbortSignal
): Promise<{ trace: BranchTraceResult; details: AgentSessionDetail[] }> {
  const hydrationResults = await hydrateSessionsBatched(
    organizationId,
    qualifyingSessions,
    signal
  );
  const loadedDetails = hydrationResults.flatMap((result) =>
    result.detail ? [result.detail] : []
  );
  const built = mergeCollectedTraceSessions(
    hydrationResults.flatMap((result) =>
      result.collected ? [result.collected] : []
    )
  );
  // ISS-8767: the shared fold has already refused any impossible `tools` extent
  // and fallen those items back to their own start, so the trace below is
  // honest. This is the only layer that can SAY so — the browser half of that
  // fold cannot log. Reported over the PRE-drop population, which is the set
  // that actually sized this trace's pauses.
  warnOnUntrustworthyTraceExtents(built.items, { organizationId });
  // ISS-9723 (#6884 review, davetho): seeded with what the BUILDER discarded,
  // which this schema partition cannot see — a turn whose `t` will not parse is
  // gone before `built.items` exists.
  const { items, unreadableCountBySession } = partitionReadableTraceItems(
    built.items,
    built.unstampedCountBySession
  );
  warnOnUnreadableTraceItems(unreadableCountBySession, { organizationId });
  const states = completenessForHydration(
    qualifyingSessions.length,
    loadedDetails.length,
    // ISS-5075: a session whose event stream hit the detail read's row ceiling
    // hydrates fine but contributes only a chronological PREFIX of its turns, so
    // the merged trace is built from partial evidence. Count-based completeness
    // can't see that — without this the trace would assert `complete` over a cut
    // stream, a stronger claim than the uncapped read it replaced ever made.
    loadedDetails.some((detail) => detail.eventsTruncated === true),
    unreadableCountBySession.size > 0
  );
  const trace: BranchTraceResult = {
    items,
    sessions: hydrationResults.map((result) =>
      withUnreadableItemCount(result.session, unreadableCountBySession)
    ),
    qualifyingSessionCount: qualifyingSessions.length,
    completeness: states.completeness,
    aggregateCompleteness: states.aggregateCompleteness,
  };
  return { trace, details: loadedDetails };
}

async function findQualifyingBranchTraceSessions(
  db: BranchTraceReadClient,
  organizationId: string,
  branchId: string
): Promise<QualifyingBranchTraceSession[]> {
  const links = await db.artifactLink.findMany({
    where: sessionLinkWhere(organizationId, [branchId]),
    orderBy: [
      { branchParticipationObservedAt: "desc" },
      { createdAt: "desc" },
      { sourceId: "asc" },
      { id: "asc" },
    ],
    select: {
      branchParticipation: true,
      branchParticipationObservedAt: true,
      createdAt: true,
      metadata: true,
      source: {
        select: {
          id: true,
          name: true,
          slug: true,
          updatedAt: true,
          session: {
            select: {
              artifactId: true,
              externalSessionId: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });
  const newestBySession = new Map<string, QualifyingBranchTraceSession>();
  for (const link of links) {
    if (branchParticipationForLink(link) === BranchParticipationKind.Reviewed) {
      continue;
    }
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
      updatedAt: `${link.source.updatedAt?.toISOString() ?? ""}:${session.updatedAt?.toISOString() ?? ""}`,
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

/**
 * ISS-9112: ONE read for the whole qualifying population. The number of queries
 * this issues does not grow with the number of linked sessions, which is what
 * the per-session fan-out it replaced could not say.
 *
 * Projection stays per session, inside its own failure boundary: the read is
 * genuinely shared, a projection fault is not, and one malformed record must not
 * take the whole trace with it.
 *
 * A failure of the SHARED read is classified once and reported against every
 * identity — an `Unavailable` session carrying the classified reason, never a
 * thrown trace. That is what the per-session shape produced for a fault common to
 * every session, and it is a WIDER blast radius than that shape had for a fault
 * only some sessions would have hit. The read is chunked
 * (`SESSION_DETAIL_READ_BATCH_SIZE`), which bounds how much of the population any
 * one query's own size can implicate, but a fault still fails the population
 * rather than a subset. `Unavailable` says exactly that and does not overclaim.
 */
async function hydrateSessionsBatched(
  organizationId: string,
  sessions: readonly QualifyingBranchTraceSession[],
  signal?: AbortSignal
): Promise<HydrationResult[]> {
  signal?.throwIfAborted();
  let inputsBySession: Map<string, AgentSessionDetailProjectionInput>;
  try {
    const inputs = await readAgentSessionDetailInputs(
      {
        organizationId,
        ids: sessions.map((session) => session.identity.artifactId),
      },
      {
        includeActivitySegments: false,
        includeAuthoritativeCost: false,
        // The read is chunked, so a wide branch issues many statements after
        // this call and before line 209 would next look. Checking the signal
        // only around the call would let an abort that lands during the
        // population's first chunk still pay for every remaining one.
        signal,
      }
    );
    inputsBySession = new Map(
      inputs.map((input) => [input.record.artifactId, input])
    );
  } catch (error) {
    // An abort is the CALLER leaving, not the population becoming unavailable.
    // Rethrow it so it still propagates the way the pre-read check did, rather
    // than reporting a whole trace as `Cancelled` to a request that is gone —
    // and so this log stays a signal about the DATA, not about client churn.
    signal?.throwIfAborted();
    const reason = classifyHydrationFailure(error);
    log.warn("[getBranchTrace] Session hydration unavailable", {
      sessionCount: sessions.length,
      reason,
    });
    return sessions.map((session) =>
      unavailableHydration(session.identity, reason)
    );
  }
  signal?.throwIfAborted();
  return sessions.map((session) =>
    hydrateSession(
      session.identity,
      inputsBySession.get(session.identity.artifactId)
    )
  );
}

function hydrateSession(
  identity: BranchTraceSessionIdentity,
  projectionInput: AgentSessionDetailProjectionInput | undefined
): HydrationResult {
  if (!projectionInput) {
    return unavailableHydration(
      identity,
      BranchTraceUnavailableReason.NotFound
    );
  }
  try {
    const detail = projectAgentSessionDetail(projectionInput);
    if (!requiredSessionDetailSchema.safeParse(detail).success) {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.Malformed
      );
    }
    return {
      session: { identity, state: BranchTraceSessionHydrationState.Loaded },
      detail,
      collected: {
        sessionId: detail.id,
        ...collectSessionTraceItems(toMergedTraceSessionInput(detail)),
      },
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
  anyDetailTruncated: boolean,
  // ISS-9723: a Session can now load in full and still contribute fewer items
  // than it built. Count-based completeness cannot see that, and without it a
  // trace missing a dropped item would still assert `complete`.
  anyItemUnreadable: boolean
): Pick<BranchTraceResult, "completeness" | "aggregateCompleteness"> {
  if (
    qualifyingCount === loadedCount &&
    !(anyDetailTruncated || anyItemUnreadable)
  ) {
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
  buildSessionTimelineTrace,
  findQualifyingBranchTraceSessions,
};
