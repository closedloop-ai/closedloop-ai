import type { BranchDetail, SessionLane, TimelineColumn } from "./mock";

/** Timing completeness states exercised by the approved Branches prototype. */
export const TimelineCompletenessState = {
  Complete: "complete",
  MixedTimingUnavailable: "mixed_timing_unavailable",
  TimelineLimitOmitted: "timeline_limit_omitted",
  TimingUnavailable: "timing_unavailable",
} as const;

export type TimelineCompletenessState =
  (typeof TimelineCompletenessState)[keyof typeof TimelineCompletenessState];

/** Selectable Branch fixtures that carry explicit timing-source evidence. */
export const TimelineFixtureBranchId = {
  Complete: "br_1281",
  MixedTimingUnavailable: "br_saml",
  TimelineLimitOmitted: "br_dark_mode",
  TimingUnavailable: "br_session_cost",
} as const;

export type TimelineFixtureBranchId =
  (typeof TimelineFixtureBranchId)[keyof typeof TimelineFixtureBranchId];

/**
 * Source-authority links used to prove Branch eligibility without inferring it
 * from a Branch name. Every source Session ID is Branch-qualified and joins a
 * visible lane to the same Branch, project, and repository as the artifact.
 */
export type TimelineEligibilityEvidence = {
  branchArtifact: {
    branchId: string;
    branchName: string;
    projectId: string;
    repositoryId: string;
  };
  repository: {
    defaultBranch: string;
    fullName: string;
    id: string;
  };
  sessionDetails: readonly {
    branchId: string;
    laneId: string;
    projectId: string;
    repositoryId: string;
    sourceSessionId: string;
  }[];
};

type TimelineCompletenessFixtureBase = {
  branchId: TimelineFixtureBranchId;
  eligibility: TimelineEligibilityEvidence;
};

type CompleteTimelineFixture = TimelineCompletenessFixtureBase & {
  state: typeof TimelineCompletenessState.Complete;
  renderedDurationLabel: null;
  nonBucketableSessionIds: readonly [];
  timelineLimitOmittedSessionIds: readonly [];
};

type MixedTimingUnavailableFixture = TimelineCompletenessFixtureBase & {
  state: typeof TimelineCompletenessState.MixedTimingUnavailable;
  renderedDurationLabel: string;
  nonBucketableSessionIds: NonEmptyReadonlyArray<string>;
  timelineLimitOmittedSessionIds: readonly [];
};

type TimelineLimitOmittedFixture = TimelineCompletenessFixtureBase & {
  state: typeof TimelineCompletenessState.TimelineLimitOmitted;
  renderedDurationLabel: string;
  nonBucketableSessionIds: readonly [];
  timelineLimitOmittedSessionIds: NonEmptyReadonlyArray<string>;
};

type TimingUnavailableFixture = TimelineCompletenessFixtureBase & {
  state: typeof TimelineCompletenessState.TimingUnavailable;
  renderedDurationLabel: null;
  nonBucketableSessionIds: NonEmptyReadonlyArray<string>;
  timelineLimitOmittedSessionIds: readonly [];
};

/**
 * State-discriminated fixture contract for ISS-5728 consumers. Rendered labels
 * are timing-only subtotals and never replace immutable lifetime Branch LOC/$;
 * omission lists are required only for the state whose disclosure names them.
 */
export type TimelineCompletenessFixture =
  | CompleteTimelineFixture
  | MixedTimingUnavailableFixture
  | TimelineLimitOmittedFixture
  | TimingUnavailableFixture;

/**
 * Render-only timing values consumed by the prototype. A null disclosure means
 * complete evidence; `hasBars: false` pairs with an honest non-null explanation.
 */
export type TimelineCompletenessProjection = {
  costLabel: string;
  durationLabel: string;
  disclosure: string | null;
  hasBars: boolean;
  noBarsMessage: string | null;
  timeline: BranchDetail["timeline"];
};

type NonEmptyReadonlyArray<Value> = readonly [Value, ...Value[]];

const PROJECT_IDS = {
  Api: "project-closedloop-api",
  Symphony: "project-symphony-alpha",
  Web: "project-closedloop-web",
} as const;

const REPOSITORY_IDS = {
  Api: "repository-closedloop-api",
  Symphony: "repository-symphony-alpha",
  Web: "repository-closedloop-web",
} as const;

const FIXTURES: Readonly<
  Record<TimelineFixtureBranchId, TimelineCompletenessFixture>
> = {
  [TimelineFixtureBranchId.Complete]: {
    branchId: TimelineFixtureBranchId.Complete,
    state: TimelineCompletenessState.Complete,
    renderedDurationLabel: null,
    nonBucketableSessionIds: [],
    timelineLimitOmittedSessionIds: [],
    eligibility: eligibility({
      branchId: TimelineFixtureBranchId.Complete,
      branchName: "agent/inbox-realtime-v2",
      projectId: PROJECT_IDS.Web,
      repositoryDefaultBranch: "main",
      repositoryFullName: "closedloop-ai/closedloop-web",
      repositoryId: REPOSITORY_IDS.Web,
      sessionLaneIds: ["s1", "s2"],
    }),
  },
  [TimelineFixtureBranchId.MixedTimingUnavailable]: {
    branchId: TimelineFixtureBranchId.MixedTimingUnavailable,
    state: TimelineCompletenessState.MixedTimingUnavailable,
    renderedDurationLabel: "3h 46m",
    nonBucketableSessionIds: ["s3"],
    timelineLimitOmittedSessionIds: [],
    eligibility: eligibility({
      branchId: TimelineFixtureBranchId.MixedTimingUnavailable,
      branchName: "agent/saml-sso-implementation",
      projectId: PROJECT_IDS.Symphony,
      repositoryDefaultBranch: "main",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      repositoryId: REPOSITORY_IDS.Symphony,
      sessionLaneIds: ["s1", "s2", "s3"],
    }),
  },
  [TimelineFixtureBranchId.TimelineLimitOmitted]: {
    branchId: TimelineFixtureBranchId.TimelineLimitOmitted,
    state: TimelineCompletenessState.TimelineLimitOmitted,
    renderedDurationLabel: "1h 12m",
    nonBucketableSessionIds: [],
    timelineLimitOmittedSessionIds: ["s2"],
    eligibility: eligibility({
      branchId: TimelineFixtureBranchId.TimelineLimitOmitted,
      branchName: "agent/design-system-dark-mode",
      projectId: PROJECT_IDS.Web,
      repositoryDefaultBranch: "main",
      repositoryFullName: "closedloop-ai/closedloop-web",
      repositoryId: REPOSITORY_IDS.Web,
      sessionLaneIds: ["s1", "s2"],
    }),
  },
  [TimelineFixtureBranchId.TimingUnavailable]: {
    branchId: TimelineFixtureBranchId.TimingUnavailable,
    state: TimelineCompletenessState.TimingUnavailable,
    renderedDurationLabel: null,
    nonBucketableSessionIds: ["s1"],
    timelineLimitOmittedSessionIds: [],
    eligibility: eligibility({
      branchId: TimelineFixtureBranchId.TimingUnavailable,
      branchName: "fix/session-cost-rounding",
      projectId: PROJECT_IDS.Api,
      repositoryDefaultBranch: "develop",
      repositoryFullName: "closedloop-ai/closedloop-api",
      repositoryId: REPOSITORY_IDS.Api,
      sessionLaneIds: ["s1"],
    }),
  },
};

/** Resolve only explicitly registered Branch timing evidence. */
export function resolveTimelineCompletenessFixture(
  detail: BranchDetail
): TimelineCompletenessFixture | null {
  return (
    Object.values(FIXTURES).find(({ branchId }) => branchId === detail.id) ??
    null
  );
}

/** Project timing evidence without changing lifetime Branch cost or LOC/$ data. */
export function projectTimelineCompleteness(
  detail: BranchDetail
): TimelineCompletenessProjection {
  const fixtureValue = resolveTimelineCompletenessFixture(detail);
  if (!fixtureValue) {
    return completeProjection(detail);
  }

  switch (fixtureValue.state) {
    case TimelineCompletenessState.Complete:
      return completeProjection(detail);
    case TimelineCompletenessState.MixedTimingUnavailable:
      return incompleteProjection(
        detail,
        fixtureValue,
        projectChartableTimeline(detail, fixtureValue)
      );
    case TimelineCompletenessState.TimelineLimitOmitted:
      return incompleteProjection(detail, fixtureValue, detail.timeline);
    case TimelineCompletenessState.TimingUnavailable:
      return timingUnavailableProjection(detail, fixtureValue);
    default:
      return assertNever(fixtureValue);
  }
}

function eligibility({
  branchId,
  branchName,
  projectId,
  repositoryDefaultBranch,
  repositoryFullName,
  repositoryId,
  sessionLaneIds,
}: {
  branchId: TimelineFixtureBranchId;
  branchName: string;
  projectId: string;
  repositoryDefaultBranch: string;
  repositoryFullName: string;
  repositoryId: string;
  sessionLaneIds: readonly string[];
}): TimelineEligibilityEvidence {
  return {
    branchArtifact: { branchId, branchName, projectId, repositoryId },
    repository: {
      defaultBranch: repositoryDefaultBranch,
      fullName: repositoryFullName,
      id: repositoryId,
    },
    sessionDetails: sessionLaneIds.map((laneId) => ({
      branchId,
      laneId,
      projectId,
      repositoryId,
      sourceSessionId: `${branchId}:${laneId}`,
    })),
  };
}

function completeProjection(
  detail: BranchDetail
): TimelineCompletenessProjection {
  return {
    costLabel: detail.costLabel,
    durationLabel: detail.wallClockLabel,
    disclosure: detail.costDisclosure,
    hasBars: detail.timeline.columns.length > 0,
    noBarsMessage: null,
    timeline: detail.timeline,
  };
}

function incompleteProjection(
  detail: BranchDetail,
  fixtureValue: MixedTimingUnavailableFixture | TimelineLimitOmittedFixture,
  timeline: BranchDetail["timeline"]
): TimelineCompletenessProjection {
  return {
    costLabel: chartableCostLabel(detail, fixtureValue),
    durationLabel: `${fixtureValue.renderedDurationLabel}*`,
    disclosure: combineDisclosures(
      detail.costDisclosure,
      formatDisclosure(detail.sessions, fixtureValue)
    ),
    hasBars: timeline.columns.length > 0,
    noBarsMessage: null,
    timeline,
  };
}

function chartableCostLabel(
  detail: BranchDetail,
  fixtureValue: MixedTimingUnavailableFixture | TimelineLimitOmittedFixture
): string {
  const omittedIds = new Set([
    ...fixtureValue.nonBucketableSessionIds,
    ...fixtureValue.timelineLimitOmittedSessionIds,
  ]);
  const chartable = detail.sessions.filter(({ id }) => !omittedIds.has(id));
  const known = chartable.flatMap(({ attributedCostUsd }) =>
    attributedCostUsd === undefined || attributedCostUsd === null
      ? []
      : [attributedCostUsd]
  );
  if (known.length === 0) {
    return "Unavailable";
  }
  const subtotal = known.reduce((sum, cost) => sum + cost, 0);
  const formatted = new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(subtotal) ? 0 : 2,
    style: "currency",
  }).format(subtotal);
  return `${formatted}*`;
}

function timingUnavailableProjection(
  detail: BranchDetail,
  fixtureValue: TimingUnavailableFixture
): TimelineCompletenessProjection {
  return {
    costLabel: "Unavailable",
    durationLabel: "Unavailable",
    disclosure: formatDisclosure(detail.sessions, fixtureValue),
    hasBars: false,
    noBarsMessage:
      "Session timing is unavailable, so spend can't be charted by hour.",
    timeline: { ...detail.timeline, columns: [] },
  };
}

function formatDisclosure(
  sessions: readonly SessionLane[],
  fixtureValue: TimelineCompletenessFixture
): string | null {
  const parts: string[] = [];
  if (fixtureValue.nonBucketableSessionIds.length > 0) {
    parts.push(
      `Timing is unavailable for ${sessionLabels(
        sessions,
        fixtureValue.nonBucketableSessionIds
      )}.`
    );
  }
  if (fixtureValue.timelineLimitOmittedSessionIds.length > 0) {
    parts.push(
      `The 90-day timeline limit omits later activity for ${sessionLabels(
        sessions,
        fixtureValue.timelineLimitOmittedSessionIds
      )}.`
    );
  }
  if (parts.length === 0) {
    return null;
  }
  parts.push(
    "Cost and duration include only rendered activity with timing data."
  );
  return `* ${parts.join(" ")}`;
}

function combineDisclosures(
  costDisclosure: string | null,
  timingDisclosure: string | null
): string | null {
  const parts = [costDisclosure, timingDisclosure].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function sessionLabels(
  sessions: readonly SessionLane[],
  sessionIds: readonly string[]
): string {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  return sessionIds
    .map((sessionId) => sessionById.get(sessionId)?.sub.trim() || sessionId)
    .join(", ");
}

function projectChartableTimeline(
  detail: BranchDetail,
  fixtureValue: MixedTimingUnavailableFixture
): BranchDetail["timeline"] {
  const omittedSessionIds = new Set(fixtureValue.nonBucketableSessionIds);
  const columns = detail.timeline.columns.map((column) =>
    omitSessionSegments(column, omittedSessionIds)
  );
  return { ...detail.timeline, columns };
}

function omitSessionSegments(
  column: TimelineColumn,
  omittedSessionIds: ReadonlySet<string>
): TimelineColumn {
  if (column.idle) {
    return column;
  }
  const segments = column.segments.filter(
    ({ sessionId }) => !(sessionId && omittedSessionIds.has(sessionId))
  );
  if (segments.length === 0) {
    return {
      ...column,
      idle: true,
      segments: [],
      tokens: { input: 0, output: 0, cacheRead: 0 },
    };
  }
  const totalPct = segments.reduce((total, { pct }) => total + pct, 0);
  return {
    ...column,
    tokens: {
      input: Math.round((column.tokens.input * totalPct) / 100),
      output: Math.round((column.tokens.output * totalPct) / 100),
      cacheRead: Math.round((column.tokens.cacheRead * totalPct) / 100),
    },
    segments: segments.map((segment) => ({
      ...segment,
      pct: (segment.pct / totalPct) * 100,
    })),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled timeline completeness fixture: ${String(value)}`);
}
