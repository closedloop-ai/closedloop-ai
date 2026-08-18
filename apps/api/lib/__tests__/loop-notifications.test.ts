/**
 * Unit tests for apps/api/lib/loop-notifications.ts
 *
 * Verifies dispatchLoopCompletedNotification:
 * - sends the in-app inbox notification with the correct relative loop
 *   deep-link when the rollout flag is enabled
 * - no-ops (no send) when the flag is off
 * - fails closed (no send) when the flag evaluation throws — a regression here
 *   would silently spam or drop notifications with nothing to catch it
 * - treats a non-boolean flag value as disabled (the gate is strict `=== true`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const isFeatureFlagEnabledForDistinctId = vi.fn();
const sendLoopCompletedNotification = vi.fn();

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => e,
}));

// Run the waitUntil-wrapped promise inline and surface it so tests can await it.
let lastDispatched: Promise<unknown> | undefined;
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    lastDispatched = p;
  },
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: (...args: unknown[]) =>
    isFeatureFlagEnabledForDistinctId(...args),
}));

vi.mock("@repo/collaboration/server/inbox-notifications", () => ({
  sendLoopCompletedNotification: (...args: unknown[]) =>
    sendLoopCompletedNotification(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  dispatchLoopCompletedNotification,
  LOOP_COMPLETED_NOTIFICATION_FEATURE_FLAG_KEY,
} from "../loop-notifications";

const PARAMS = {
  userId: "user-1",
  organizationId: "org-1",
  loopId: "loop-abc",
  loopTitle: "Refactor auth",
};

beforeEach(() => {
  vi.clearAllMocks();
  lastDispatched = undefined;
  isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);
  sendLoopCompletedNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchLoopCompletedNotification", () => {
  it("sends the inbox notification with the correct relative loop deep-link", async () => {
    dispatchLoopCompletedNotification(PARAMS);
    await lastDispatched;

    // The rollout gate is evaluated against the internal DB user id.
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      LOOP_COMPLETED_NOTIFICATION_FEATURE_FLAG_KEY,
      "user-1"
    );
    expect(sendLoopCompletedNotification).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      subjectId: "loop-abc",
      loopTitle: "Refactor auth",
      loopUrl: "/loops/loop-abc",
    });
  });

  it("no-ops when the flag is off", async () => {
    isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    dispatchLoopCompletedNotification(PARAMS);
    await lastDispatched;

    expect(sendLoopCompletedNotification).not.toHaveBeenCalled();
  });

  it("fails closed (no send) when flag evaluation throws", async () => {
    isFeatureFlagEnabledForDistinctId.mockRejectedValue(new Error("posthog"));

    dispatchLoopCompletedNotification(PARAMS);
    await lastDispatched;

    // A flag-eval error must never fall through to a send — that would silently
    // spam an unintended audience the rollout was meant to exclude.
    expect(sendLoopCompletedNotification).not.toHaveBeenCalled();
  });

  it("treats a non-boolean (truthy) flag value as disabled", async () => {
    // The gate is a strict `=== true` comparison: a truthy-but-non-boolean
    // PostHog payload (e.g. a multivariate string) must NOT be read as enabled.
    isFeatureFlagEnabledForDistinctId.mockResolvedValue(
      "enabled-variant" as unknown as boolean
    );

    dispatchLoopCompletedNotification(PARAMS);
    await lastDispatched;

    expect(sendLoopCompletedNotification).not.toHaveBeenCalled();
  });
});
