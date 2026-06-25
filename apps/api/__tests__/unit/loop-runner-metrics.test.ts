/**
 * T-1.3 — Unit tests for loop-runner-metrics emitter module
 *
 * Each emitter is a typed passthrough into emitTelemetryMetric — the only
 * behavior worth testing is the exact JSON payload shape produced when the
 * caller's arguments are placed into the literal. One full-shape toEqual per
 * emitter covers it; enum coverage for reason mapping lives in the
 * mapRefreshErrorCodeToReason table below.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockLogInfo } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  RefreshTokenErrorCode,
  type RefreshTokenErrorCode as RefreshTokenErrorCodeType,
} from "@repo/api/src/types/loop";
import {
  emitHeartbeatAccepted,
  emitHeartbeatLag,
  emitReapTransition,
  emitRefreshAttempt,
  emitRefreshFailure,
  emitZombieDetector,
  mapRefreshErrorCodeToReason,
  ReapReason,
  RefreshFailureReason,
} from "@/lib/observability/loop-runner-metrics";

// ---------------------------------------------------------------------------
// Helpers + fixtures
// ---------------------------------------------------------------------------

function parsedLogCall(callIndex = 0): Record<string, unknown> {
  const raw = mockLogInfo.mock.calls[callIndex]?.[0] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

const ORG_ID = "org-test-001";
const LOOP_ID = "loop-test-abc";

// ---------------------------------------------------------------------------
// Emitter full-shape tests
//
// Each emitter is asserted with toEqual on the entire parsed payload. toEqual
// rejects unexpected keys, so the prior dedicated "no unexpected top-level
// keys" suite was redundant.
// ---------------------------------------------------------------------------

describe("loop-runner emitter payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const emitterCases: Array<{
    name: string;
    invoke: () => void;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "emitRefreshAttempt",
      invoke: () => emitRefreshAttempt(ORG_ID),
      expected: {
        metric: "loop.runner.refresh.attempt",
        orgId: ORG_ID,
        count: 1,
        _telemetryMetric: true,
      },
    },
    {
      name: "emitRefreshFailure",
      invoke: () => emitRefreshFailure(ORG_ID, RefreshFailureReason.Expired),
      expected: {
        metric: "loop.runner.refresh.failure",
        orgId: ORG_ID,
        reason: RefreshFailureReason.Expired,
        count: 1,
        _telemetryMetric: true,
      },
    },
    {
      name: "emitHeartbeatLag",
      invoke: () => emitHeartbeatLag(ORG_ID, LOOP_ID, 5000),
      expected: {
        metric: "loop.runner.heartbeat.lag",
        orgId: ORG_ID,
        loopId: LOOP_ID,
        value: 5000,
        _telemetryMetric: true,
      },
    },
    {
      name: "emitHeartbeatAccepted",
      invoke: () => emitHeartbeatAccepted(ORG_ID, LOOP_ID),
      expected: {
        metric: "loop.runner.heartbeat.accepted",
        orgId: ORG_ID,
        loopId: LOOP_ID,
        count: 1,
        _telemetryMetric: true,
      },
    },
    {
      name: "emitReapTransition",
      invoke: () => emitReapTransition(LOOP_ID, ReapReason.TokenExpired),
      expected: {
        metric: "loop.runner.reap.transition",
        loopId: LOOP_ID,
        reason: "token_expired",
        count: 1,
        _telemetryMetric: true,
      },
    },
    {
      name: "emitZombieDetector",
      invoke: () => emitZombieDetector(3),
      expected: {
        metric: "loop.runner.zombie_detector",
        count: 3,
        _telemetryMetric: true,
      },
    },
  ];

  test.each(emitterCases)("$name emits the full expected payload", ({
    invoke,
    expected,
  }) => {
    invoke();
    expect(mockLogInfo).toHaveBeenCalledOnce();
    expect(parsedLogCall()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// mapRefreshErrorCodeToReason — exhaustive enum coverage lives here, not in
// the emitter tests above. The 8→6 collapse (NotRunning+LoopNotFound and
// GenerationFailed+RaceLost) is visible directly in the table.
// ---------------------------------------------------------------------------

describe("mapRefreshErrorCodeToReason", () => {
  const mappingCases: Array<{
    code: RefreshTokenErrorCodeType;
    expected: RefreshFailureReason;
  }> = [
    {
      code: RefreshTokenErrorCode.TokenExpired,
      expected: RefreshFailureReason.Expired,
    },
    {
      code: RefreshTokenErrorCode.JtiMismatch,
      expected: RefreshFailureReason.JtiMismatch,
    },
    {
      code: RefreshTokenErrorCode.NotRunning,
      expected: RefreshFailureReason.TerminalStatus,
    },
    {
      code: RefreshTokenErrorCode.LoopNotFound,
      expected: RefreshFailureReason.TerminalStatus,
    },
    {
      code: RefreshTokenErrorCode.RateLimited,
      expected: RefreshFailureReason.RateLimited,
    },
    {
      code: RefreshTokenErrorCode.GenerationFailed,
      expected: RefreshFailureReason.Network,
    },
    {
      code: RefreshTokenErrorCode.JtiAlreadyUsed,
      expected: RefreshFailureReason.StaleIdempotencyKey,
    },
    {
      code: RefreshTokenErrorCode.RaceLost,
      expected: RefreshFailureReason.Network,
    },
  ];

  test.each(mappingCases)("maps $code → $expected", ({ code, expected }) => {
    expect(mapRefreshErrorCodeToReason(code)).toBe(expected);
  });
});
