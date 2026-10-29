import { Harness, SessionStatus } from "../../mock";
import type {
  SessionDetail,
  TimelineCostEvent,
  TimelineMarker,
  TraceTurn,
} from "../../mock-detail";

export const TEST_OWNER_NAME = "Dana Owner";

export function buildTestSessionDetail(
  overrides: Partial<SessionDetail> = {}
): SessionDetail {
  return {
    autonomy: null,
    branch: null,
    comments: [],
    costEvents: [],
    costLabel: "$1.00",
    durationLabel: "1h 0m",
    durationMinutes: 60,
    externalSessionId: "ext-1",
    harness: Harness.Claude,
    harnessLabel: "Claude Code",
    id: "session-1",
    linkedArtifacts: [],
    model: "model-a",
    name: "Test session",
    ownerName: TEST_OWNER_NAME,
    prNumber: null,
    prStateLabel: null,
    prTitle: null,
    prUrl: null,
    repo: null,
    startedLabel: "today",
    status: SessionStatus.Completed,
    statusLabel: "Completed",
    timelineEndLabel: "10:00 AM",
    timelineMarkers: [],
    timelineStartLabel: "9:00 AM",
    timelineStartMinutes: 9 * 60,
    tokensLabel: "165k tokens",
    toolCount: 0,
    trace: [],
    turnCount: 0,
    workingDir: "repo",
    ...overrides,
  };
}

export function buildCostEvent(
  overrides: Partial<TimelineCostEvent> = {}
): TimelineCostEvent {
  return {
    atMinutes: 0,
    cCache: 0,
    cIn: 0,
    cOut: 0,
    model: "model-a",
    phase: "Implementation",
    traceRow: 0,
    ...overrides,
  };
}

export function buildMarker(
  overrides: Partial<TimelineMarker> = {}
): TimelineMarker {
  return {
    atMinutes: 0,
    kind: "commit",
    label: "Committed work",
    traceRow: 0,
    ...overrides,
  };
}

export function buildTurn(overrides: Partial<TraceTurn> = {}): TraceTurn {
  return {
    blocks: [{ spans: ["Hello there"], type: "p" }],
    id: "turn-0",
    side: "agent",
    timeLabel: "0:00",
    ...overrides,
  };
}
