// Mock data for the expandable Cost breakdown prototype. One branch
// (feat/streaming-csv-export) whose spend is split across lifecycle phases,
// each with the sessions that contributed to it.
//
// Fidelity notes for whoever productionizes this (raised in review):
// - Phases mirror the source screenshot's Build / Review / Rework split, which
//   the production panel has since superseded with the per-activity taxonomy
//   (Explore, Plan, Implement, Review, Validate, Rework, Other, Idle) plus an
//   Unattributed residual. The canonical label + token color live in
//   getActivityPhaseDisplay (packages/app/branches/lib/activity-taxonomy-display.ts);
//   map to it rather than carrying these names or colors forward.
// - The real model exposes a whole-session estimatedCostUsd and allocates cost
//   across phases by duration; it does NOT expose a per-session/per-phase cost.
//   So a session is modeled here as belonging to a single phase (a simplification)
//   and the expanded rows do NOT print a per-phase cost — the whole-session cost
//   shows only on the session detail. Phase and headline costs are DERIVED by
//   summing sessions so they always reconcile (pinned in phase-breakdown.test.ts).
// - Unattributed carries the sessions whose activity could not be attributed to a
//   phase, so the phase session counts still reconcile with the branch total.

export const PhaseKey = {
  Build: "build",
  Review: "review",
  Rework: "rework",
  Unattributed: "unattributed",
} as const;
export type PhaseKey = (typeof PhaseKey)[keyof typeof PhaseKey];

export const SessionStatus = {
  Completed: "completed",
  Active: "active",
  Failed: "failed",
} as const;
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export type PhaseSession = {
  /** External session id, rendered as the clickable link target. */
  id: string;
  title: string;
  owner: string;
  model: string;
  status: SessionStatus;
  durationMinutes: number;
  durationLabel: string;
  /** Whole-session estimated cost (the real API field), shown only on detail. */
  costUsd: number;
  costLabel: string;
  startedLabel: string;
};

export type CostPhase = {
  key: PhaseKey;
  label: string;
  color: string;
  /** Summed wall-clock across the phase's sessions. */
  totalLabel: string;
  /** Wall-clock the phase spanned on the lead-time line; absent when the phase
   *  has no place on the timeline (Unattributed). */
  elapsedLabel: string | null;
  costUsd: number;
  costLabel: string;
  pct: number;
  sessions: readonly PhaseSession[];
};

export type LeadSegmentKey = PhaseKey | "idle";

export type LeadSegment = { key: LeadSegmentKey; pct: number };

export type LeadLegendItem = {
  key: LeadSegmentKey;
  label: string;
  value: string;
};

// Phase swatch colors are design-system tokens (themed for light + dark), never
// bespoke hex — matching getActivityPhaseDisplay: work phases use the chart
// palette, Rework keeps the danger-red semantic, Unattributed is neutral grey.
const PHASE_COLOR: Record<PhaseKey, string> = {
  [PhaseKey.Build]: "var(--chart-1)",
  [PhaseKey.Review]: "var(--chart-8)",
  [PhaseKey.Rework]: "var(--destructive)",
  [PhaseKey.Unattributed]:
    "color-mix(in oklab, var(--muted-foreground) 64%, transparent)",
};

const PHASE_LABEL: Record<PhaseKey, string> = {
  [PhaseKey.Build]: "Build",
  [PhaseKey.Review]: "Review",
  [PhaseKey.Rework]: "Rework",
  [PhaseKey.Unattributed]: "Unattributed",
};

export const PHASE_COPY: Record<PhaseKey, string> = {
  [PhaseKey.Build]:
    "Token cost and sessions from the first code pushed to GitHub until the pull request is opened.",
  [PhaseKey.Review]:
    "Token cost and sessions after the pull request is opened when the session contributes review comments but does not push new commits.",
  [PhaseKey.Rework]:
    "Token cost and sessions after the pull request is opened when the session pushes one or more new commits.",
  [PhaseKey.Unattributed]:
    "Sessions whose activity could not be attributed to a phase (no phase segments captured). Their spend is tracked here so the phase session counts still reconcile with the branch total.",
};

export const SESSION_STATUS_META: Record<
  SessionStatus,
  { label: string; variant: "muted" | "info" | "destructive" }
> = {
  [SessionStatus.Completed]: { label: "Completed", variant: "muted" },
  [SessionStatus.Active]: { label: "Active", variant: "info" },
  [SessionStatus.Failed]: { label: "Failed", variant: "destructive" },
};

export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function makeSession(
  id: string,
  title: string,
  owner: string,
  model: string,
  durationMinutes: number,
  costUsd: number,
  startedLabel: string,
  status: SessionStatus = SessionStatus.Completed
): PhaseSession {
  return {
    id,
    title,
    owner,
    model,
    status,
    durationMinutes,
    durationLabel: formatMinutes(durationMinutes),
    costUsd,
    costLabel: formatUsd(costUsd),
    startedLabel,
  };
}

const buildSessions: readonly PhaseSession[] = [
  makeSession(
    "cs_9f21",
    "Scaffold streaming CSV export route",
    "Alex Rivera",
    "claude-opus-4-8",
    28,
    19.9,
    "5h ago"
  ),
  makeSession(
    "cs_a3d7",
    "Add ReadableStream response writer",
    "Alex Rivera",
    "claude-opus-4-8",
    42,
    25.6,
    "4h 52m ago"
  ),
  makeSession(
    "cs_2b14",
    "Wire cursor pagination into exporter",
    "Sam Chen",
    "claude-sonnet-5",
    12,
    8.6,
    "4h 40m ago"
  ),
  makeSession(
    "cs_77ce",
    "Implement row serializer and escaping",
    "Priya Nair",
    "claude-opus-4-8",
    19,
    13.2,
    "4h 20m ago"
  ),
  makeSession(
    "cs_5e08",
    "Add backpressure handling",
    "Alex Rivera",
    "claude-opus-4-8",
    35,
    24.3,
    "4h ago"
  ),
  makeSession(
    "cs_c491",
    "Clamp export batch size (floor 1, ceiling 500)",
    "Sam Chen",
    "claude-sonnet-5",
    15,
    10.4,
    "3h 40m ago"
  ),
  makeSession(
    "cs_1a6f",
    "Add export config const-object enum",
    "Jordan Lee",
    "claude-haiku-4-5",
    8,
    5.2,
    "3h 28m ago",
    SessionStatus.Failed
  ),
  makeSession(
    "cs_b820",
    "Handle empty result set",
    "Priya Nair",
    "claude-sonnet-5",
    24,
    17.7,
    "3h 10m ago"
  ),
  makeSession(
    "cs_d3a2",
    "Add column header mapping",
    "Alex Rivera",
    "claude-opus-4-8",
    31,
    21.8,
    "2h 48m ago"
  ),
  makeSession(
    "cs_44b9",
    "Stream gzip compression",
    "Sam Chen",
    "claude-opus-4-8",
    11,
    7.1,
    "2h 30m ago"
  ),
  makeSession(
    "cs_6fd1",
    "Add abort-signal cancellation",
    "Priya Nair",
    "claude-opus-4-8",
    22,
    14.9,
    "2h 12m ago"
  ),
  makeSession(
    "cs_08ac",
    "Unit tests for serializer",
    "Jordan Lee",
    "claude-sonnet-5",
    16,
    11.3,
    "1h 55m ago"
  ),
  makeSession(
    "cs_e277",
    "Integration test for export route",
    "GitHub Actions",
    "claude-sonnet-5",
    27,
    17.6,
    "1h 40m ago"
  ),
  makeSession(
    "cs_3c50",
    "Add rate-limit guard",
    "Sam Chen",
    "claude-haiku-4-5",
    9,
    6.4,
    "1h 22m ago"
  ),
  makeSession(
    "cs_9b6e",
    "Fix off-by-one in cursor advance",
    "Alex Rivera",
    "claude-opus-4-8",
    14,
    9.8,
    "1h 05m ago"
  ),
  makeSession(
    "cs_71f4",
    "Add telemetry for export duration",
    "Priya Nair",
    "claude-sonnet-5",
    6,
    4.2,
    "52m ago"
  ),
];

const reviewSessions: readonly PhaseSession[] = [
  makeSession(
    "cs_re10",
    "Review streaming exporter design",
    "Sam Chen",
    "claude-opus-4-8",
    12,
    6.2,
    "48m ago"
  ),
  makeSession(
    "cs_re22",
    "Review serializer escaping edge cases",
    "Priya Nair",
    "claude-sonnet-5",
    7,
    3.4,
    "44m ago"
  ),
  makeSession(
    "cs_re31",
    "Review batch-size clamp",
    "Jordan Lee",
    "claude-sonnet-5",
    9,
    4.1,
    "41m ago"
  ),
  makeSession(
    "cs_re48",
    "Review test coverage",
    "Sam Chen",
    "claude-opus-4-8",
    8,
    3.8,
    "38m ago"
  ),
  makeSession(
    "cs_re55",
    "Address reviewer nits and approve",
    "Priya Nair",
    "claude-haiku-4-5",
    6,
    2.5,
    "35m ago"
  ),
];

const reworkSessions: readonly PhaseSession[] = [
  makeSession(
    "cs_rw05",
    "Rework cursor advance after review",
    "Alex Rivera",
    "claude-opus-4-8",
    9,
    5.1,
    "33m ago"
  ),
  makeSession(
    "cs_rw12",
    "Split serializer into helpers",
    "Priya Nair",
    "claude-opus-4-8",
    8,
    4.6,
    "28m ago"
  ),
  makeSession(
    "cs_rw19",
    "Add missing empty-org test",
    "Jordan Lee",
    "claude-sonnet-5",
    7,
    3.9,
    "24m ago"
  ),
  makeSession(
    "cs_rw26",
    "Fix gzip flush on cancel",
    "Alex Rivera",
    "claude-opus-4-8",
    7,
    4.4,
    "20m ago",
    SessionStatus.Active
  ),
];

// Omitted-segments sessions: work ran but no phase segments were captured, so
// the collector could not attribute it. They still count against the branch.
const unattributedSessions: readonly PhaseSession[] = [
  makeSession(
    "cs_un01",
    "Exploratory session, no commits pushed",
    "Alex Rivera",
    "claude-sonnet-5",
    13,
    5.4,
    "3h 55m ago"
  ),
  makeSession(
    "cs_un02",
    "Interrupted before first push",
    "Jordan Lee",
    "claude-haiku-4-5",
    6,
    3.6,
    "2h 05m ago",
    SessionStatus.Failed
  ),
];

// The lead-time line is one timeline (minutes), so the bar widths, the header
// total, the idle percentage, and the phase "elapsed" labels are all DERIVED
// from it and cannot drift apart. Idle is a real segment, not a legend-only
// swatch. (Mirrors how the Branches prototype aligns phase durations.)
const LEAD_TIMELINE: readonly { key: LeadSegmentKey; minutes: number }[] = [
  { key: PhaseKey.Build, minutes: 75 },
  { key: "idle", minutes: 16 },
  { key: PhaseKey.Review, minutes: 7 },
  { key: PhaseKey.Rework, minutes: 6 },
];

const LEAD_LABEL: Record<LeadSegmentKey, string> = {
  ...PHASE_LABEL,
  idle: "Idle / waiting",
};

function buildCostPhase(
  key: PhaseKey,
  sessions: readonly PhaseSession[],
  headlineCostUsd: number,
  elapsedMinutesByPhase: Map<PhaseKey, number>
): CostPhase {
  const costUsd = sessions.reduce((sum, session) => sum + session.costUsd, 0);
  const durationMinutes = sessions.reduce(
    (sum, session) => sum + session.durationMinutes,
    0
  );
  const elapsedMinutes = elapsedMinutesByPhase.get(key);
  return {
    key,
    label: PHASE_LABEL[key],
    color: PHASE_COLOR[key],
    totalLabel: formatMinutes(durationMinutes),
    elapsedLabel:
      elapsedMinutes === undefined ? null : formatMinutes(elapsedMinutes),
    costUsd,
    costLabel: `$${Math.round(costUsd)}`,
    pct: Math.round((costUsd / headlineCostUsd) * 100),
    sessions,
  };
}

const PHASE_SESSIONS: readonly {
  key: PhaseKey;
  sessions: readonly PhaseSession[];
}[] = [
  { key: PhaseKey.Build, sessions: buildSessions },
  { key: PhaseKey.Review, sessions: reviewSessions },
  { key: PhaseKey.Rework, sessions: reworkSessions },
  { key: PhaseKey.Unattributed, sessions: unattributedSessions },
];

const ELAPSED_MINUTES_BY_PHASE = new Map<PhaseKey, number>(
  LEAD_TIMELINE.filter(
    (segment): segment is { key: PhaseKey; minutes: number } =>
      segment.key !== "idle"
  ).map((segment) => [segment.key, segment.minutes])
);

export const headlineCostUsd: number = PHASE_SESSIONS.reduce(
  (sum, phase) =>
    sum + phase.sessions.reduce((phaseSum, s) => phaseSum + s.costUsd, 0),
  0
);

export const headlineCostLabel = `$${Math.round(headlineCostUsd)}`;

export const costPhases: readonly CostPhase[] = PHASE_SESSIONS.map((phase) =>
  buildCostPhase(
    phase.key,
    phase.sessions,
    headlineCostUsd,
    ELAPSED_MINUTES_BY_PHASE
  )
);

const leadTotalMinutes = LEAD_TIMELINE.reduce(
  (sum, segment) => sum + segment.minutes,
  0
);

const leadBuildMinutes =
  LEAD_TIMELINE.find((segment) => segment.key === PhaseKey.Build)?.minutes ?? 0;

const leadIdleMinutes = LEAD_TIMELINE.reduce(
  (sum, segment) => (segment.key === "idle" ? sum + segment.minutes : sum),
  0
);

export const leadTimeLabel = formatMinutes(leadTotalMinutes);
export const leadIdlePct = Math.round(
  (leadIdleMinutes / leadTotalMinutes) * 100
);
export const leadPrOpenedPct = Math.round(
  (leadBuildMinutes / leadTotalMinutes) * 100
);

export const leadSegments: readonly LeadSegment[] = LEAD_TIMELINE.map(
  (segment) => ({
    key: segment.key,
    pct: Math.round((segment.minutes / leadTotalMinutes) * 100),
  })
);

export const leadLegend: readonly LeadLegendItem[] = LEAD_TIMELINE.map(
  (segment) => ({
    key: segment.key,
    label: LEAD_LABEL[segment.key],
    value: formatMinutes(segment.minutes),
  })
);

export function leadSegmentColor(key: LeadSegmentKey): string | null {
  return key === "idle" ? null : PHASE_COLOR[key];
}

export function findSession(id: string): PhaseSession | undefined {
  for (const phase of costPhases) {
    const match = phase.sessions.find((session) => session.id === id);
    if (match) {
      return match;
    }
  }
  return undefined;
}
