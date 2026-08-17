import {
  type BranchLifecycleBoundary,
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  type BranchLifecyclePhaseSegment,
} from "@repo/api/src/types/branch";

export type BranchLifecyclePhaseEvent = {
  kind: BranchLifecycleBoundaryKind | (string & {});
  observedAt?: string | null;
  evidenceId?: string | null;
};

/**
 * Build ordered same-session lifecycle segments from deterministic boundary
 * events. This helper intentionally ignores `BranchSessionRole`; that role is a
 * whole-session membership/context classifier, not phase attribution.
 */
export function deriveBranchLifecyclePhaseSegments(input: {
  events: readonly BranchLifecyclePhaseEvent[];
  sessionStartedAt?: string | null;
  sessionEndedAt?: string | null;
}): BranchLifecyclePhaseSegment[] {
  const orderedEvents = orderLifecycleEvents(input.events);
  if (orderedEvents.length === 0) {
    return [];
  }

  const state: SegmentBuilderState = {
    segments: [],
    current: input.sessionStartedAt
      ? startSegment(BranchLifecyclePhase.Build, {
          kind: BranchLifecycleBoundaryKind.SessionStart,
          observedAt: input.sessionStartedAt,
        })
      : undefined,
    prRaised: false,
    sessionEnded: false,
  };

  for (const event of orderedEvents) {
    processLifecycleEvent(state, event);
  }

  if (state.current) {
    if (input.sessionEndedAt) {
      closeSegment(state.current, {
        kind: BranchLifecycleBoundaryKind.SessionEnd,
        observedAt: input.sessionEndedAt,
      });
    }
    state.segments.push(state.current);
  }

  return state.segments.map((segment, sequence) =>
    finalizeSegment(segment, sequence)
  );
}

/**
 * Normalize legacy or optional lifecycle fields for consumers. Missing producer
 * support degrades to an empty list; populated segments sort by sequence.
 */
export function normalizeBranchLifecyclePhaseSegments(
  segments: readonly BranchLifecyclePhaseSegment[] | null | undefined
): BranchLifecyclePhaseSegment[] {
  return [...(segments ?? [])].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return compareOptionalTimestamp(left.startedAt, right.startedAt);
  });
}

type OrderedBranchLifecyclePhaseEvent = BranchLifecyclePhaseEvent & {
  inputOrder: number;
};

type MutableBranchLifecyclePhaseSegment = Omit<
  BranchLifecyclePhaseSegment,
  "evidenceIds"
> & {
  evidenceIds: string[];
};

type SegmentBuilderState = {
  segments: MutableBranchLifecyclePhaseSegment[];
  current: MutableBranchLifecyclePhaseSegment | undefined;
  prRaised: boolean;
  sessionEnded: boolean;
};

const branchLifecycleBoundaryKinds = new Set<string>(
  Object.values(BranchLifecycleBoundaryKind)
);

function orderLifecycleEvents(
  events: readonly BranchLifecyclePhaseEvent[]
): OrderedBranchLifecyclePhaseEvent[] {
  return events
    .map((event, inputOrder) => ({ ...event, inputOrder }))
    .sort((left, right) => {
      const timestampOrder = compareOptionalTimestamp(
        left.observedAt,
        right.observedAt
      );
      return timestampOrder === 0
        ? left.inputOrder - right.inputOrder
        : timestampOrder;
    });
}

function compareOptionalTimestamp(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  const leftTime = timestampSortValue(left);
  const rightTime = timestampSortValue(right);
  return leftTime === rightTime ? 0 : leftTime - rightTime;
}

function timestampSortValue(value: string | null | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function startSegment(
  phase: BranchLifecyclePhase,
  boundary: BranchLifecycleBoundary
): MutableBranchLifecyclePhaseSegment {
  return {
    sequence: 0,
    phase,
    startedAt: boundary.observedAt,
    startBoundary: boundary,
    evidenceIds: [],
  };
}

function closeSegment(
  segment: MutableBranchLifecyclePhaseSegment,
  boundary: BranchLifecycleBoundary
): void {
  segment.endedAt = boundary.observedAt;
  segment.endBoundary = boundary;
}

function appendEvidence(
  segment: MutableBranchLifecyclePhaseSegment,
  event: BranchLifecyclePhaseEvent
): void {
  if (event.evidenceId) {
    segment.evidenceIds.push(event.evidenceId);
  }
}

function toBoundary(
  event: BranchLifecyclePhaseEvent,
  kind: BranchLifecycleBoundaryKind
): BranchLifecycleBoundary {
  return {
    kind,
    ...(event.observedAt ? { observedAt: event.observedAt } : {}),
    ...(event.evidenceId ? { evidenceId: event.evidenceId } : {}),
  };
}

function processLifecycleEvent(
  state: SegmentBuilderState,
  event: BranchLifecyclePhaseEvent
): void {
  if (state.sessionEnded) {
    return;
  }
  const kind = normalizeBoundaryKind(event.kind);
  const boundary = toBoundary(event, kind);
  if (kind === BranchLifecycleBoundaryKind.SessionStart) {
    state.current ??= startSegment(BranchLifecyclePhase.Build, boundary);
    return;
  }
  if (kind === BranchLifecycleBoundaryKind.PrRaised) {
    handlePrRaisedEvent(state, event, boundary);
    return;
  }
  if (kind === BranchLifecycleBoundaryKind.SessionEnd) {
    handleSessionEndEvent(state, boundary);
    return;
  }
  appendPhaseEvent(state, event, boundary, kind);
}

function handlePrRaisedEvent(
  state: SegmentBuilderState,
  event: BranchLifecyclePhaseEvent,
  boundary: BranchLifecycleBoundary
): void {
  if (state.prRaised) {
    return;
  }
  if (state.current?.phase !== BranchLifecyclePhase.Build) {
    closeCurrentSegment(state, boundary);
    state.current = startSegment(BranchLifecyclePhase.Build, boundary);
  }
  appendEvidence(state.current, event);
  closeCurrentSegment(state, boundary);
  state.prRaised = true;
}

function handleSessionEndEvent(
  state: SegmentBuilderState,
  boundary: BranchLifecycleBoundary
): void {
  closeCurrentSegment(state, boundary);
  state.sessionEnded = true;
}

function appendPhaseEvent(
  state: SegmentBuilderState,
  event: BranchLifecyclePhaseEvent,
  boundary: BranchLifecycleBoundary,
  kind: BranchLifecycleBoundaryKind
): void {
  const phase = phaseForEvent(kind, state.prRaised);
  dropEmptyBuildBeforeUnknown(state, phase);
  if (!state.current) {
    state.current = startSegment(phase, boundary);
    appendEvidence(state.current, event);
    return;
  }
  if (state.current.phase === phase) {
    appendEvidence(state.current, event);
    return;
  }
  closeCurrentSegment(state, boundary);
  state.current = startSegment(phase, boundary);
  appendEvidence(state.current, event);
}

function closeCurrentSegment(
  state: SegmentBuilderState,
  boundary: BranchLifecycleBoundary
): void {
  if (!state.current) {
    return;
  }
  closeSegment(state.current, boundary);
  state.segments.push(state.current);
  state.current = undefined;
}

function dropEmptyBuildBeforeUnknown(
  state: SegmentBuilderState,
  nextPhase: BranchLifecyclePhase
): void {
  if (
    state.current?.phase === BranchLifecyclePhase.Build &&
    state.current.evidenceIds.length === 0 &&
    nextPhase === BranchLifecyclePhase.Unknown
  ) {
    state.current = undefined;
  }
}

function normalizeBoundaryKind(kind: BranchLifecyclePhaseEvent["kind"]) {
  return branchLifecycleBoundaryKinds.has(kind)
    ? (kind as BranchLifecycleBoundaryKind)
    : BranchLifecycleBoundaryKind.UnknownEvidence;
}

function phaseForEvent(
  kind: BranchLifecycleBoundaryKind,
  prRaised: boolean
): BranchLifecyclePhase {
  if (!prRaised) {
    return kind === BranchLifecycleBoundaryKind.ReadOnlyReference ||
      kind === BranchLifecycleBoundaryKind.UnknownEvidence
      ? BranchLifecyclePhase.Unknown
      : BranchLifecyclePhase.Build;
  }
  if (kind === BranchLifecycleBoundaryKind.ReviewFeedback) {
    return BranchLifecyclePhase.Review;
  }
  if (kind === BranchLifecycleBoundaryKind.BranchWrite) {
    return BranchLifecyclePhase.Rework;
  }
  return BranchLifecyclePhase.Unknown;
}

function finalizeSegment(
  segment: MutableBranchLifecyclePhaseSegment,
  sequence: number
): BranchLifecyclePhaseSegment {
  const { evidenceIds, ...segmentWithoutEvidenceIds } = segment;
  return {
    ...segmentWithoutEvidenceIds,
    sequence,
    ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
  };
}
