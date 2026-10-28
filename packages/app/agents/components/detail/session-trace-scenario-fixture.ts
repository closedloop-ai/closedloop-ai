// gardener-support: test and story data, not shipped
import type { ActivityBucket } from "@repo/api/src/types/agent-session";
import type { ActivityMarker } from "./session-timeline-axis";
import type { SessionTraceItem } from "./session-trace-groups";

/**
 * ISS-8651 — ONE trace scenario, read by every trace component.
 *
 * Before this module each trace component carried its own sample data, so the
 * rows, the dot rail and its hover card could describe DIFFERENT sessions while
 * every suite stayed green: a divergence had nowhere to show up. Here the turn
 * items, the lane markers and the limit dots are all derived from the same
 * instants, rows and labels, so changing one input moves every component that
 * reads it and a disagreement becomes a failing test rather than a silent one.
 *
 * A SIBLING OF `agent-session-detail-fixtures.ts`, NOT AN ADDITION TO IT. That
 * module has no `noExcessiveLinesPerFile` grandfather entry, so the 1,000-line
 * ceiling is enforced on it.
 *
 * The default scenario is deliberately the one ISS-8657 names: a `limit` at
 * 09:01 and a `fail` at 09:04, three minutes apart, with the idle span between
 * them that ISS-8652 renders. Overrides move one input at a time so a test can
 * state what it changed instead of hand-building a second, drifting session.
 */

const SCENARIO_START_ISO = "2026-06-10T09:00:00.000Z";
const SCENARIO_START_MS = Date.parse(SCENARIO_START_ISO);
const SCENARIO_SPAN_MS = 300_000;

const SCENARIO_AGENT_ACTOR = {
  name: "gpt-5.5",
  sessionId: "trace-scenario-session",
  human: null,
  color: "var(--primary)",
  harness: "codex",
};

const SCENARIO_HUMAN_ACTOR = {
  name: null,
  sessionId: "trace-scenario-session",
  human: "Ada Lovelace",
  color: "var(--chart-2)",
};

export type SessionTraceScenarioOverrides = {
  /** Offset from the scenario start at which the rate-limit event fires. */
  limitOffsetMs?: number;
  /** Offset from the scenario start at which the failing tool turn fires. */
  failOffsetMs?: number;
  /** Transcript row the rate-limit event and its dot both resolve to. */
  limitRow?: number;
  /** Transcript row the failing tool turn and its dot both resolve to. */
  failRow?: number;
  /** Text the failing tool card summarises itself with, and its marker label. */
  failSummary?: string;
  /** Text the rate-limit row carries, and its dot's marker label. */
  limitLabel?: string;
  /**
   * Whether the gap between the two trouble events is carried as an `idle` turn
   * item. `false` is the negative case for ISS-8652: the same scenario with no
   * idle span in it at all.
   */
  withIdleSpan?: boolean;
  /**
   * A SECOND idle span, between the last trouble event and the end marker. Set
   * it to give the trace two gaps, which is the only shape that can tell an
   * incrementing idle ordinal from a constant one.
   */
  trailingIdleGapMs?: number;
};

export type SessionTraceScenario = {
  /** Wall-clock instant the scenario's first turn lands on. */
  startMs: number;
  /** The trace's turn items, chronological, as `SessionTrace` consumes them. */
  traceItems: SessionTraceItem[];
  /**
   * The first-pass dot-rail markers (`buildDotCells`' `markers` argument): every
   * marker the strip plots that is not a limit dot.
   */
  markers: ActivityMarker[];
  /** The second-pass limit dots (`buildDotCells`' `limitDotEvents` argument). */
  limitDotEvents: ActivityMarker[];
  /** Milliseconds the idle span covers, whether or not it is carried as a row. */
  idleGapMs: number;
};

export function createSessionTraceScenario(
  overrides: SessionTraceScenarioOverrides = {}
): SessionTraceScenario {
  const {
    failOffsetMs = 240_000,
    failRow = 2,
    failSummary = "Ran 3 tools",
    limitLabel = "Rate limit reached",
    limitOffsetMs = 60_000,
    limitRow = 1,
    trailingIdleGapMs,
    withIdleSpan = true,
  } = overrides;

  const limitMs = SCENARIO_START_MS + limitOffsetMs;
  const failMs = SCENARIO_START_MS + failOffsetMs;
  const idleGapMs = Math.abs(failOffsetMs - limitOffsetMs);

  const limitItem: SessionTraceItem = {
    type: "event",
    _row: limitRow,
    t: new Date(limitMs).toISOString(),
    tMs: limitMs,
    dot: "r",
    text: limitLabel,
  };
  const failItem: SessionTraceItem = {
    type: "tools",
    _row: failRow,
    t: new Date(failMs).toISOString(),
    tMs: failMs,
    endMs: failMs + 12_000,
    cum: 0.42,
    costDelta: 0.42,
    actor: SCENARIO_AGENT_ACTOR,
    summary: failSummary,
    items: [
      {
        label: "Bash",
        detail: "pnpm turbo typecheck",
        err: true,
        detailState: "available",
        input: "pnpm turbo typecheck --filter=...@repo/app",
        output: "1 package failed",
        durationMs: 12_000,
        status: "exit 1",
      },
    ],
    hasFail: true,
    failN: 1,
    cats: { bash: 1 },
  };

  const trouble =
    limitOffsetMs <= failOffsetMs
      ? [limitItem, failItem]
      : [failItem, limitItem];

  return {
    startMs: SCENARIO_START_MS,
    idleGapMs,
    traceItems: [
      {
        type: "prompt",
        _row: 0,
        t: SCENARIO_START_ISO,
        tMs: SCENARIO_START_MS,
        cum: 0,
        actor: SCENARIO_HUMAN_ACTOR,
        text: "Typecheck the affected slice and report what broke.",
      },
      trouble[0],
      ...(withIdleSpan
        ? [{ type: "idle", gap: idleGapMs } as SessionTraceItem]
        : []),
      trouble[1],
      ...(trailingIdleGapMs === undefined
        ? []
        : [{ type: "idle", gap: trailingIdleGapMs } as SessionTraceItem]),
      { type: "end", text: "Session ended" },
    ],
    markers: [
      {
        kind: "fail",
        label: failSummary,
        t: new Date(failMs).toISOString(),
        tl: failRow,
        x: toScenarioPercent(failOffsetMs),
      },
    ],
    limitDotEvents: [
      {
        kind: "limit",
        label: limitLabel,
        t: new Date(limitMs).toISOString(),
        tl: limitRow,
        x: toScenarioPercent(limitOffsetMs),
      },
    ],
  };
}

/** The axis fraction an offset plots at, the coordinate both dot passes share. */
function toScenarioPercent(offsetMs: number): number {
  return (offsetMs / SCENARIO_SPAN_MS) * 100;
}

/**
 * The inert bars a `SessionTimelineDotRail` is mounted over when the test is
 * about the DOTS. Every cost field is zero and `tl0` is the bucket's own index,
 * so nothing here can decide what a dot resolves to.
 *
 * Shared for the reason this module exists (ISS-8651): two suites had each
 * grown a byte-identical private copy, which is how the rail's fixtures drift
 * apart while both stay green.
 */
export function createDotRailStageBuckets(count: number): ActivityBucket[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `${index * 5}m`,
    byModel: {},
    cCache: 0,
    cIn: 0,
    cOut: 0,
    key: `bucket-${index}`,
    tl0: index,
    toolStart: 0,
    total: 0,
  }));
}
