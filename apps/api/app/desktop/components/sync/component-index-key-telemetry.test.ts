/**
 * ISS-8255 (#7213 review, whitlockk): the components-sync lane's USE of the shared
 * org/reason choke point.
 *
 * The engine has its own suite; this one exists because that suite would stay
 * green if the gate call were deleted from this lane (AGENTS.md: a new helper
 * needs an assertion that its production caller actually invokes it). Every
 * case below drives `reportComponentIndexKeyProjections` itself.
 */
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
  COMPONENT_INDEX_KEY_PROJECTED_EVENT,
  COMPONENT_INDEX_KEY_PROJECTED_MESSAGE,
  componentIndexKeyProjectionGate,
  reportComponentIndexKeyProjections,
} from "./component-index-key-telemetry";

const ORGANIZATION_ID = "org-1";
const COMPUTE_TARGET_ID = "target-1";
const NOW = 1_700_000_000_000;

function scope(computeTargetId: string = COMPUTE_TARGET_ID) {
  return { organizationId: ORGANIZATION_ID, computeTargetId };
}

function projectionWarns(): Record<string, unknown>[] {
  return mocks.logWarn.mock.calls
    .filter(([message]) => message === COMPONENT_INDEX_KEY_PROJECTED_MESSAGE)
    .map(([, payload]) => payload as Record<string, unknown>);
}

function projectionEmissions(): { metric?: string }[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg as { metric?: string })
    .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);
}

describe("reportComponentIndexKeyProjections emission bound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The gate is a module-level latch: without this reset the first case would
    // spend the window and every later one would assert against a suppressed
    // emission (AGENTS.md).
    componentIndexKeyProjectionGate.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  // Unconditional: a case that installs fake timers must not leak a frozen
  // clock into its siblings when an assertion throws (AGENTS.md).
  afterEach(() => {
    vi.useRealTimers();
    componentIndexKeyProjectionGate.clear();
  });

  it("emits the first occurrence with the monitored event facet", () => {
    reportComponentIndexKeyProjections(scope(), 3);

    expect(projectionWarns()).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        event: COMPONENT_INDEX_KEY_PROJECTED_EVENT,
        projectedCount: 3,
        occurrences: 1,
      },
    ]);
    expect(projectionEmissions()).toEqual([
      {
        metric: INDEX_KEY_PROJECTED_METRIC,
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        count: 3,
      },
    ]);
  });

  it("suppresses the replay of the same (org, compute target) inside the window", () => {
    reportComponentIndexKeyProjections(scope(), 3);
    reportComponentIndexKeyProjections(scope(), 3);
    reportComponentIndexKeyProjections(scope(), 3);

    // Removing the gate call from the production path makes this three — which
    // is the unbounded per-request emission this lane shipped with.
    expect(projectionWarns()).toHaveLength(1);
    expect(projectionEmissions()).toHaveLength(1);
  });

  it("never suppresses a first occurrence from another tenant", () => {
    reportComponentIndexKeyProjections(scope(), 3);
    reportComponentIndexKeyProjections(
      {
        organizationId: `${ORGANIZATION_ID}-other`,
        computeTargetId: COMPUTE_TARGET_ID,
      },
      3
    );

    expect(projectionWarns()).toHaveLength(2);
  });

  it("carries the suppressed total as an aggregated rollup when the window rolls over", () => {
    reportComponentIndexKeyProjections(scope(), 3);
    reportComponentIndexKeyProjections(scope(), 3);
    reportComponentIndexKeyProjections(scope(), 3);

    vi.setSystemTime(new Date(NOW + FIXED_WINDOW_EMISSION_WINDOW_MS + 1));
    reportComponentIndexKeyProjections(scope(), 3);

    const rollups = projectionWarns().filter(
      (warn) => warn.aggregated === true
    );
    // A real count of what the closed window actually suppressed, not an
    // estimate: two replays were eaten, so the rollup carries exactly two.
    expect(rollups).toEqual([
      {
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        event: COMPONENT_INDEX_KEY_PROJECTED_EVENT,
        occurrences: 2,
        aggregated: true,
        flushedBy: "window",
      },
    ]);
    // The rollup raises no metric: `count` there means KEYS BOUND in one batch,
    // and an occurrence total would corrupt that cross-lane tally.
    expect(projectionEmissions()).toHaveLength(2);
  });

  it("stays silent on a zero tally", () => {
    reportComponentIndexKeyProjections(scope(), 0);

    // Emitting on zero would measure traffic rather than the trade-off.
    expect(projectionWarns()).toEqual([]);
    expect(projectionEmissions()).toEqual([]);
  });

  it("never throws when the bound itself fails", () => {
    const recordSpy = vi
      .spyOn(componentIndexKeyProjectionGate, "record")
      .mockImplementation(() => {
        throw new Error("throttle exploded");
      });

    // The keys are already projected and already committed by the time this
    // runs, so a reporting failure must not change either.
    expect(() => reportComponentIndexKeyProjections(scope(), 3)).not.toThrow();
    expect(projectionEmissions()).toEqual([]);
    recordSpy.mockRestore();
  });
});
