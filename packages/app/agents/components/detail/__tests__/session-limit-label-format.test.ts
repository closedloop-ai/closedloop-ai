import {
  type SessionTraceThrottleSource,
  SessionTraceThrottleSourceType,
  type SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  formatLimitLabelText,
  formatThrottleDuration,
  formatThrottleSourceLimitLabel,
  getSessionEventLimitLabel,
} from "../session-limit-label-format";

/**
 * ISS-7634. Scoped deliberately to the branches nothing else reaches, so this
 * suite stays a complement to `agent-session-detail-view.test.tsx` rather than a
 * second copy of it. What that view test already pins, and is NOT re-asserted
 * here: `formatThrottleDuration` on a whole number (its
 * `THROTTLED_FOR_FIVE_MINUTES_TEXT` matcher covers 5 → "5m", where the rounding
 * is a no-op), and the first title rung with a two-item detail join
 * (`limitKind: "session_limit"` → "Session Limit (Codex, HTTP 429)").
 *
 * Everything below is a branch no test reached: the duration guard, the
 * sub-minute label, the rounding itself, every separator class and the
 * lowercased tail, and title rungs two through four.
 *
 * The `getSessionEventLimitLabel` block goes past the three formatters ISS-7634
 * named. Its two cases are the module's only other uncovered branches — the
 * structured-`data` string and non-`statusCode` numeric reads, which decide
 * whether a limit dot renders at all — so leaving them would have shipped a
 * known hole under a ticket whose whole subject is this module's coverage.
 */

const OBSERVED_AT = "2026-06-10T12:00:00.000Z";

describe("formatThrottleDuration", () => {
  it("returns null for a non-positive duration", () => {
    expect(formatThrottleDuration(0)).toBeNull();
    expect(formatThrottleDuration(-5)).toBeNull();
  });

  it("returns null for a non-finite duration", () => {
    expect(formatThrottleDuration(Number.NaN)).toBeNull();
    expect(formatThrottleDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("collapses a sub-minute pause to '<1m' rather than rounding it to '0m'", () => {
    expect(formatThrottleDuration(0.5)).toBe("<1m");
    expect(formatThrottleDuration(0.99)).toBe("<1m");
  });

  it("treats exactly one minute as a rounded label, not a sub-minute pause", () => {
    expect(formatThrottleDuration(1)).toBe("1m");
  });

  it("rounds a fractional duration to the nearest whole minute", () => {
    expect(formatThrottleDuration(2.6)).toBe("3m");
    expect(formatThrottleDuration(2.4)).toBe("2m");
  });
});

describe("formatLimitLabelText", () => {
  it("splits on every separator in the class, not just underscores", () => {
    expect(formatLimitLabelText("provider.rate_limit")).toBe(
      "Provider Rate Limit"
    );
    expect(formatLimitLabelText("rate-limit")).toBe("Rate Limit");
    expect(formatLimitLabelText("usage limit exceeded")).toBe(
      "Usage Limit Exceeded"
    );
  });

  it("lowercases the tail of an already-upper-case key", () => {
    expect(formatLimitLabelText("HTTP_ERROR")).toBe("Http Error");
  });

  it("drops empty parts from repeated and edge separators", () => {
    expect(formatLimitLabelText("usage__limit")).toBe("Usage Limit");
    expect(formatLimitLabelText("_usage_limit_")).toBe("Usage Limit");
  });

  it("returns null for an absent value", () => {
    expect(formatLimitLabelText(null)).toBeNull();
    expect(formatLimitLabelText(undefined)).toBeNull();
  });

  it("returns null for an empty or whitespace-only value", () => {
    expect(formatLimitLabelText("")).toBeNull();
    expect(formatLimitLabelText("   ")).toBeNull();
    expect(formatLimitLabelText("\t\n")).toBeNull();
  });
});

describe("formatThrottleSourceLimitLabel", () => {
  it("falls back to errorCode when limitKind is absent", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          errorCode: "rate_limit_exceeded",
          limitKind: null,
        })
      )
    ).toBe("Rate Limit Exceeded");
  });

  it("falls through a whitespace-only limitKind, which formats to null", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          errorCode: "rate_limit_exceeded",
          limitKind: "   ",
        })
      )
    ).toBe("Rate Limit Exceeded");
  });

  it("falls back to sourceType when both limitKind and errorCode are absent", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          errorCode: null,
          limitKind: null,
          sourceType: SessionTraceThrottleSourceType.ApiError,
        })
      )
    ).toBe("Api Error");
  });

  it("falls back to the generic title when no field yields one", () => {
    // `sourceType` has been required since the type shipped (86cad81f7), so no
    // producer omits it by version — this is malformed wire input, not skew.
    // The record arrives as JSON from the desktop and the type cannot constrain
    // what actually lands, so this rung stays reachable at runtime.
    const malformedSource = {
      observedAt: OBSERVED_AT,
      provider: "",
    } as SessionTraceThrottleSource;

    expect(formatThrottleSourceLimitLabel(malformedSource)).toBe(
      "Session limit"
    );
  });

  it("prefers limitKind over both lower rungs", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          errorCode: "rate_limit_exceeded",
          limitKind: "usage_limit",
          sourceType: SessionTraceThrottleSourceType.ApiError,
        })
      )
    ).toBe("Usage Limit");
  });

  it("prefers errorCode over sourceType", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          errorCode: "rate_limit_exceeded",
          limitKind: null,
          sourceType: SessionTraceThrottleSourceType.ApiError,
        })
      )
    ).toBe("Rate Limit Exceeded");
  });

  it("omits the parenthetical entirely when no detail is present", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "",
          statusCode: null,
        })
      )
    ).toBe("Usage Limit");
  });

  it("omits a whitespace-only provider from the details", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "   ",
          statusCode: null,
        })
      )
    ).toBe("Usage Limit");
  });

  it("renders a lone provider detail without a separator", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "Anthropic",
          statusCode: null,
        })
      )
    ).toBe("Usage Limit (Anthropic)");
  });

  it("renders a lone status-code detail without a separator", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "",
          statusCode: 429,
        })
      )
    ).toBe("Usage Limit (HTTP 429)");
  });

  it("drops a non-finite status code instead of rendering 'HTTP NaN'", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "",
          statusCode: Number.NaN,
        })
      )
    ).toBe("Usage Limit");
  });

  it("drops an omitted status code", () => {
    expect(
      formatThrottleSourceLimitLabel(
        createThrottleSource({
          limitKind: "usage_limit",
          provider: "",
        })
      )
    ).toBe("Usage Limit");
  });
});

describe("getSessionEventLimitLabel", () => {
  it("reads a limit signal out of a structured string data field", () => {
    expect(
      getSessionEventLimitLabel(
        createSessionEvent({ data: { limitKind: "usage_limit" } })
      )
    ).toBe("usage_limit");
  });

  it("reads a limit signal out of a structured numeric data field", () => {
    expect(
      getSessionEventLimitLabel(createSessionEvent({ data: { code: 429 } }))
    ).toBe("429");
  });
});

function createSessionEvent(
  overrides: Partial<SyncedAgentSessionEvent> = {}
): SyncedAgentSessionEvent {
  return {
    createdAt: OBSERVED_AT,
    // Deliberately not a limit signal, so only the structured `data` fields an
    // override supplies can produce a label.
    eventType: "tool_result",
    externalEventId: "evt-1",
    ...overrides,
  };
}

function createThrottleSource(
  overrides: Partial<SessionTraceThrottleSource> = {}
): SessionTraceThrottleSource {
  return {
    observedAt: OBSERVED_AT,
    provider: "",
    sourceType: SessionTraceThrottleSourceType.UsageLimit,
    ...overrides,
  };
}
