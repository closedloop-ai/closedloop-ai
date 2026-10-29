import {
  BranchTraceSessionHydrationState,
  type BranchTraceState,
} from "@repo/api/src/types/branch-trace";
import type { SessionTimelineDetail } from "@repo/api/src/types/document-sessions";
import {
  actorColorForTurn,
  actorColorPairForSlot,
  UNKNOWN_ACTOR_COLOR_PAIR,
} from "@repo/app/shared/lib/actor-color-domain";
import type { ChartColorPair } from "@repo/design-system/components/ui/chart-colors";
import {
  type BranchActorColorDomain,
  UNATTRIBUTED_ACTOR_KEY,
  UNATTRIBUTED_ACTOR_LABEL,
} from "../lib/branch-actor-domain";

type HumanTimelineSession = SessionTimelineDetail["sessions"][number] & {
  /** Stable persisted user identity. Optional for legacy and local producers. */
  ownerUserId?: string | null;
};

type HumanActorCandidate = {
  canonicalIdentity: string;
  earliestActivityMs: number;
  label: string;
};

/**
 * Builds the shared human actor palette from rendered activity evidence.
 *
 * The earliest attributed human receives conversation blue. Equal timestamps
 * are resolved by the stable user ID, with a normalized label only as the
 * compatibility fallback for older producers. Unattributed evidence is kept as
 * a separate fallback and never consumes a human palette position.
 */
export function buildTimelineHumanActorDomain(
  detail: SessionTimelineDetail,
  traceState?: BranchTraceState | null
): BranchActorColorDomain {
  const sessions: readonly HumanTimelineSession[] = detail.sessions;
  const firstTraceTimeBySession = earliestHumanTraceTimeBySession(detail);
  const loadedSessionIds = loadedSessionArtifactIds(traceState);
  const candidateByIdentity = new Map<string, HumanActorCandidate>();

  for (const session of sessions) {
    if (loadedSessionIds && !loadedSessionIds.has(session.sessionId)) {
      continue;
    }
    const label = normalizeDisplayLabel(session.ownerUserName);
    if (!label) {
      continue;
    }
    const canonicalIdentity =
      normalizeCanonicalIdentity(session.ownerUserId) ??
      `legacy:${label.toLocaleLowerCase()}`;
    const earliestActivityMs = firstTraceTimeBySession.get(session.sessionId);
    if (earliestActivityMs == null) {
      continue;
    }
    const current = candidateByIdentity.get(canonicalIdentity);
    if (!current || earliestActivityMs < current.earliestActivityMs) {
      candidateByIdentity.set(canonicalIdentity, {
        canonicalIdentity,
        earliestActivityMs,
        label,
      });
    }
  }

  const candidates = [...candidateByIdentity.values()].sort(compareCandidates);
  return createHumanActorDomain(candidates);
}

function earliestHumanTraceTimeBySession(
  detail: SessionTimelineDetail
): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const item of detail.mergedTrace) {
    if (item.type !== "prompt") {
      continue;
    }
    const timestamp = parseTimestamp(item.t);
    const current = earliest.get(item.sessionId);
    if (current == null || timestamp < current) {
      earliest.set(item.sessionId, timestamp);
    }
  }
  return earliest;
}

function loadedSessionArtifactIds(
  traceState?: BranchTraceState | null
): Set<string> | null {
  if (!traceState) {
    return null;
  }
  return new Set(
    traceState.sessions.flatMap((session) =>
      session.state === BranchTraceSessionHydrationState.Loaded
        ? [session.identity.artifactId]
        : []
    )
  );
}

function createHumanActorDomain(
  candidates: readonly HumanActorCandidate[]
): BranchActorColorDomain {
  const pairByIdentity = new Map<string, ChartColorPair>();
  const identityByLabel = new Map<string, string>();
  for (const [index, candidate] of candidates.entries()) {
    pairByIdentity.set(
      candidate.canonicalIdentity,
      actorColorPairForSlot(index)
    );
    if (!identityByLabel.has(candidate.label)) {
      identityByLabel.set(candidate.label, candidate.canonicalIdentity);
    }
  }
  const pairFor = (
    owner: string | null,
    canonicalIdentity?: string | null
  ): ChartColorPair => {
    const label = normalizeDisplayLabel(owner);
    const identity =
      normalizeCanonicalIdentity(canonicalIdentity) ??
      (label ? identityByLabel.get(label) : null);
    return (
      (identity && pairByIdentity.get(identity)) || UNKNOWN_ACTOR_COLOR_PAIR
    );
  };

  return {
    ordered: candidates.map((candidate) => candidate.label),
    colorFor(owner, canonicalIdentity) {
      return pairFor(owner, canonicalIdentity).base;
    },
    colorPairFor(owner, canonicalIdentity) {
      return pairFor(owner, canonicalIdentity);
    },
    colorForTurn(owner, side, canonicalIdentity) {
      return actorColorForTurn(pairFor(owner, canonicalIdentity), side);
    },
    labelFor(owner) {
      return normalizeDisplayLabel(owner) ?? UNATTRIBUTED_ACTOR_LABEL;
    },
    isUnattributed(owner) {
      return normalizeDisplayLabel(owner) == null;
    },
  };
}

function compareCandidates(
  left: HumanActorCandidate,
  right: HumanActorCandidate
): number {
  const byTime = left.earliestActivityMs - right.earliestActivityMs;
  if (byTime !== 0) {
    return byTime;
  }
  return left.canonicalIdentity.localeCompare(right.canonicalIdentity);
}

function normalizeCanonicalIdentity(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeDisplayLabel(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

export const UNATTRIBUTED_TIMELINE_ACTOR_KEY = UNATTRIBUTED_ACTOR_KEY;
