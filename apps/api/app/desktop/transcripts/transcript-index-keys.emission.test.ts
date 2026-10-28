import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.logWarn, error: vi.fn(), info: vi.fn() },
}));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { INDEX_KEY_PROJECTED_METRIC } from "@/lib/index-key-projection";
import { FIXED_WINDOW_EMISSION_WINDOW_MS } from "@/lib/observability/fixed-window-emission-throttle";
import {
  reportTranscriptIndexKeyProjections,
  TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
  TRANSCRIPT_INDEX_KEY_PROJECTED_MESSAGE,
  transcriptIndexKeyProjectionGate,
} from "./transcript-index-keys";

const ORGANIZATION_ID = "org-1";
const COMPUTE_TARGET_ID = "target-1";
const NOW = 1_700_000_000_000;

function projected(overrides: { computeTargetId?: string } = {}) {
  return {
    computeTargetId: overrides.computeTargetId ?? COMPUTE_TARGET_ID,
    externalSessionId: "projected-sid",
    fileKey: "projected-file",
    projectedCount: 2,
  };
}

function projectionWarns(): Record<string, unknown>[] {
  return mocks.logWarn.mock.calls
    .filter(([message]) => message === TRANSCRIPT_INDEX_KEY_PROJECTED_MESSAGE)
    .map(([, payload]) => payload as Record<string, unknown>);
}

function projectionEmissions(): { metric?: string }[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg as { metric?: string })
    .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);
}

/**
 * ISS-8255: the transcript lane's USE of the shared org/reason choke point.
 *
 * The engine has its own suite; this one exists because that suite would stay
 * green if the gate call were deleted from this lane (AGENTS.md: a new helper
 * needs an assertion that its production caller actually invokes it). Every
 * case below drives `reportTranscriptIndexKeyProjections` itself.
 */
describe("reportTranscriptIndexKeyProjections emission bound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Without this reset the first case would spend the window and every later
    // one would assert against a suppressed emission.
    transcriptIndexKeyProjectionGate.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  // Unconditional: a case that installs fake timers must not leak a frozen
  // clock into its siblings when an assertion throws (AGENTS.md).
  afterEach(() => {
    vi.useRealTimers();
    transcriptIndexKeyProjectionGate.clear();
  });

  it("emits the first occurrence with the monitored event facet", () => {
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());

    expect(projectionWarns()).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        event: TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
        projectedCount: 2,
        occurrences: 1,
      },
    ]);
    expect(projectionEmissions()).toEqual([
      {
        metric: INDEX_KEY_PROJECTED_METRIC,
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        count: 2,
      },
    ]);
  });

  it("suppresses the replay of the same (org, compute target) inside the window", () => {
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());

    // Deleting the gate call from the production path makes this three.
    expect(projectionWarns()).toHaveLength(1);
    expect(projectionEmissions()).toHaveLength(1);
  });

  it("never suppresses a first occurrence from another tenant", () => {
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());
    reportTranscriptIndexKeyProjections(
      `${ORGANIZATION_ID}-other`,
      projected()
    );

    expect(projectionWarns()).toHaveLength(2);
  });

  it("carries the suppressed total as an aggregated rollup when the window rolls over", () => {
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());

    vi.setSystemTime(new Date(NOW + FIXED_WINDOW_EMISSION_WINDOW_MS + 1));
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected());

    const rollups = projectionWarns().filter(
      (warn) => warn.aggregated === true
    );
    // A real count of what the closed window actually suppressed, not an
    // estimate: two replays were eaten, so the rollup carries exactly two.
    expect(rollups).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        event: TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
        occurrences: 2,
        aggregated: true,
        flushedBy: "window",
      },
    ]);
    // The rollup raises no metric: `count` there means KEYS BOUND on one
    // request, and an occurrence total would corrupt that cross-lane tally.
    expect(projectionEmissions()).toHaveLength(2);
  });

  it("stays silent on a zero tally", () => {
    reportTranscriptIndexKeyProjections(ORGANIZATION_ID, {
      ...projected(),
      projectedCount: 0,
    });

    // Emitting on zero would measure traffic rather than the trade-off.
    expect(projectionWarns()).toEqual([]);
    expect(projectionEmissions()).toEqual([]);
  });

  it("never throws when the bound itself fails", () => {
    const recordSpy = vi
      .spyOn(transcriptIndexKeyProjectionGate, "record")
      .mockImplementation(() => {
        throw new Error("throttle exploded");
      });

    // The identity is already projected and the write already decided by the
    // time this runs, so a reporting failure must not change either.
    expect(() =>
      reportTranscriptIndexKeyProjections(ORGANIZATION_ID, projected())
    ).not.toThrow();
    expect(projectionEmissions()).toEqual([]);
    recordSpy.mockRestore();
  });
});
