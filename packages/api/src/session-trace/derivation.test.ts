import { describe, expect, it } from "vitest";
import {
  SessionTraceCorrectionSourceKind as ContractSessionTraceCorrectionKind,
  SessionTracePhaseSourceType as ContractSessionTracePhaseSourceType,
  SessionTraceThrottleSourceType as ContractSessionTraceThrottleSourceType,
} from "../types/agent-session.ts";
import { PullRequestState } from "../types/document.ts";
import {
  AutonomyLabel,
  deriveAutonomyAndSteering,
  derivePrLifecycleStatus,
  deriveSessionTracePresentation,
  getAutonomyLabel,
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
