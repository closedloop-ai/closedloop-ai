/**
 * Unit tests for the server-side `request_prd_changes` admission gate.
 *
 * The PRD editor hides the "Amend PRD" menu item behind the
 * `prd-request-changes` flag, but the run-loop endpoint must independently
 * fail closed so a stale client or direct API call cannot dispatch the
 * dark-launched command. See FEA-2925.
 */

import {
  PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: (...args: unknown[]) =>
    mockState.isFeatureFlagEnabledForDistinctId(...args),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  enforcePrdRequestChangesGate,
  isPrdRequestChangesEnabled,
} from "@/lib/loops/prd-request-changes-feature";

const identity = { userId: "user-1", clerkUserId: "clerk-1" };

describe("isPrdRequestChangesEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when PostHog returns explicit true for a distinct id", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);

    await expect(isPrdRequestChangesEnabled(identity)).resolves.toBe(true);
    expect(mockState.isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
      "clerk-1"
    );
  });

  it("checks the org user id when the clerk id evaluates false", async () => {
    mockState.isFeatureFlagEnabledForDistinctId
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(isPrdRequestChangesEnabled(identity)).resolves.toBe(true);
    expect(mockState.isFeatureFlagEnabledForDistinctId).toHaveBeenNthCalledWith(
      2,
      PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
      "user-1"
    );
  });

  it("fails closed to false when every distinct id evaluates false", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    await expect(isPrdRequestChangesEnabled(identity)).resolves.toBe(false);
  });

  it("fails closed to false when PostHog returns null (unavailable)", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);

    await expect(isPrdRequestChangesEnabled(identity)).resolves.toBe(false);
  });

  it("fails closed to false when flag evaluation throws", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockRejectedValue(
      new Error("posthog down")
    );

    await expect(isPrdRequestChangesEnabled(identity)).resolves.toBe(false);
  });
});

describe("enforcePrdRequestChangesGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null (allow) for non-request_prd_changes commands without checking the flag", async () => {
    await expect(
      enforcePrdRequestChangesGate(RunLoopCommand.Plan, identity)
    ).resolves.toBeNull();
    expect(mockState.isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalled();
  });

  it("returns null (allow) for request_prd_changes when the flag is enabled", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);

    await expect(
      enforcePrdRequestChangesGate(RunLoopCommand.RequestPrdChanges, identity)
    ).resolves.toBeNull();
  });

  it("returns a 403 response for request_prd_changes when the flag is off", async () => {
    mockState.isFeatureFlagEnabledForDistinctId.mockResolvedValue(false);

    const response = await enforcePrdRequestChangesGate(
      RunLoopCommand.RequestPrdChanges,
      identity
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
  });
});
