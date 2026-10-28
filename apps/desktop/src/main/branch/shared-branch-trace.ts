import { DEFAULT_HUMAN_ACTOR_COLOR_TOKEN } from "@repo/api/src/agent-session-user-color";
import type { TokenEventCostPoint } from "@repo/api/src/types/agent-session";
import { decodeBranchId } from "@repo/api/src/types/branch";
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
import {
  buildMergedTrace,
  buildMergedTraceWithDiscards,
  type MergedTraceSessionInput,
} from "@repo/lib/branches/merged-trace";
import { projectAgentSessionTurnItemsFromEvents } from "@repo/lib/sessions/agent-session-detail-projection";
import { z } from "zod";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../../shared/shared-agent-sessions-contract.js";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import {
  type BranchLinkRow,
  readLocalBranchLinkRowsForBranch,
} from "../database/branch-reads.js";
import { reportBranchTraceItemsUnreadable } from "../telemetry/branch-trace-unreadable-items-telemetry.js";
import type { BranchSyncSource } from "./shared-branches-api.js";
import {
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";

type QualifyingDesktopSession = {
  identity: BranchTraceSessionIdentity;
  observedAtMs: number;
};

type DesktopHydrationResult = {
  session: BranchTraceSessionHydration;
  traceInput: MergedTraceSessionInput | null;
};

const loadedSessionIdentitySchema = z.object({
  externalSessionId: z.string().min(1),
  startedAt: z.string().datetime(),
  events: z.array(z.unknown()),
});

/**
 * Read every qualifying persisted Desktop Session identity, then hydrate event
 * details in bounded batches without discarding identities that fail to load.
 */
export async function getSharedBranchTrace(
  source: BranchSyncSource | null | undefined,
  id: unknown
): Promise<BranchTraceResult> {
  if (!source || typeof id !== "string" || id.length === 0) {
    return unavailableResult([], BranchTraceUnavailableReason.Unknown);
  }
  let decodedBranchId: ReturnType<typeof decodeBranchId>;
  try {
    decodedBranchId = decodeBranchId(id);
  } catch {
    return unavailableResult([], BranchTraceUnavailableReason.Malformed);
  }
  let qualifyingSessions: QualifyingDesktopSession[];
  try {
    const rawLinkRows = await readLocalBranchLinkRowsForBranch(
      source.prisma,
      decodedBranchId
    );
    const linkRows = filterEligibleBranchRows(
      rawLinkRows,
      resolveBranchProductEligibilitySnapshot(rawLinkRows)
    );
    qualifyingSessions = selectQualifyingSessions(linkRows);
  } catch {
    return unavailableResult([], BranchTraceUnavailableReason.Unknown);
  }
  if (!source.syncSource) {
    return resultFromHydrations(
      qualifyingSessions,
      qualifyingSessions.map(({ identity }) =>
        unavailableHydration(identity, BranchTraceUnavailableReason.Unknown)
      )
    );
  }

  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  let hydrations: DesktopHydrationResult[];
  try {
    // One db-host call lets its own bounded chunker retain this cache across
    // chunk boundaries. Repeated IPC calls would structured-clone the Maps and
    // make every batch repeat the same filesystem and git attribution work.
    const loaded = await source.syncSource.loadSyncedSessions(
      qualifyingSessions.map(
        ({ identity }) => identity.externalSessionId ?? identity.artifactId
      ),
      cache
    );
    hydrations = hydrateBatch(qualifyingSessions, loaded);
  } catch (error) {
    const reason = classifyHydrationFailure(error);
    hydrations = qualifyingSessions.map(({ identity }) =>
      unavailableHydration(identity, reason)
    );
  }
  return resultFromHydrations(qualifyingSessions, hydrations);
}

function selectQualifyingSessions(
  linkRows: readonly BranchLinkRow[]
): QualifyingDesktopSession[] {
  const newestById = new Map<string, QualifyingDesktopSession>();
  for (const link of linkRows) {
    const observedAtMs = Date.parse(link.observedAt);
    const normalizedObservedAtMs = Number.isFinite(observedAtMs)
      ? observedAtMs
      : Number.NEGATIVE_INFINITY;
    const existing = newestById.get(link.sessionId);
    if (existing && existing.observedAtMs >= normalizedObservedAtMs) {
      continue;
    }
    newestById.set(link.sessionId, {
      observedAtMs: normalizedObservedAtMs,
      identity: {
        artifactId: link.sessionId,
        name: link.sessionName,
        slug: null,
        navigableRef: link.sessionId,
        externalSessionId: link.sessionId,
      },
    });
  }
  return [...newestById.values()].sort((left, right) => {
    if (left.observedAtMs !== right.observedAtMs) {
      return left.observedAtMs > right.observedAtMs ? -1 : 1;
    }
    return left.identity.artifactId.localeCompare(right.identity.artifactId);
  });
}

function hydrateBatch(
  batch: readonly QualifyingDesktopSession[],
  loadedSessions: readonly SyncedAgentSession[]
): DesktopHydrationResult[] {
  const loadedById = new Map(
    loadedSessions.map((session) => [session.externalSessionId, session])
  );
  return batch.map(({ identity }) => {
    const loaded = loadedById.get(
      identity.externalSessionId ?? identity.artifactId
    );
    if (!loaded) {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.NotFound
      );
    }
    if (!loadedSessionIdentitySchema.safeParse(loaded).success) {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.Malformed
      );
    }
    try {
      const traceInput = toMergedTraceSessionInput(loaded);
      // ISS-9723: build only to prove this Session yields items at all. Items
      // the contract cannot parse are rejected individually over the joint
      // build in `resultFromHydrations`, so one of them no longer withholds
      // every readable item this Session holds. A THROW still costs the whole
      // Session, because it produced nothing to keep.
      buildMergedTrace([traceInput]);
      return {
        session: { identity, state: BranchTraceSessionHydrationState.Loaded },
        traceInput,
      };
    } catch {
      return unavailableHydration(
        identity,
        BranchTraceUnavailableReason.Malformed
      );
    }
  });
}

function unavailableHydration(
  identity: BranchTraceSessionIdentity,
  reason: BranchTraceUnavailableReason
): DesktopHydrationResult {
  return {
    session: {
      identity,
      state: BranchTraceSessionHydrationState.Unavailable,
      reason,
    },
    traceInput: null,
  };
}

function resultFromHydrations(
  qualifyingSessions: readonly QualifyingDesktopSession[],
  hydrations: readonly DesktopHydrationResult[]
): BranchTraceResult {
  const traceInputs = hydrations.flatMap(({ traceInput }) =>
    traceInput ? [traceInput] : []
  );
  const loadedCount = traceInputs.length;
  // ISS-9723 (#6884 review, davetho): seeded with what the BUILDER discarded.
  // The sibling cloud producer seeds the same way from the same helper, so a
  // turn neither can place in time is counted identically on both surfaces.
  const built = buildMergedTraceWithDiscards(traceInputs);
  const { items, unreadableCountBySession } = partitionReadableTraceItems(
    built.items,
    built.unstampedCountBySession
  );
  // ISS-9723 (#6884 review, codex): the drop is correct BEHAVIOR and a silent
  // one — the read succeeds and the store is healthy — so the local producer
  // that wrote an unparseable item is invisible off this machine unless the
  // refusal reaches the monitored channel here, where the built trace is still
  // in hand. Reported, never repaired: the partition is not modified.
  reportBranchTraceItemsUnreadable(unreadableCountBySession.size);
  const completeness = completenessForHydration(
    qualifyingSessions.length,
    loadedCount,
    unreadableCountBySession.size > 0
  );
  return {
    items,
    sessions: hydrations.map(({ session }) =>
      withUnreadableItemCount(session, unreadableCountBySession)
    ),
    qualifyingSessionCount: qualifyingSessions.length,
    completeness,
    aggregateCompleteness: completeness,
  };
}

function unavailableResult(
  items: BranchTraceResult["items"],
  reason: BranchTraceUnavailableReason
): BranchTraceResult {
  return {
    items,
    sessions: [],
    qualifyingSessionCount: null,
    completeness: { state: BranchTraceCompletenessState.Unavailable, reason },
    aggregateCompleteness: {
      state: BranchTraceCompletenessState.Unavailable,
      reason,
    },
  };
}

function completenessForHydration(
  qualifyingCount: number,
  loadedCount: number,
  // ISS-9723: a Session can load in full and still contribute fewer items than
  // it built, which count-based completeness cannot see on its own.
  anyItemUnreadable: boolean
): BranchTraceResult["completeness"] {
  if (qualifyingCount === loadedCount && !anyItemUnreadable) {
    return { state: BranchTraceCompletenessState.Complete };
  }
  if (loadedCount > 0) {
    return { state: BranchTraceCompletenessState.Incomplete };
  }
  return { state: BranchTraceCompletenessState.Unavailable };
}

function classifyHydrationFailure(
  error: unknown
): BranchTraceUnavailableReason {
  const evidence = z
    .object({ name: z.string().optional(), status: z.number().optional() })
    .safeParse(error);
  if (!evidence.success) {
    return BranchTraceUnavailableReason.Unknown;
  }
  if (evidence.data.status === 401) {
    return BranchTraceUnavailableReason.Authentication;
  }
  if (evidence.data.status === 403) {
    return BranchTraceUnavailableReason.Permission;
  }
  if (evidence.data.name === "AbortError") {
    return BranchTraceUnavailableReason.Cancelled;
  }
  if (evidence.data.name === "ZodError") {
    return BranchTraceUnavailableReason.Malformed;
  }
  return BranchTraceUnavailableReason.Unknown;
}

function toMergedTraceSessionInput(
  session: SyncedAgentSession
): MergedTraceSessionInput {
  const turnItems = projectAgentSessionTurnItemsFromEvents({
    sessionId: session.externalSessionId,
    harness: session.harness ?? "unknown",
    primaryModel: session.model ?? null,
    humanActor: {
      name: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
      color: DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
    },
    agents: session.agents,
    events: session.events,
    metadata: session.metadata,
    tokenUsageByModel: session.tokenUsageByModel,
    tokenEvents: toTraceTokenEventCostPoints(session),
  });
  return {
    sessionId: session.externalSessionId,
    startedAt: session.startedAt,
    actorName: session.name ?? session.model ?? null,
    harness: session.harness ?? null,
    turnItems,
  };
}

function toTraceTokenEventCostPoints(
  session: SyncedAgentSession
): TokenEventCostPoint[] {
  const points: TokenEventCostPoint[] = [];
  for (const event of session.tokenEvents ?? []) {
    const tMs = Date.parse(event.createdAt);
    if (!Number.isFinite(tMs)) {
      continue;
    }
    points.push({
      tMs,
      costUsd: event.estimatedCostUsd ?? 0,
      agentExternalId: event.agentExternalId ?? null,
    });
  }
  return points;
}
