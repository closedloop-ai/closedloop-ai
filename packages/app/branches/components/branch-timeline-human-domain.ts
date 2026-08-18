import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchTraceSessionHydrationState,
  type BranchTraceState,
} from "@repo/api/src/types/branch-trace";
import {
  CHART_COLOR_TOKENS,
  type ChartColorPair,
  chartColorPairForTokenIndex,
} from "@repo/design-system/components/ui/chart-colors";
import {
  type BranchActorColorDomain,
  BranchActorTurnSide,
  UNATTRIBUTED_ACTOR_KEY,
  UNATTRIBUTED_ACTOR_LABEL,
} from "../lib/branch-actor-domain";

type HumanTimelineSession = BranchPageDetail["sessions"][number] & {
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
  detail: BranchPageDetail,
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
  detail: BranchPageDetail
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
    pairByIdentity.set(candidate.canonicalIdentity, actorColorPair(index));
    if (!identityByLabel.has(candidate.label)) {
      identityByLabel.set(candidate.label, candidate.canonicalIdentity);
    }
  }
  const unattributedPair = chartColorPairForTokenIndex(
    CHART_COLOR_TOKENS.length - 1
  );
  const pairFor = (
    owner: string | null,
    canonicalIdentity?: string | null
  ): ChartColorPair => {
    const label = normalizeDisplayLabel(owner);
    const identity =
      normalizeCanonicalIdentity(canonicalIdentity) ??
      (label ? identityByLabel.get(label) : null);
    return (identity && pairByIdentity.get(identity)) || unattributedPair;
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
      const pair = pairFor(owner, canonicalIdentity);
      return side === BranchActorTurnSide.Human ? pair.soft : pair.strong;
    },
    labelFor(owner) {
      return normalizeDisplayLabel(owner) ?? UNATTRIBUTED_ACTOR_LABEL;
    },
    isUnattributed(owner) {
      return normalizeDisplayLabel(owner) == null;
    },
  };
}

function actorColorPair(index: number): ChartColorPair {
  const conversationBlueIndex = 1;
  let rawIndex = index;
  if (index === 0) {
    rawIndex = conversationBlueIndex;
  } else if (index <= conversationBlueIndex) {
    rawIndex = index - 1;
  }
  return chartColorPairForTokenIndex(rawIndex % CHART_COLOR_TOKENS.length);
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
