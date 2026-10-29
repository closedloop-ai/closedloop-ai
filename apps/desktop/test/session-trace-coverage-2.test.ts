/**
 * @file session-trace-coverage-2.test.ts
 * @description ISS-10514 survivor pass for session-trace.ts: sources built from events with no `data`, phase/throttle
 * drop rules, the 429 classification, limitKind fallbacks, and the one-pop-per-
 * iteration order of the aggregate source trim.
 * Pins CURRENT behavior only.
 */
import {
  SESSION_TRACE_SOURCE_LIMITS,
  SessionTraceThrottleSourceType,
} from "@repo/lib/session-trace/derivation";
import { describe, expect, it } from "vitest";
import type { SessionTraceThrottleSource } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  buildSessionTraceSyncFields,
  type SessionTraceSyncInput,
} from "../src/main/database/session-trace.js";
import { baseSessionTraceInput } from "./session-trace-test-utils.js";

const CREATED_AT = "2026-06-07T12:01:00.000Z";
const INVALID_DATE = "not-a-date";

type TraceEvent = SessionTraceSyncInput["events"][number];

function traceEvent(
  eventType: string,
  data: Record<string, unknown> | null
): TraceEvent {
  return {
    event_type: eventType,
    tool_name: null,
    created_at: CREATED_AT,
    summary: null,
    data: data === null ? null : JSON.stringify(data),
  };
}

function sourcesFor(events: TraceEvent[]) {
  return buildSessionTraceSyncFields(baseSessionTraceInput({ events }));
}

function throttle(
  sourceType: SessionTraceThrottleSource["sourceType"],
  overrides: {
    provider?: string;
    limitKind?: string | null;
    statusCode?: number | null;
  } = {}
) {
  return {
    sourceType,
    provider: overrides.provider ?? "unknown",
    observedAt: CREATED_AT,
    limitKind: overrides.limitKind ?? null,
    statusCode: overrides.statusCode ?? null,
    errorCode: null,
    resetAt: null,
    retryAfterSeconds: null,
  };
}

describe("events with no data payload", () => {
  it("drops a phase event and keeps a throttle event with every fallback applied", () => {
    const fields = sourcesFor([
      traceEvent("phase", null),
      traceEvent("throttle", null),
    ]);

    expect(fields.tracePhaseSources).toEqual([]);
    expect(fields.throttleSources).toEqual([
      throttle(SessionTraceThrottleSourceType.ProviderRateLimit),
    ]);
  });
});

describe("phase drop rules", () => {
  it("drops a phase with a label but no key, and one with an unparseable start", () => {
    const fields = sourcesFor([
      traceEvent("phase", { label: "Build" }),
      traceEvent("phase", { phaseKey: "build", startedAt: INVALID_DATE }),
    ]);

    expect(fields.tracePhaseSources).toEqual([]);
  });
});

describe("throttle classification", () => {
  it("drops an unparseable resetAt, classifies 429 as an API error, and reads limitKind then type", () => {
    const fields = sourcesFor([
      traceEvent("throttle", { provider: "openai", resetAt: INVALID_DATE }),
      traceEvent("throttle", { provider: "openai", statusCode: 429 }),
      traceEvent("throttle", { limitKind: "tokens", type: "requests" }),
      traceEvent("throttle", { type: "requests" }),
    ]);

    expect(fields.throttleSources).toEqual([
      throttle(SessionTraceThrottleSourceType.ApiError, {
        provider: "openai",
        statusCode: 429,
      }),
      throttle(SessionTraceThrottleSourceType.ProviderRateLimit, {
        limitKind: "tokens",
      }),
      throttle(SessionTraceThrottleSourceType.ProviderRateLimit, {
        limitKind: "requests",
      }),
    ]);
  });
});

describe("aggregate source payload limit", () => {
  it("pops one source per iteration, so throttles absorb the overflow and the phase survives", () => {
    const longText = (seed: string) =>
      seed.padEnd(SESSION_TRACE_SOURCE_LIMITS.sourceText, "x");
    const throttleCount = SESSION_TRACE_SOURCE_LIMITS.throttleSources;
    const events: TraceEvent[] = [
      traceEvent("correction", null),
      traceEvent("phase", { phaseKey: "plan" }),
    ];
    for (let index = 0; index < throttleCount; index += 1) {
      events.push(
        traceEvent("throttle", {
          provider: longText(`provider-${index}-`),
          limitKind: longText(`limit-${index}-`),
          errorCode: longText(`code-${index}-`),
        })
      );
    }

    const fields = sourcesFor(events);
    const throttles = fields.throttleSources ?? [];

    expect(fields.correctionSources).toEqual([]);
    expect(fields.tracePhaseSources?.map((phase) => phase.phaseKey)).toEqual([
      "plan",
    ]);
    expect(throttles.length).toBeGreaterThan(0);
    expect(throttles.length).toBeLessThan(throttleCount);
  });
});
