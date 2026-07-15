import { describe, expect, it } from "vitest";
import {
  SessionTraceCorrectionSourceKind as ContractSessionTraceCorrectionKind,
  SessionTracePhaseSourceType as ContractSessionTracePhaseSourceType,
  SessionTraceThrottleSourceType as ContractSessionTraceThrottleSourceType,
} from "../types/agent-session.ts";
import { PullRequestState } from "../types/document.ts";
import {
  AutonomyLabel,
  clampMarkerLabel,
  deriveAutonomyAndSteering,
  derivePrLifecycleStatus,
  deriveSessionTracePresentation,
  getAutonomyLabel,
  SESSION_TRACE_SOURCE_LIMITS,
  SessionPrLifecycleStatus,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "./derivation.js";

describe("Session Trace derivation", () => {
  it("exports Session Trace source contract values from the shared type module", () => {
    expect(SessionTracePhaseSourceType).toBe(
      ContractSessionTracePhaseSourceType
    );
    expect(SessionTraceThrottleSourceType).toBe(
      ContractSessionTraceThrottleSourceType
    );
    expect(SessionTraceCorrectionKind).toBe(ContractSessionTraceCorrectionKind);
  });

  it("FEA-2986: clampMarkerLabel bounds labels to the shared marker-label cap", () => {
    // The cap must match the cloud's sessionMarkerSchema.label `.max(...)`.
    expect(SESSION_TRACE_SOURCE_LIMITS.markerLabel).toBe(300);

    const short = "PR #42 opened: fix the thing";
    expect(clampMarkerLabel(short)).toBe(short);

    const exact = "a".repeat(SESSION_TRACE_SOURCE_LIMITS.markerLabel);
    expect(clampMarkerLabel(exact)).toBe(exact);

    const overlong = "b".repeat(SESSION_TRACE_SOURCE_LIMITS.markerLabel + 250);
    const clamped = clampMarkerLabel(overlong);
    expect(clamped.length).toBe(SESSION_TRACE_SOURCE_LIMITS.markerLabel);
    expect(overlong.startsWith(clamped)).toBe(true);

    // Trims before slicing so it agrees with the cloud's `.trim().max()`: a
    // label whose real content sits behind >cap leading whitespace must not be
    // sliced down to pure whitespace (which the cloud would trim to empty and
    // reject via `.min(1)`).
    const leadingWhitespace = `${" ".repeat(
      SESSION_TRACE_SOURCE_LIMITS.markerLabel
    )}fixed the bug   `;
    expect(clampMarkerLabel(leadingWhitespace)).toBe("fixed the bug");
  });

  it("derives steering and autonomy from timestamps without prompt text", () => {
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:10:00.000Z",
        "2026-06-16T10:20:00.000Z",
      ],
      activityTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:15:00.000Z",
        "2026-06-16T10:30:00.000Z",
      ],
    });

    expect(result.steeringEpisodes).toBe(2);
    expect(result.autonomy).toBe(83);
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Agentic);
  });

  it("returns unknown autonomy when prompt or activity basis is absent", () => {
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [],
      activityTimestamps: ["2026-06-16T10:00:00.000Z"],
    });

    expect(result).toEqual({ autonomy: null, steeringEpisodes: null });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Unknown);
  });

  it("FEA-2870: headless sessions score fully agentic, ignoring the prompt-episode formula", () => {
    // Timestamps that would otherwise yield a mid/low score (many prompt
    // episodes = heavy steering) are overridden: a headless run is autonomous by
    // construction.
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:01:00.000Z",
        "2026-06-16T10:02:00.000Z",
        "2026-06-16T10:03:00.000Z",
      ],
      activityTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:03:30.000Z",
      ],
      headless: true,
    });

    expect(result).toEqual({ autonomy: 100, steeringEpisodes: 0 });
    expect(getAutonomyLabel(result.autonomy)).toBe(AutonomyLabel.Agentic);
  });

  it("FEA-2870: headless scores 100 even with no timestamp basis", () => {
    const result = deriveAutonomyAndSteering({
      promptTimestamps: [],
      activityTimestamps: [],
      headless: true,
    });

    expect(result).toEqual({ autonomy: 100, steeringEpisodes: 0 });
  });

  it("derives compact phase, throttle, and correction presentation fields from explicit sources", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      activityTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:30:00.000Z",
      ],
      phaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "implement",
          startedAt: "2026-06-16T10:05:00.000Z",
          endedAt: "2026-06-16T10:20:00.000Z",
        },
      ],
      throttleSources: [
        {
          sourceType: SessionTraceThrottleSourceType.ApiError,
          provider: "codex",
          observedAt: "2026-06-16T10:15:00.000Z",
          statusCode: 429,
          retryAfterSeconds: 60,
        },
      ],
      correctionSources: [
        {
          kind: SessionTraceCorrectionKind.ExplicitCorrection,
          observedAt: "2026-06-16T10:25:00.000Z",
          label: "Correction",
        },
      ],
    });

    expect(result.phases).toMatchObject([{ key: "implement" }]);
    expect(result.phaseIterations).toEqual({ implement: 1 });
    expect(result.throttles).toHaveLength(1);
    expect(result.correctionMarkers).toMatchObject([{ kind: "frust" }]);
  });

  it("FEA-2986: correction ('frust') marker labels are clamped to the cloud cap", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      activityTimestamps: ["2026-06-16T10:00:00.000Z"],
      correctionSources: [
        {
          kind: SessionTraceCorrectionKind.ExplicitCorrection,
          observedAt: "2026-06-16T10:25:00.000Z",
          // Longer than the marker cap — the upstream `sourceText` slice is a
          // sibling limit, so the marker builder must clamp independently.
          label: "c".repeat(SESSION_TRACE_SOURCE_LIMITS.markerLabel + 100),
        },
      ],
    });

    expect(result.correctionMarkers).toHaveLength(1);
    const [frust] = result.correctionMarkers;
    expect(frust.kind).toBe("frust");
    expect(frust.label.length).toBe(SESSION_TRACE_SOURCE_LIMITS.markerLabel);
  });

  it("accumulates repeated phase durations across loopbacks", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      activityTimestamps: [
        "2026-06-16T10:00:00.000Z",
        "2026-06-16T10:30:00.000Z",
      ],
      phaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "implement",
          startedAt: "2026-06-16T10:00:00.000Z",
          endedAt: "2026-06-16T10:05:00.000Z",
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "review",
          startedAt: "2026-06-16T10:05:00.000Z",
          endedAt: "2026-06-16T10:07:00.000Z",
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "implement",
          startedAt: "2026-06-16T10:07:00.000Z",
          endedAt: "2026-06-16T10:17:00.000Z",
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "test",
          startedAt: "2026-06-16T10:17:00.000Z",
          endedAt: "2026-06-16T10:18:00.000Z",
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "implement",
          startedAt: "2026-06-16T10:18:00.000Z",
          endedAt: "2026-06-16T10:21:00.000Z",
        },
      ],
    });

    expect(
      result.phases.find((phase) => phase.key === "implement")
    ).toMatchObject({
      dur: "18m",
    });
    expect(result.phaseIterations).toMatchObject({ implement: 3 });
  });

  it("uses authoritative PR terminal timestamps before raw state", () => {
    expect(
      derivePrLifecycleStatus({
        prState: PullRequestState.Open,
        mergedAt: "2026-06-16T10:00:00.000Z",
      })
    ).toBe(SessionPrLifecycleStatus.Merged);
    expect(derivePrLifecycleStatus({ prState: PullRequestState.Closed })).toBe(
      SessionPrLifecycleStatus.Closed
    );
    expect(derivePrLifecycleStatus({ prState: PullRequestState.Open })).toBe(
      SessionPrLifecycleStatus.Open
    );
    expect(derivePrLifecycleStatus({ prState: "unexpected" })).toBe(
      SessionPrLifecycleStatus.Unknown
    );
  });
});
