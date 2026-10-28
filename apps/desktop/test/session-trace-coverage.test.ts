/**
 * @file session-trace-coverage.test.ts
 * @description ISS-10514 coverage for session-trace.ts: timeline row roles and
 * terminating slash commands, phase/throttle/correction source extraction
 * fallbacks, the aggregate source-payload trim, the trace-activity pricing-miss
 * report, the `pr` marker, and the legacy vs
 * repository-scoped pull-request merge. Pure builders, no store.
 * Pins CURRENT behavior only.
 */
import {
  SESSION_TRACE_SOURCE_LIMITS,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/lib/session-trace/derivation";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlitePullRequestRow } from "../src/main/database/db-row-types.js";
import {
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  type SessionTraceSyncInput,
} from "../src/main/database/session-trace.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  baseSessionTraceInput,
  traceTokenEvent,
} from "./session-trace-test-utils.js";

const T0 = "2026-06-07T12:00:00.000Z";
const T1 = "2026-06-07T12:01:00.000Z";
const T2 = "2026-06-07T12:02:00.000Z";
const T3 = "2026-06-07T12:03:00.000Z";
const T4 = "2026-06-07T12:04:00.000Z";
const OBSERVED_OVERRIDE = "2026-06-07T12:02:30.000Z";
const INVALID_DATE = "not-a-date";

type TraceEvent = SessionTraceSyncInput["events"][number];

function traceEvent(
  eventType: string,
  data: Record<string, unknown> | null,
  summary: string | null = null
): TraceEvent {
  return {
    event_type: eventType,
    tool_name: null,
    created_at: T1,
    summary,
    data: data === null ? null : JSON.stringify(data),
  };
}

function sourcesFor(events: TraceEvent[]) {
  return buildSessionTraceSyncFields(baseSessionTraceInput({ events }));
}

function pullRequestRow(
  prNumber: number | null,
  repoFullName: string | null,
  title: string
): SqlitePullRequestRow {
  return {
    session_id: "s1",
    pr_number: prNumber,
    repo_full_name: repoFullName,
    title,
    closed_at: null,
    observed_at: T1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTraceTimelineRows", () => {
  it("skips incomplete messages, maps non-assistant roles to SystemMessage, and labels a terminating prompt with its command", () => {
    const rows = buildTraceTimelineRows(
      {
        messages: [
          { role: "human", timestamp: T0 },
          { role: "system", timestamp: T1 },
          { timestamp: T2 },
          { role: "assistant" },
          { role: "human", timestamp: T3 },
        ],
        slashCommands: [
          { name: "/exit", timestamp: T3 },
          { name: "/model", timestamp: T0 },
        ],
      },
      []
    );

    expect(rows).toEqual([
      {
        eventType: "UserMessage",
        toolName: null,
        createdAt: T0,
        label: "Prompt",
      },
      {
        eventType: "SystemMessage",
        toolName: null,
        createdAt: T1,
        label: "system",
      },
      {
        eventType: "UserMessage",
        toolName: null,
        createdAt: T3,
        label: "/exit",
      },
    ]);
  });
});

describe("trace phase sources", () => {
  it("falls back through phase and name for the key, uses created_at for a missing start, and drops an unparseable end", () => {
    const fields = sourcesFor([
      traceEvent("trace.phase", { phase: "plan" }),
      traceEvent("phase", { name: "build", startedAt: T2, endedAt: T3 }),
      traceEvent("phase", { phaseKey: "verify", endedAt: INVALID_DATE }),
    ]);

    expect(fields.tracePhaseSources).toEqual([
      {
        sourceType: SessionTracePhaseSourceType.Explicit,
        phaseKey: "plan",
        label: "plan",
        startedAt: T1,
        endedAt: null,
      },
      {
        sourceType: SessionTracePhaseSourceType.Explicit,
        phaseKey: "build",
        label: "build",
        startedAt: T2,
        endedAt: T3,
      },
    ]);
  });
});

describe("throttle sources", () => {
  it("classifies usage limits, token snapshots and plain provider limits with provider fallbacks", () => {
    const fields = sourcesFor([
      traceEvent("usage_limit", { service: "anthropic" }),
      traceEvent("rate_limit", { rate_limits: { primary: 1 } }),
      traceEvent("throttle", { provider: "openai", statusCode: 503 }),
    ]);

    expect(fields.throttleSources).toEqual([
      {
        sourceType: SessionTraceThrottleSourceType.UsageLimit,
        provider: "anthropic",
        observedAt: T1,
        limitKind: null,
        statusCode: null,
        errorCode: null,
        resetAt: null,
        retryAfterSeconds: null,
      },
      {
        sourceType: SessionTraceThrottleSourceType.TokenSnapshot,
        provider: "unknown",
        observedAt: T1,
        limitKind: null,
        statusCode: null,
        errorCode: null,
        resetAt: null,
        retryAfterSeconds: null,
      },
      {
        sourceType: SessionTraceThrottleSourceType.ProviderRateLimit,
        provider: "openai",
        observedAt: T1,
        limitKind: null,
        statusCode: 503,
        errorCode: null,
        resetAt: null,
        retryAfterSeconds: null,
      },
    ]);
  });
});

describe("correction sources", () => {
  it("classifies each kind by event type or by data.kind, and resolves the label from summary, data.label, then kind", () => {
    const fields = sourcesFor([
      traceEvent("review.change_request", null, "Fix the tests"),
      traceEvent("review_requested_changes", { label: "Needs work" }),
      traceEvent("correction", { kind: "review_change_request" }),
      traceEvent("approval_denied", null),
      traceEvent("correction", { kind: "approval_denied" }),
      traceEvent("negative_feedback", null),
      traceEvent("correction", { kind: "negative_feedback" }),
      traceEvent("correction", { kind: "manual_regression" }),
      traceEvent("correction", { observedAt: OBSERVED_OVERRIDE }),
      // pins current behavior; looks odd because a hyphenated manual-regression
      // type classifies by data.kind, not as ManualRegression.
      traceEvent("manual-regression", { kind: "explicit_correction" }),
    ]);

    expect(
      fields.correctionSources?.map((source) => [
        source.kind,
        source.label,
        source.sourceType,
        source.observedAt,
      ])
    ).toEqual([
      [
        SessionTraceCorrectionKind.ReviewChangeRequest,
        "Fix the tests",
        "review.change_request",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ReviewChangeRequest,
        "Needs work",
        "review_requested_changes",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ReviewChangeRequest,
        SessionTraceCorrectionKind.ReviewChangeRequest,
        "correction",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ApprovalDenied,
        SessionTraceCorrectionKind.ApprovalDenied,
        "approval_denied",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ApprovalDenied,
        SessionTraceCorrectionKind.ApprovalDenied,
        "correction",
        T1,
      ],
      [
        SessionTraceCorrectionKind.NegativeFeedback,
        SessionTraceCorrectionKind.NegativeFeedback,
        "negative_feedback",
        T1,
      ],
      [
        SessionTraceCorrectionKind.NegativeFeedback,
        SessionTraceCorrectionKind.NegativeFeedback,
        "correction",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ManualRegression,
        SessionTraceCorrectionKind.ManualRegression,
        "correction",
        T1,
      ],
      [
        SessionTraceCorrectionKind.ExplicitCorrection,
        SessionTraceCorrectionKind.ExplicitCorrection,
        "correction",
        OBSERVED_OVERRIDE,
      ],
      [
        SessionTraceCorrectionKind.ExplicitCorrection,
        SessionTraceCorrectionKind.ExplicitCorrection,
        "manual-regression",
        T1,
      ],
    ]);
  });

  it("drops a matching event with no resolvable kind or an unparseable observedAt", () => {
    const fields = sourcesFor([
      // pins current behavior; looks odd because the hyphenated type matches the
      // correction regex but not the underscore `includes` checks, so it is dropped.
      traceEvent("manual-regression", null),
      traceEvent("correction", { observedAt: INVALID_DATE }),
    ]);

    expect(fields.correctionSources).toEqual([]);
  });
});

describe("aggregate source payload limit", () => {
  it("pops corrections, then throttles, then phases until the three lists fit the byte budget", () => {
    const longText = (seed: string) =>
      seed.padEnd(SESSION_TRACE_SOURCE_LIMITS.sourceText, "x");
    const phaseCount = SESSION_TRACE_SOURCE_LIMITS.phaseSources;
    const events: TraceEvent[] = [
      traceEvent("correction", null),
      traceEvent("throttle", { provider: "openai" }),
    ];
    for (let index = 0; index < phaseCount; index += 1) {
      events.push(
        traceEvent("phase", {
          phaseKey: longText(`key-${index}-`),
          label: longText(`label-${index}-`),
        })
      );
    }

    const fields = sourcesFor(events);
    const phases = fields.tracePhaseSources ?? [];

    expect(fields.correctionSources).toEqual([]);
    expect(fields.throttleSources).toEqual([]);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.length).toBeLessThan(phaseCount);
    expect(phases.map((phase) => phase.phaseKey)).toEqual(
      Array.from({ length: phases.length }, (_, index) =>
        longText(`key-${index}-`)
      )
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          tracePhaseSources: phases,
          throttleSources: fields.throttleSources,
          correctionSources: fields.correctionSources,
        })
      )
    ).toBeLessThanOrEqual(SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes);
  });
});

describe("trace activity buckets", () => {
  it("reports a pricing miss for an unpriceable token event and books it at zero cost", () => {
    const pricingMiss = vi
      .spyOn(Observability, "tokenCostPricingMiss")
      .mockImplementation(() => undefined);

    const fields = buildSessionTraceSyncFields(
      baseSessionTraceInput({
        tokenEvents: [{ ...traceTokenEvent(T1), model: "" }],
      })
    );

    expect(pricingMiss).toHaveBeenCalledTimes(1);
    expect(pricingMiss).toHaveBeenCalledWith(
      expect.objectContaining({ model: "", surface: "trace_activity" })
    );
    const totalCost = (fields.activityBuckets ?? []).reduce(
      (sum, bucket) => sum + bucket.cIn + bucket.cOut + bucket.cCache,
      0
    );
    expect(totalCost).toBe(0);
  });

  it("emits a pr marker for a pull-request label and a /pull/ URL label", () => {
    const fields = buildSessionTraceSyncFields(
      baseSessionTraceInput({
        timelineRows: [
          {
            eventType: "PostToolUse",
            toolName: null,
            createdAt: T1,
            label: "Opened pull request",
          },
          {
            eventType: "PostToolUse",
            toolName: null,
            createdAt: T2,
            label: "https://github.com/o/r/pull/7",
          },
          {
            eventType: "PostToolUse",
            toolName: null,
            createdAt: T4,
            label: "Read file",
          },
        ],
      })
    );

    expect(fields.markers?.map((marker) => [marker.kind, marker.tl])).toEqual([
      ["pr", 0],
      ["pr", 1],
    ]);
  });
});

describe("pull request merge", () => {
  it("drops numberless rows, lets a repository-scoped PR replace or shadow its legacy twin, and keeps distinct legacy numbers", () => {
    const fields = buildSessionTraceSyncFields(
      baseSessionTraceInput({
        localPullRequests: [
          pullRequestRow(null, "o/r", "no number"),
          pullRequestRow(5, null, "legacy 5"),
          pullRequestRow(5, "o/r", "scoped 5"),
          pullRequestRow(7, "o/r", "scoped 7"),
          pullRequestRow(7, null, "legacy 7"),
          pullRequestRow(8, null, "legacy 8 first"),
          pullRequestRow(8, null, "legacy 8 second"),
          pullRequestRow(9, null, "legacy 9"),
        ],
      })
    );

    expect(fields.prs?.map((pr) => [pr.num, pr.title])).toEqual([
      [5, "scoped 5"],
      [7, "scoped 7"],
      [8, "legacy 8 second"],
      [9, "legacy 9"],
    ]);
  });
});
