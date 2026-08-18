import type {
  BranchActivitySegment,
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BranchLifecycleBoundaryKind as LifecycleBoundaryKind,
  BranchParticipationKind as ParticipationKind,
} from "@repo/api/src/types/branch";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  type BranchPhaseAttributionRollup,
  type BranchPhaseAttributionSegment,
  BranchVisibleLifecyclePhase,
  BranchPhaseAttributionCompletenessReason as CompletenessReason,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { BRANCH_PUSH_METHODS } from "@repo/api/src/types/session-artifact-link";
import { microCentsToUsd, usdToMicroCents } from "./activity-attribution";

/** Raw provider-neutral lifecycle event retained until priced-segment projection. */
export type BranchPhaseLifecycleEvent = {
  kind: BranchLifecycleBoundaryKind | (string & {});
  observedAt?: string | null;
  evidenceId?: string | null;
  method?: string | null;
};

/** One explicit open-to-terminal PR lifecycle cycle; reopened PRs use another row. */
export type BranchPhasePullRequestCycle = {
  pullRequestId: string;
  openedAt: string | null;
  terminalAt: string | null;
};

/** Per-Session evidence accepted by the shared cloud/Desktop projector. */
export type BranchPhaseAttributionSessionInput = {
  sessionId: string;
  participation?: BranchParticipationKind;
  branchCount?: number;
  estimatedCostUsd?: number | null;
  activitySegments?: readonly BranchActivitySegment[];
  lifecycleEvents?: readonly BranchPhaseLifecycleEvent[];
};

/** Complete provider-neutral input to the canonical phase projector. */
export type BranchPhaseAttributionInput = {
  sessions: readonly BranchPhaseAttributionSessionInput[];
  pullRequestCycles: readonly BranchPhasePullRequestCycle[];
  /** Terminal boundaries after which a later open boundary is known to be missing. */
  ambiguousWriteAfter?: readonly string[];
  coverageReasons?: readonly BranchPhaseAttributionCompletenessReason[];
};

/**
 * Project qualifying priced activity segments exactly once into the three visible
 * Branch lifecycle phases. The function is pure, validates its own boundary, and
 * never manufactures an Unknown/Other bucket when evidence is incomplete.
 */
export function projectBranchPhaseAttribution(
  input: BranchPhaseAttributionInput
): BranchPhaseAttributionResult {
  const reasons = new Set<BranchPhaseAttributionCompletenessReason>(
    input.coverageReasons ?? []
  );
  const cycles = normalizeCycles(input.pullRequestCycles, reasons);
  const ambiguousWriteAfter = normalizeAmbiguousBoundaries(
    input.ambiguousWriteAfter ?? [],
    reasons
  );
  const sessions = mergeSessions(input.sessions, reasons);
  const effectiveCycles = materializeReopenCycles(
    cycles,
    ambiguousWriteAfter,
    sessions
  );
  const projected: BranchPhaseAttributionSegment[] = [];

  for (const session of sessions.values()) {
    projectSessionSegments(
      session,
      effectiveCycles,
      ambiguousWriteAfter,
      reasons,
      projected
    );
  }

  const costAllocated = allocateSessionCostShares(projected, sessions);
  costAllocated.sort(compareProjectedSegments);
  const sequenced = costAllocated.map((segment, sequence) => ({
    ...segment,
    sequence,
  }));
  const rollups = buildRollups(sequenced);
  const subtotalMicroCents = sequenced.reduce(
    (total, segment) => total + usdToMicroCents(segment.estimatedCostUsd),
    0
  );
  const subtotalUsd = microCentsToUsd(subtotalMicroCents);
  return {
    segments: sequenced,
    rollups,
    coverage: buildCoverage(reasons, subtotalUsd, sequenced.length > 0),
  };
}

function materializeReopenCycles(
  cycles: readonly NormalizedCycle[],
  boundaries: readonly number[],
  sessions: ReadonlyMap<string, MergedSession>
): NormalizedCycle[] {
  const pushTimes = [...sessions.values()]
    .flatMap((session) => session.lifecycleEvents)
    .filter(
      (event) =>
        event.kind === LifecycleBoundaryKind.BranchWrite &&
        Boolean(event.method && BRANCH_PUSH_METHODS.has(event.method))
    )
    .flatMap((event) => {
      const observedAtMs = parseTimestamp(event.observedAt);
      return observedAtMs === null ? [] : [observedAtMs];
    })
    .sort((left, right) => left - right);
  const synthetic = boundaries.flatMap((boundary, index) => {
    const firstPush = pushTimes.find(
      (timestamp) =>
        timestamp >= boundary &&
        !cycles.some(
          (cycle) =>
            cycle.openedAtMs <= timestamp &&
            (cycle.terminalAtMs === null || timestamp < cycle.terminalAtMs)
        )
    );
    return firstPush === undefined
      ? []
      : [
          {
            pullRequestId: `reopened-${index}`,
            openedAtMs: firstPush,
            terminalAtMs:
              cycles.find((cycle) => cycle.openedAtMs > firstPush)
                ?.openedAtMs ?? null,
          },
        ];
  });
  return [...cycles, ...synthetic].sort(
    (left, right) => left.openedAtMs - right.openedAtMs
  );
}

type NormalizedCycle = {
  pullRequestId: string;
  openedAtMs: number;
  terminalAtMs: number | null;
};

type MergedSession = {
  sessionId: string;
  participation?: BranchParticipationKind;
  branchCount: number | null;
  estimatedCostUsd: number | null;
  activitySegments: BranchActivitySegment[] | undefined;
  lifecycleEvents: BranchPhaseLifecycleEvent[];
};

type NormalizedEvent = {
  kind: BranchLifecycleBoundaryKind;
  observedAtMs: number;
  evidenceId: string | null;
  method: string | null;
};

type MutableRollup = Omit<BranchPhaseAttributionRollup, "durationMs"> & {
  intervals: Array<{ startMs: number; endMs: number }>;
  sessionIds: Set<string>;
};

const reasonPrecedence: readonly BranchPhaseAttributionCompletenessReason[] = [
  CompletenessReason.MalformedEvidence,
  CompletenessReason.CoverageCapped,
  CompletenessReason.AmbiguousEvidence,
  CompletenessReason.LifecycleIncomplete,
  CompletenessReason.PricingIncomplete,
  CompletenessReason.MissingActivitySegments,
];

const knownBoundaryKinds = new Set<string>(
  Object.values(LifecycleBoundaryKind)
);

function normalizeCycles(
  cycles: readonly BranchPhasePullRequestCycle[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): NormalizedCycle[] {
  const normalized: NormalizedCycle[] = [];
  for (const cycle of cycles) {
    const openedAtMs = parseTimestamp(cycle.openedAt);
    const terminalAtMs = cycle.terminalAt
      ? parseTimestamp(cycle.terminalAt)
      : null;
    if (
      !cycle.pullRequestId ||
      openedAtMs === null ||
      (cycle.terminalAt !== null && terminalAtMs === null) ||
      (terminalAtMs !== null && terminalAtMs < openedAtMs)
    ) {
      reasons.add(CompletenessReason.MalformedEvidence);
      continue;
    }
    normalized.push({
      pullRequestId: cycle.pullRequestId,
      openedAtMs,
      terminalAtMs,
    });
  }
  normalized.sort((left, right) => left.openedAtMs - right.openedAtMs);
  return normalized;
}

function normalizeAmbiguousBoundaries(
  boundaries: readonly string[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): number[] {
  const normalized: number[] = [];
  for (const boundary of boundaries) {
    const timestamp = parseTimestamp(boundary);
    if (timestamp === null) {
      reasons.add(CompletenessReason.MalformedEvidence);
      continue;
    }
    normalized.push(timestamp);
  }
  return [...new Set(normalized)].sort((left, right) => left - right);
}

function mergeSessions(
  inputs: readonly BranchPhaseAttributionSessionInput[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): Map<string, MergedSession> {
  const sessions = new Map<string, MergedSession>();
  for (const input of inputs) {
    if (!input.sessionId) {
      reasons.add(CompletenessReason.MalformedEvidence);
      continue;
    }
    const branchCount = validBranchCount(input.branchCount, reasons);
    const existing = sessions.get(input.sessionId);
    if (!existing) {
      sessions.set(input.sessionId, {
        sessionId: input.sessionId,
        participation: input.participation,
        branchCount,
        estimatedCostUsd: validOptionalCost(input.estimatedCostUsd, reasons),
        activitySegments:
          input.activitySegments === undefined
            ? undefined
            : [...input.activitySegments],
        lifecycleEvents: [...(input.lifecycleEvents ?? [])],
      });
      continue;
    }
    if (
      existing.branchCount !== null &&
      branchCount !== null &&
      existing.branchCount !== branchCount
    ) {
      reasons.add(CompletenessReason.AmbiguousEvidence);
      existing.branchCount = null;
    } else if (existing.branchCount !== null) {
      existing.branchCount = branchCount;
    }
    existing.estimatedCostUsd = mergeEstimatedCost(
      existing.estimatedCostUsd,
      input.estimatedCostUsd,
      reasons
    );
    existing.participation = mergeParticipation(
      existing.participation,
      input.participation
    );
    existing.activitySegments = mergeOptionalSegments(
      existing.activitySegments,
      input.activitySegments
    );
    existing.lifecycleEvents.push(...(input.lifecycleEvents ?? []));
  }
  return sessions;
}

function mergeParticipation(
  existing: BranchParticipationKind | undefined,
  next: BranchParticipationKind | undefined
): BranchParticipationKind | undefined {
  return existing === ParticipationKind.Wrote ||
    next === ParticipationKind.Wrote
    ? ParticipationKind.Wrote
    : (existing ?? next);
}

function validBranchCount(
  value: number | undefined,
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): number | null {
  if (value === undefined) {
    return 1;
  }
  if (!(Number.isInteger(value) && value > 0)) {
    reasons.add(CompletenessReason.MalformedEvidence);
    return null;
  }
  return value;
}

function validOptionalCost(
  value: number | null | undefined,
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): number | null {
  if (value == null) {
    return null;
  }
  if (!(Number.isFinite(value) && value >= 0)) {
    reasons.add(CompletenessReason.PricingIncomplete);
    return null;
  }
  return value;
}

function mergeEstimatedCost(
  existing: number | null,
  next: number | null | undefined,
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): number | null {
  const normalized = validOptionalCost(next, reasons);
  if (existing === null) {
    return normalized;
  }
  if (normalized !== null && normalized !== existing) {
    reasons.add(CompletenessReason.AmbiguousEvidence);
  }
  return existing;
}

function mergeOptionalSegments(
  existing: BranchActivitySegment[] | undefined,
  next: readonly BranchActivitySegment[] | undefined
): BranchActivitySegment[] | undefined {
  if (next === undefined) {
    return existing;
  }
  return [...(existing ?? []), ...next];
}

function projectSessionSegments(
  session: MergedSession,
  cycles: readonly NormalizedCycle[],
  ambiguousWriteAfter: readonly number[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>,
  output: BranchPhaseAttributionSegment[]
): void {
  if (session.branchCount === null) {
    return;
  }
  if (
    session.activitySegments === undefined ||
    session.activitySegments.length === 0
  ) {
    if (session.estimatedCostUsd !== null) {
      reasons.add(CompletenessReason.MissingActivitySegments);
    }
    return;
  }
  const events = normalizeEvents(session.lifecycleEvents, reasons);
  if (
    session.participation === ParticipationKind.Reviewed &&
    !events.some((event) => event.kind === LifecycleBoundaryKind.ReviewFeedback)
  ) {
    return;
  }
  const segments = distinctSegments(session.activitySegments, reasons);
  if (
    segments.some((segment) => segment.costUsd !== null) &&
    events.length === 0
  ) {
    reasons.add(CompletenessReason.LifecycleIncomplete);
  }
  for (const segment of segments) {
    const projected = projectSegment(
      session,
      segment,
      events,
      cycles,
      ambiguousWriteAfter,
      reasons
    );
    if (projected) {
      output.push(projected);
    }
  }
}

function normalizeEvents(
  events: readonly BranchPhaseLifecycleEvent[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const observedAtMs = parseTimestamp(event.observedAt);
    if (!(knownBoundaryKinds.has(event.kind) && observedAtMs !== null)) {
      reasons.add(CompletenessReason.MalformedEvidence);
      continue;
    }
    const key = JSON.stringify([
      event.kind,
      observedAtMs,
      event.evidenceId ?? null,
      event.method ?? null,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      kind: event.kind as BranchLifecycleBoundaryKind,
      observedAtMs,
      evidenceId: event.evidenceId ?? null,
      method: event.method ?? null,
    });
  }
  return normalized.sort(
    (left, right) => left.observedAtMs - right.observedAtMs
  );
}

function distinctSegments(
  segments: readonly BranchActivitySegment[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): BranchActivitySegment[] {
  const byInterval = new Map<string, BranchActivitySegment>();
  const conflicting = new Set<string>();
  for (const segment of segments) {
    if (!validSegment(segment)) {
      reasons.add(CompletenessReason.MalformedEvidence);
      continue;
    }
    const stableSources = [...(segment.sourceEventIds ?? [])].sort();
    const intervalKey =
      stableSources.length > 0
        ? `sources:${stableSources.join("|")}`
        : `legacy-interval:${segment.startMs}:${segment.endMs}`;
    const existing = byInterval.get(intervalKey);
    if (!existing) {
      byInterval.set(intervalKey, segment);
      continue;
    }
    if (segmentIdentity(existing) !== segmentIdentity(segment)) {
      conflicting.add(intervalKey);
      reasons.add(CompletenessReason.AmbiguousEvidence);
    }
  }
  return [...byInterval]
    .filter(([key]) => !conflicting.has(key))
    .map(([, segment]) => segment)
    .sort((left, right) => left.startMs - right.startMs);
}

function validSegment(segment: BranchActivitySegment): boolean {
  return (
    Number.isFinite(segment.startMs) &&
    Number.isFinite(segment.endMs) &&
    segment.endMs > segment.startMs &&
    (segment.costUsd === null ||
      (Number.isFinite(segment.costUsd) && segment.costUsd >= 0)) &&
    validTokens(segment.inputTokens) &&
    validTokens(segment.outputTokens) &&
    validTokens(segment.cacheReadTokens ?? 0) &&
    validTokens(segment.cacheWriteTokens ?? 0)
  );
}

function validTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function segmentIdentity(segment: BranchActivitySegment): string {
  return JSON.stringify([
    segment.phase,
    segment.startMs,
    segment.endMs,
    segment.costUsd,
    segment.inputTokens,
    segment.outputTokens,
    segment.cacheReadTokens ?? 0,
    segment.cacheWriteTokens ?? 0,
    [...(segment.sourceEventIds ?? [])].sort(),
  ]);
}

function projectSegment(
  session: MergedSession,
  segment: BranchActivitySegment,
  events: readonly NormalizedEvent[],
  cycles: readonly NormalizedCycle[],
  ambiguousWriteAfter: readonly number[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): BranchPhaseAttributionSegment | null {
  if (segment.costUsd === null) {
    if (segmentHasSpendEvidence(segment)) {
      reasons.add(CompletenessReason.PricingIncomplete);
    }
    return null;
  }
  const contained = events.filter(
    (event) =>
      event.observedAtMs >= segment.startMs &&
      event.observedAtMs < segment.endMs
  );
  const phase = phaseForSegment(
    contained,
    cycles,
    ambiguousWriteAfter,
    reasons
  );
  if (!phase) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    sequence: 0,
    phase,
    startMs: segment.startMs,
    endMs: segment.endMs,
    estimatedCostUsd: segment.costUsd,
    inputTokens: segment.inputTokens,
    outputTokens: segment.outputTokens,
    cacheReadTokens: segment.cacheReadTokens ?? 0,
    cacheWriteTokens: segment.cacheWriteTokens ?? 0,
    evidenceIds: contained.flatMap((event) =>
      event.evidenceId ? [event.evidenceId] : []
    ),
    qualifyingBranchCount: session.branchCount ?? undefined,
    ...(segment.costEvents === undefined
      ? {}
      : { costEvents: segment.costEvents }),
  };
}

function segmentHasSpendEvidence(segment: BranchActivitySegment): boolean {
  return (
    (segment.sourceEventIds?.length ?? 0) > 0 ||
    segment.inputTokens > 0 ||
    segment.outputTokens > 0 ||
    (segment.cacheReadTokens ?? 0) > 0 ||
    (segment.cacheWriteTokens ?? 0) > 0
  );
}

function allocateSessionCostShares(
  segments: readonly BranchPhaseAttributionSegment[],
  sessions: ReadonlyMap<string, MergedSession>
): BranchPhaseAttributionSegment[] {
  const bySession = new Map<string, BranchPhaseAttributionSegment[]>();
  for (const segment of segments) {
    const sessionSegments = bySession.get(segment.sessionId) ?? [];
    sessionSegments.push(segment);
    bySession.set(segment.sessionId, sessionSegments);
  }
  const allocated: BranchPhaseAttributionSegment[] = [];
  for (const [sessionId, sessionSegments] of bySession) {
    sessionSegments.sort(compareProjectedSegments);
    const branchCount = sessions.get(sessionId)?.branchCount;
    if (branchCount === null || branchCount === undefined) {
      continue;
    }
    const rawMicros = sessionSegments.map((segment) =>
      usdToMicroCents(segment.estimatedCostUsd)
    );
    const targetMicros = Math.round(
      rawMicros.reduce((total, micro) => total + micro, 0) / branchCount
    );
    const shares = rawMicros.map((micro) => Math.floor(micro / branchCount));
    let remainder =
      targetMicros - shares.reduce((total, share) => total + share, 0);
    for (let index = 0; index < sessionSegments.length; index += 1) {
      const extraMicro = remainder > 0 ? 1 : 0;
      remainder -= extraMicro;
      allocated.push({
        ...sessionSegments[index],
        estimatedCostUsd: microCentsToUsd(shares[index] + extraMicro),
      });
    }
  }
  return allocated;
}

function phaseForSegment(
  events: readonly NormalizedEvent[],
  cycles: readonly NormalizedCycle[],
  ambiguousWriteAfter: readonly number[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): VisiblePhase | null {
  if (
    events.some((event) => event.kind === LifecycleBoundaryKind.UnknownEvidence)
  ) {
    reasons.add(CompletenessReason.AmbiguousEvidence);
  }
  const reviewEvents = events.filter(
    (event) => event.kind === LifecycleBoundaryKind.ReviewFeedback
  );
  if (reviewEvents.length > 0) {
    const cycleIds = reviewEvents.map((event) => reviewCycleId(event, cycles));
    if (cycleIds.some((cycleId) => cycleId === AMBIGUOUS_CYCLE)) {
      reasons.add(CompletenessReason.AmbiguousEvidence);
      return null;
    }
    if (cycleIds.some((cycleId) => cycleId === null)) {
      reasons.add(CompletenessReason.LifecycleIncomplete);
      return null;
    }
    if (new Set(cycleIds).size === 1) {
      return BranchVisibleLifecyclePhase.Review;
    }
    reasons.add(CompletenessReason.AmbiguousEvidence);
    return null;
  }
  if (events.some((event) => event.kind === LifecycleBoundaryKind.PrRaised)) {
    return BranchVisibleLifecyclePhase.Build;
  }
  const writeEvents = events.filter(
    (event) => event.kind === LifecycleBoundaryKind.BranchWrite
  );
  return writeEvents.length > 0
    ? phaseForWrites(writeEvents, cycles, ambiguousWriteAfter, reasons)
    : null;
}

function phaseForWrites(
  writeEvents: readonly NormalizedEvent[],
  cycles: readonly NormalizedCycle[],
  ambiguousWriteAfter: readonly number[],
  reasons: Set<BranchPhaseAttributionCompletenessReason>
): VisiblePhase | null {
  const activeCycleIds = writeEvents.map((event) =>
    activeCycleId(event.observedAtMs, cycles)
  );
  if (activeCycleIds.some((cycleId) => cycleId === AMBIGUOUS_CYCLE)) {
    reasons.add(CompletenessReason.AmbiguousEvidence);
    return null;
  }
  if (new Set(activeCycleIds).size > 1) {
    reasons.add(CompletenessReason.AmbiguousEvidence);
    return null;
  }
  if (
    writeEvents.some(
      (event, index) =>
        activeCycleIds[index] === null &&
        ambiguousWriteAfter.some((boundary) => event.observedAtMs >= boundary)
    )
  ) {
    reasons.add(CompletenessReason.LifecycleIncomplete);
    return null;
  }
  if (activeCycleIds[0] === null) {
    return BranchVisibleLifecyclePhase.Build;
  }
  const activeCycle = cycles.find(
    (cycle) => cycleIdentity(cycle) === activeCycleIds[0]
  );
  if (
    activeCycle &&
    writeEvents.every((event) => event.observedAtMs === activeCycle.openedAtMs)
  ) {
    return BranchVisibleLifecyclePhase.Build;
  }
  if (
    writeEvents.some(
      (event) => event.method && BRANCH_PUSH_METHODS.has(event.method)
    )
  ) {
    return BranchVisibleLifecyclePhase.Rework;
  }
  reasons.add(CompletenessReason.LifecycleIncomplete);
  return null;
}

function reviewCycleId(
  event: NormalizedEvent,
  cycles: readonly NormalizedCycle[]
): string | typeof AMBIGUOUS_CYCLE | null {
  const activeCycle = activeCycleId(event.observedAtMs, cycles);
  if (activeCycle !== null) {
    return activeCycle;
  }
  const priorCycles = cycles.filter(
    (cycle) => cycle.openedAtMs <= event.observedAtMs
  );
  if (priorCycles.length === 0) {
    return null;
  }
  const latestOpenedAt = Math.max(
    ...priorCycles.map((cycle) => cycle.openedAtMs)
  );
  const latest = priorCycles.filter(
    (cycle) => cycle.openedAtMs === latestOpenedAt
  );
  return latest.length === 1 ? cycleIdentity(latest[0]) : null;
}

const AMBIGUOUS_CYCLE = "ambiguous" as const;

function activeCycleId(
  observedAtMs: number,
  cycles: readonly NormalizedCycle[]
): string | typeof AMBIGUOUS_CYCLE | null {
  const active = cycles.filter(
    (cycle) =>
      cycle.openedAtMs <= observedAtMs &&
      (cycle.terminalAtMs === null || observedAtMs < cycle.terminalAtMs)
  );
  if (active.length > 1) {
    return AMBIGUOUS_CYCLE;
  }
  return active[0] ? cycleIdentity(active[0]) : null;
}

function cycleIdentity(cycle: NormalizedCycle): string {
  return `${cycle.pullRequestId}:${cycle.openedAtMs}`;
}

function buildRollups(
  segments: readonly BranchPhaseAttributionSegment[]
): BranchPhaseAttributionRollup[] {
  const byPhase = new Map<VisiblePhase, MutableRollup>();
  for (const segment of segments) {
    const bucket = getRollupBucket(byPhase, segment.phase);
    bucket.estimatedCostUsd = addUsd(
      bucket.estimatedCostUsd,
      segment.estimatedCostUsd
    );
    bucket.inputTokens += segment.inputTokens;
    bucket.outputTokens += segment.outputTokens;
    bucket.cacheReadTokens += segment.cacheReadTokens;
    bucket.cacheWriteTokens += segment.cacheWriteTokens;
    bucket.intervals.push({ startMs: segment.startMs, endMs: segment.endMs });
    bucket.sessionIds.add(segment.sessionId);
    bucket.sessionCount = bucket.sessionIds.size;
  }
  return visiblePhaseOrder().flatMap((phase) => {
    const bucket = byPhase.get(phase);
    if (!bucket) {
      return [];
    }
    const { intervals, sessionIds: _sessionIds, ...rollup } = bucket;
    return [{ ...rollup, durationMs: unionDurationMs(intervals) }];
  });
}

function getRollupBucket(
  byPhase: Map<VisiblePhase, MutableRollup>,
  phase: VisiblePhase
): MutableRollup {
  const existing = byPhase.get(phase);
  if (existing) {
    return existing;
  }
  const bucket: MutableRollup = {
    phase,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionCount: 0,
    intervals: [],
    sessionIds: new Set<string>(),
  };
  byPhase.set(phase, bucket);
  return bucket;
}

function unionDurationMs(
  intervals: readonly { startMs: number; endMs: number }[]
): number {
  const ordered = [...intervals].sort(
    (left, right) => left.startMs - right.startMs
  );
  let total = 0;
  let activeStart: number | null = null;
  let activeEnd: number | null = null;
  for (const interval of ordered) {
    if (activeStart === null || activeEnd === null) {
      activeStart = interval.startMs;
      activeEnd = interval.endMs;
      continue;
    }
    if (interval.startMs > activeEnd) {
      total += activeEnd - activeStart;
      activeStart = interval.startMs;
      activeEnd = interval.endMs;
      continue;
    }
    activeEnd = Math.max(activeEnd, interval.endMs);
  }
  return activeStart === null || activeEnd === null
    ? total
    : total + activeEnd - activeStart;
}

function buildCoverage(
  reasons: ReadonlySet<BranchPhaseAttributionCompletenessReason>,
  subtotalUsd: number,
  hasProjectedSegments: boolean
): BranchPhaseAttributionResult["coverage"] {
  const reason = reasonPrecedence.find((candidate) => reasons.has(candidate));
  if (!reason) {
    return {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd,
    };
  }
  if (hasProjectedSegments) {
    return {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason,
      subtotalUsd,
    };
  }
  return {
    completeness: BranchPhaseAttributionCompleteness.Unavailable,
    reason,
  };
}

function compareProjectedSegments(
  left: BranchPhaseAttributionSegment,
  right: BranchPhaseAttributionSegment
): number {
  if (left.startMs !== right.startMs) {
    return left.startMs - right.startMs;
  }
  if (left.endMs !== right.endMs) {
    return left.endMs - right.endMs;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function visiblePhaseOrder(): readonly VisiblePhase[] {
  return [
    BranchVisibleLifecyclePhase.Build,
    BranchVisibleLifecyclePhase.Review,
    BranchVisibleLifecyclePhase.Rework,
  ];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addUsd(left: number, right: number): number {
  return microCentsToUsd(usdToMicroCents(left) + usdToMicroCents(right));
}
