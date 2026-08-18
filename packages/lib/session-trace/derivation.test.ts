import {
  SessionTraceCorrectionSourceKind as ContractSessionTraceCorrectionKind,
  SessionTracePhaseSourceType as ContractSessionTracePhaseSourceType,
  SessionTraceThrottleSourceType as ContractSessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { PullRequestState } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  clampMarkerLabel,
  derivePrLifecycleStatus,
  deriveSessionTracePresentation,
  isSessionTerminatingLabel,
  resolveActivityEndMs,
  SESSION_TRACE_SOURCE_LIMITS,
  SessionPrLifecycleStatus,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
  sessionPrWithLifecycle,
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
  it("derives compact phase, throttle, and correction presentation fields from explicit sources", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      agentActivityTimestamps: [
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

  it("FEA-3604: keeps throttle/marker x-coordinates finite for a zero-duration session", () => {
    // start === end makes the internal duration 0, so the observed/start ratio
    // is non-finite (Infinity/NaN). The shared `clampPercent` SSOT coerces that
    // to 0 rather than emitting a NaN/Infinity coordinate that breaks the
    // timeline positioning downstream.
    const instant = "2026-06-16T10:00:00.000Z";
    const result = deriveSessionTracePresentation({
      startedAt: instant,
      updatedAt: instant,
      endedAt: instant,
      promptTimestamps: [instant],
      agentActivityTimestamps: [instant],
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
          observedAt: "2026-06-16T10:15:00.000Z",
          label: "Correction",
        },
      ],
    });

    expect(result.throttles).toHaveLength(1);
    expect(result.throttles[0].x0).toBe(0);
    expect(result.correctionMarkers).toHaveLength(1);
    expect(result.correctionMarkers[0].x).toBe(0);
  });

  it("FEA-2986: correction ('frust') marker labels are clamped to the cloud cap", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: ["2026-06-16T10:00:00.000Z"],
      agentActivityTimestamps: ["2026-06-16T10:00:00.000Z"],
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
      agentActivityTimestamps: [
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

  describe("resolveActivityEndMs", () => {
    it("uses endedAt when present, over both activity and updatedAt", () => {
      expect(
        resolveActivityEndMs({
          endedAt: "2026-06-16T10:00:00.000Z",
          updatedAt: "2026-07-01T10:00:00.000Z",
          activityTimestamps: ["2026-06-20T10:00:00.000Z"],
        })
      ).toBe(Date.parse("2026-06-16T10:00:00.000Z"));
    });

    it("falls back to endedAt when there are no activity timestamps", () => {
      expect(
        resolveActivityEndMs({
          endedAt: "2026-07-19T10:00:00.000Z",
          updatedAt: "2026-07-21T10:00:00.000Z",
          activityTimestamps: [],
        })
      ).toBe(Date.parse("2026-07-19T10:00:00.000Z"));
    });

    it("ISS-5182 (review): an unparseable endedAt falls through to activity, never anchors NaN", () => {
      // A NaN anchor is not "no end" downstream — it makes the whole trace
      // block (wallClock, span, buckets, markers) drop OUT of the sync payload,
      // and the cloud patch preserves omitted fields, so a row that already
      // synced the inflated value would keep it forever.
      expect(
        resolveActivityEndMs({
          endedAt: "not-a-timestamp",
          updatedAt: "2026-07-21T10:00:00.000Z",
          activityTimestamps: ["2026-07-19T07:17:00.000Z"],
        })
      ).toBe(Date.parse("2026-07-19T07:17:00.000Z"));
    });

    it("ISS-5182 (review): an unparseable endedAt with no activity falls through to updatedAt", () => {
      expect(
        resolveActivityEndMs({
          endedAt: "0000-13-45T99:99:99Z",
          updatedAt: "2026-07-21T10:00:00.000Z",
          activityTimestamps: [],
        })
      ).toBe(Date.parse("2026-07-21T10:00:00.000Z"));
    });

    it("ISS-5182 (review): an unparseable updatedAt is NaN, not a silent zero", () => {
      expect(
        resolveActivityEndMs({
          endedAt: null,
          updatedAt: "nonsense",
          activityTimestamps: [],
        })
      ).toBeNaN();
    });

    it("anchors to the last activity timestamp when un-ended, not the bumped updatedAt", () => {
      // updatedAt is days after the last real activity (a re-sync touch).
      expect(
        resolveActivityEndMs({
          endedAt: null,
          updatedAt: "2026-07-01T10:00:00.000Z",
          activityTimestamps: [
            "2026-06-16T10:00:00.000Z",
            "2026-06-16T10:05:00.000Z",
            "2026-06-16T10:02:00.000Z",
          ],
        })
      ).toBe(Date.parse("2026-06-16T10:05:00.000Z"));
    });

    it("skips unparseable activity timestamps rather than letting NaN win", () => {
      expect(
        resolveActivityEndMs({
          endedAt: null,
          updatedAt: "2026-07-01T10:00:00.000Z",
          activityTimestamps: ["2026-06-16T10:05:00.000Z", "not-a-date"],
        })
      ).toBe(Date.parse("2026-06-16T10:05:00.000Z"));
    });

    it("falls back to updatedAt only when there are no activity timestamps", () => {
      expect(
        resolveActivityEndMs({
          endedAt: null,
          updatedAt: "2026-07-01T10:00:00.000Z",
          activityTimestamps: [],
        })
      ).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
    });

    it("returns NaN when un-ended with neither activity nor updatedAt", () => {
      expect(
        resolveActivityEndMs({
          endedAt: null,
          updatedAt: null,
          activityTimestamps: [],
        })
      ).toBeNaN();
    });
  });

  describe("sessionPrWithLifecycle", () => {
    it("keeps explicit title and status without re-deriving them", () => {
      const pr = sessionPrWithLifecycle({
        num: 42,
        title: "  Fix the thing  ",
        status: SessionPrLifecycleStatus.Merged,
      });
      expect(pr.num).toBe(42);
      expect(pr.title).toBe("Fix the thing");
      expect(pr.status).toBe(SessionPrLifecycleStatus.Merged);
    });

    it("falls back to PR #N title and derives status when both are absent", () => {
      const pr = sessionPrWithLifecycle({
        num: 99,
        title: null,
      });
      expect(pr.title).toBe("PR #99");
      expect(pr.status).toBe(SessionPrLifecycleStatus.Unknown);
    });
  });

  it("uses a caller-supplied endMs anchor when it is finite, not updatedAt/endedAt", () => {
    const startedAt = "2026-06-16T10:00:00.000Z";
    const endMs = Date.parse("2026-06-16T10:20:00.000Z");
    const result = deriveSessionTracePresentation({
      startedAt,
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:25:00.000Z",
      endMs,
      promptTimestamps: [startedAt],
      agentActivityTimestamps: [startedAt],
      throttleSources: [
        {
          sourceType: SessionTraceThrottleSourceType.ApiError,
          provider: "codex",
          observedAt: "2026-06-16T10:10:00.000Z",
          statusCode: 429,
          retryAfterSeconds: 60,
        },
      ],
    });
    // endMs (10:20) is used → total duration = 20m; observedAt (10:10) is 50% of 20m
    expect(result.throttles[0]!.x0).toBe(50);
  });

  it("skips a throttle source with an invalid observedAt", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      throttleSources: [
        {
          sourceType: SessionTraceThrottleSourceType.ApiError,
          provider: "codex",
          observedAt: "not-a-date",
          statusCode: 429,
          retryAfterSeconds: 60,
        },
      ],
    });
    expect(result.throttles).toHaveLength(0);
  });

  it("uses resetAt when retryAfterSeconds is absent from a throttle source", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      throttleSources: [
        {
          sourceType: SessionTraceThrottleSourceType.ApiError,
          provider: "codex",
          observedAt: "2026-06-16T10:15:00.000Z",
          statusCode: 429,
          resetAt: "2026-06-16T10:16:00.000Z",
          // retryAfterSeconds omitted → uses resetAt
        },
      ],
    });
    expect(result.throttles).toHaveLength(1);
    // durMin = (resetAt - observedAt) / 60_000 = 60s / 60_000 = 1 minute
    expect(result.throttles[0]!.durMin).toBeCloseTo(1);
  });

  it("skips a correction source with an invalid observedAt", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      correctionSources: [
        {
          kind: SessionTraceCorrectionKind.ExplicitCorrection,
          observedAt: "bad-date",
          label: "correction",
        },
      ],
    });
    expect(result.correctionMarkers).toHaveLength(0);
  });

  it("skips a phase source with an empty phaseKey after trimming", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      phaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "   ",
          startedAt: "2026-06-16T10:00:00.000Z",
          endedAt: "2026-06-16T10:05:00.000Z",
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "implement",
          startedAt: "2026-06-16T10:05:00.000Z",
          endedAt: "2026-06-16T10:15:00.000Z",
        },
      ],
    });
    // Empty phaseKey is skipped; only "implement" survives
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.key).toBe("implement");
  });

  it("titleizes the phase label when no explicit label is provided", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:30:00.000Z",
      endedAt: "2026-06-16T10:30:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      phaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "code_review",
          startedAt: "2026-06-16T10:00:00.000Z",
          endedAt: "2026-06-16T10:05:00.000Z",
          // no label → titleize("code_review") → "Code Review"
        },
      ],
    });
    expect(result.phases[0]!.label).toBe("Code Review");
  });

  it("formats phase durations over 60 minutes as hours-and-minutes or exact hours", () => {
    const result = deriveSessionTracePresentation({
      startedAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T12:00:00.000Z",
      endedAt: "2026-06-16T12:00:00.000Z",
      promptTimestamps: [],
      agentActivityTimestamps: [],
      phaseSources: [
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "long_task",
          startedAt: "2026-06-16T10:00:00.000Z",
          endedAt: "2026-06-16T11:30:00.000Z", // 90 minutes → "1h 30m"
        },
        {
          sourceType: SessionTracePhaseSourceType.LoopPerf,
          phaseKey: "exact_hour",
          startedAt: "2026-06-16T10:00:00.000Z",
          endedAt: "2026-06-16T11:00:00.000Z", // 60 minutes → "1h"
        },
      ],
    });
    const longTask = result.phases.find((p) => p.key === "long_task");
    const exactHour = result.phases.find((p) => p.key === "exact_hour");
    expect(longTask?.dur).toBe("1h 30m");
    expect(exactHour?.dur).toBe("1h");
  });

  // Deliberately NOT tested: `resolveActivityEndMs`'s `preferActivityOverEnded`
  // tail (`updatedAt ? Date.parse(updatedAt) : NaN`) with no activity and no
  // `endedAt`. That tail is character-identical to the non-prefer path's tail,
  // so for those inputs BOTH flag values return the same answer and no assertion
  // can distinguish the arm — a test there would raise the branch percentage
  // while being unable to fail (PRD-618's coverage-farming rule). The only
  // inputs where the flag changes the result are activity-vs-`endedAt`, which
  // the FEA-3594 cases above already pin.

  describe("isSessionTerminatingLabel", () => {
    it("matches bare /exit and /quit", () => {
      expect(isSessionTerminatingLabel("/exit")).toBe(true);
      expect(isSessionTerminatingLabel("/quit")).toBe(true);
      expect(isSessionTerminatingLabel("/EXIT")).toBe(true);
    });

    it("matches /exit and /quit followed by whitespace", () => {
      expect(isSessionTerminatingLabel("/exit ")).toBe(true);
      expect(isSessionTerminatingLabel("/quit now")).toBe(true);
    });

    it("rejects hyphenated commands that share the prefix", () => {
      expect(isSessionTerminatingLabel("/exit-review")).toBe(false);
      expect(isSessionTerminatingLabel("/quit.now")).toBe(false);
      expect(isSessionTerminatingLabel("/exit-code")).toBe(false);
    });

    it("rejects unrelated commands", () => {
      expect(isSessionTerminatingLabel("/help")).toBe(false);
      expect(isSessionTerminatingLabel("exit")).toBe(false);
    });
  });
});
