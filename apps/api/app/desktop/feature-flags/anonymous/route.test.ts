import { DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER } from "@repo/api/src/types/desktop-feature-flags";
import {
  DesktopWriteLaneRejectReason,
  DesktopWriteLaneRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS } from "@/lib/fixed-window-rate-limiter";

const mocks = vi.hoisted(() => ({
  budget: vi.fn(),
  getAllFeatureFlagsForDistinctId: vi.fn(),
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));

vi.mock("@/lib/desktop-analytics-handler", () => ({
  consumeDesktopAnalyticsPreAuthBudget: mocks.budget,
}));

// The PostHog edge, mocked BELOW the real service, so what the route returns is
// what the shipped service builds from PostHog's answer.
vi.mock("@repo/analytics/feature-flags", () => ({
  getAllFeatureFlagsForDistinctId: mocks.getAllFeatureFlagsForDistinctId,
  isFeatureFlagEnabledForDistinctId: mocks.isFeatureFlagEnabledForDistinctId,
}));

import { GET } from "./route";

const NODE_UUID = "33333333-3333-4333-8333-333333333333";

describe("GET /desktop/feature-flags/anonymous (ISS-11945)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.budget.mockReturnValue(true);
    // PostHog would answer true for ANY key this id asks about, and the whole
    // assignment carries a key outside the allow-list.
    mocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(true);
    mocks.getAllFeatureFlagsForDistinctId.mockResolvedValue({
      "agents-nav": true,
      "desktop-session-replay": true,
    });
  });

  // The key is a literal on purpose: it names a PostHog flag (928548) this repo
  // does not own, so a rename of the shared constant must turn this red.
  it("answers only the allow-listed replay key, evaluated for the install's node_uuid", async () => {
    const response = await GET(anonymousRequest(NODE_UUID));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      userId: NODE_UUID,
      resolved: true,
      flags: { "desktop-session-replay": true },
    });
    expect(mocks.isFeatureFlagEnabledForDistinctId.mock.calls).toEqual([
      ["desktop-session-replay", NODE_UUID],
    ]);
    expect(mocks.getAllFeatureFlagsForDistinctId).not.toHaveBeenCalled();
    expect(mocks.budget).toHaveBeenCalledWith(NODE_UUID);
  });

  it("reports an unanswered evaluation as resolved:false, not as the key being off", async () => {
    mocks.isFeatureFlagEnabledForDistinctId.mockResolvedValue(null);

    const response = await GET(anonymousRequest(NODE_UUID));

    expect((await response.json()).data).toEqual({
      userId: NODE_UUID,
      resolved: false,
      flags: {},
    });
  });

  it.each([
    // Version nibble 1: a well-formed UUID, but not v4.
    ["a non-v4 UUID", "11111111-1111-1111-8111-111111111111"],
    ["a non-UUID", "../../not-a-uuid"],
    ["an empty value", ""],
    ["a missing header", null],
  ])(
    "rejects %s before PostHog or the budget is touched",
    async (_label, id) => {
      const response = await GET(anonymousRequest(id));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        code: DesktopWriteLaneRestErrorCode.ValidationFailed,
      });
      expect(mocks.isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalled();
      expect(mocks.budget).not.toHaveBeenCalled();
    }
  );

  it("429s an install whose pre-auth budget is spent, before PostHog is asked", async () => {
    mocks.budget.mockReturnValue(false);

    const response = await GET(anonymousRequest(NODE_UUID));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      success: false,
      error: "Rate limited",
      code: DesktopWriteLaneRejectReason.RateLimited,
    });
    expect(response.headers.get("Retry-After")).toBe(
      String(FIXED_WINDOW_RATE_LIMIT_RETRY_AFTER_SECONDS)
    );
    expect(mocks.isFeatureFlagEnabledForDistinctId).not.toHaveBeenCalled();
  });
});

const FLAGS_URL = "https://api.closedloop.ai/desktop/feature-flags/anonymous";

function anonymousRequest(nodeUuid: string | null): NextRequest {
  return new NextRequest(FLAGS_URL, {
    headers:
      nodeUuid === null
        ? {}
        : { [DESKTOP_FEATURE_FLAGS_NODE_UUID_HEADER]: nodeUuid },
  });
}
