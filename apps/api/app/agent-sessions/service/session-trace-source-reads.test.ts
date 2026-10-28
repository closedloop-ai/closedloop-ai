import {
  SessionTraceCorrectionSourceKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/types/agent-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonArrayIncompleteReason } from "./coercion";
import {
  readSessionTraceSources,
  resetUnreadableTraceSourceEmissionBudget,
  UNREADABLE_SESSION_TRACE_SOURCES_EVENT,
  UNREADABLE_SESSION_TRACE_SOURCES_MAX_ENTRIES,
  UNREADABLE_SESSION_TRACE_SOURCES_WINDOW_MS,
} from "./session-trace-source-reads";

const mockWarn = vi.fn();

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

const CONTEXT = {
  organizationId: "org-1",
  sessionId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
};

/**
 * The cap + 1 round-robin drives the real production entry cap rather than a
 * miniature one, so the assertion covers the shipped bound. Declared here, not
 * at the bottom, because `it(…, timeout)` is evaluated while the `describe`
 * callback runs.
 */
const ROUND_ROBIN_TIMEOUT_MS = 30_000;

const READABLE_PHASE_SOURCE = {
  sourceType: SessionTracePhaseSourceType.Explicit,
  phaseKey: "build",
  label: "Build",
  startedAt: "2026-05-20T17:00:00.000Z",
  endedAt: "2026-05-20T17:05:00.000Z",
};
const READABLE_THROTTLE_SOURCE = {
  sourceType: SessionTraceThrottleSourceType.ProviderRateLimit,
  provider: "anthropic",
  observedAt: "2026-05-20T17:02:00.000Z",
  limitKind: "rpm",
  statusCode: 429,
  errorCode: null,
  resetAt: null,
  retryAfterSeconds: 30,
};
const SECOND_READABLE_THROTTLE_SOURCE = {
  ...READABLE_THROTTLE_SOURCE,
  provider: "openai",
  observedAt: "2026-05-20T17:04:00.000Z",
};
const READABLE_CORRECTION_SOURCE = {
  kind: SessionTraceCorrectionSourceKind.ReviewChangeRequest,
  observedAt: "2026-05-20T17:06:00.000Z",
  label: "changes requested",
  sourceType: "review",
};
/** Fails `sessionTraceThrottleSourceSchema`: `provider` and `observedAt` required. */
const UNREADABLE_THROTTLE_SOURCE = {
  sourceType: SessionTraceThrottleSourceType.ApiError,
};

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    tracePhaseSources: [READABLE_PHASE_SOURCE],
    throttleSources: [READABLE_THROTTLE_SOURCE],
    correctionSources: [READABLE_CORRECTION_SOURCE],
    ...overrides,
  };
}

describe("readSessionTraceSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUnreadableTraceSourceEmissionBudget();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T17:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the readable throttle sources either side of an unreadable one", () => {
    const result = readSessionTraceSources(
      buildRecord({
        throttleSources: [
          READABLE_THROTTLE_SOURCE,
          UNREADABLE_THROTTLE_SOURCE,
          SECOND_READABLE_THROTTLE_SOURCE,
        ],
      }),
      CONTEXT
    );

    expect(result.throttleSources.map((source) => source.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    // The lanes are independent: one corrupt throttle source must not empty the
    // other two arrays.
    expect(result.tracePhaseSources).toEqual([READABLE_PHASE_SOURCE]);
    expect(result.correctionSources).toEqual([READABLE_CORRECTION_SOURCE]);
  });

  it("stays silent when all three arrays are read whole", () => {
    readSessionTraceSources(buildRecord(), CONTEXT);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["an absent", null],
    ["a stored empty", []],
  ])("stays silent for %s column", (_label, value) => {
    readSessionTraceSources(
      buildRecord({ tracePhaseSources: value, correctionSources: value }),
      CONTEXT
    );

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("raises ONE monitored event naming every unreadable lane, and only those", () => {
    readSessionTraceSources(
      buildRecord({
        throttleSources: [READABLE_THROTTLE_SOURCE, UNREADABLE_THROTTLE_SOURCE],
        correctionSources: "not-json",
      }),
      CONTEXT
    );

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [event, payload] = mockWarn.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe(UNREADABLE_SESSION_TRACE_SOURCES_EVENT);
    expect(payload).toMatchObject({
      organizationId: CONTEXT.organizationId,
      sessionId: CONTEXT.sessionId,
    });
    // `tracePhaseSources` was whole, so it must not appear at all — an event
    // that lists every lane every time tells the monitor nothing.
    expect(payload.fields).toEqual([
      {
        field: "throttleSources",
        reason: JsonArrayIncompleteReason.UnreadableMembers,
        unreadableMembers: 1,
      },
      {
        field: "correctionSources",
        reason: JsonArrayIncompleteReason.UnreadableValue,
      },
    ]);
  });

  it(
    "stays bounded while a caller cycles more distinct sessions than the entry cap",
    () => {
      // The defeat this pins: a budget keyed on the churning `sessionId` evicts
      // its own key before reuse, so cap + 1 distinct sessions emit cap + 1
      // times. The key is `(reason, organizationId)`, which this caller cannot
      // churn, so the whole round-robin costs ONE event.
      const rounds = UNREADABLE_SESSION_TRACE_SOURCES_MAX_ENTRIES + 1;
      for (let round = 0; round < rounds; round += 1) {
        readSessionTraceSources(
          buildRecord({ correctionSources: "not-json" }),
          {
            organizationId: CONTEXT.organizationId,
            sessionId: `session-${round}`,
          }
        );
      }

      expect(mockWarn).toHaveBeenCalledTimes(1);
    },
    ROUND_ROBIN_TIMEOUT_MS
  );

  it("emits once more after the window rolls over", () => {
    readSessionTraceSources(
      buildRecord({ correctionSources: "not-json" }),
      CONTEXT
    );
    vi.setSystemTime(Date.now() + UNREADABLE_SESSION_TRACE_SOURCES_WINDOW_MS);
    readSessionTraceSources(
      buildRecord({ correctionSources: "not-json" }),
      CONTEXT
    );

    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("does not let one organization's spent window silence another", () => {
    readSessionTraceSources(
      buildRecord({ correctionSources: "not-json" }),
      CONTEXT
    );
    readSessionTraceSources(buildRecord({ correctionSources: "not-json" }), {
      ...CONTEXT,
      organizationId: "org-2",
    });

    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it("emits immediately when the same organization hits a new reason", () => {
    readSessionTraceSources(
      buildRecord({ correctionSources: "not-json" }),
      CONTEXT
    );
    // Same org, same window, but `unreadable_members` rather than
    // `unreadable_value` — a newly-corrupt column must not wait out a window
    // opened by an unrelated failure mode.
    readSessionTraceSources(
      buildRecord({
        throttleSources: [READABLE_THROTTLE_SOURCE, UNREADABLE_THROTTLE_SOURCE],
      }),
      CONTEXT
    );

    expect(mockWarn).toHaveBeenCalledTimes(2);
  });
});
