import {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { captureDesktopAnalytics } from "@/lib/desktop-analytics-capture";
import { handleDesktopAnalyticsEvent } from "@/lib/desktop-analytics-handler";
import { desktopAnalyticsService } from "./service";

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: vi.fn(),
}));

vi.mock("@/lib/desktop-analytics-capture", () => ({
  captureDesktopAnalytics: vi.fn(),
}));

const CAPTURE_INPUT = {
  clerkUserId: "clerk-user-1",
  computeTargetId: "target-1",
  organizationId: "org-1",
  pluginVersion: "0.16.71",
  rawBody: {
    event: DesktopAnalyticsEventName.CommandCompleted,
    occurredAt: "2026-07-23T00:00:00.000Z",
    properties: { command_id: "cmd-1" },
  },
  userId: "user-1",
};

describe("desktopAnalyticsService.capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
      id: "target-1",
    } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
    vi.mocked(handleDesktopAnalyticsEvent).mockResolvedValue({
      accepted: true,
    });
  });

  it("rejects an unowned compute target before invoking the shared handler", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValueOnce(null);

    const result = await desktopAnalyticsService.capture(CAPTURE_INPUT);

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    expect(handleDesktopAnalyticsEvent).not.toHaveBeenCalled();
  });

  // FEA-3425 parity note: the socket path additionally passes
  // gatewaySessionId/relaySocketId from its live connection; the stateless REST
  // twin has neither, which the handler treats as the `direct:` rate-limit
  // namespace. Everything else — including the shared capture sink — must match.
  it("delegates owned-target events to the shared handler with the shared capture sink", async () => {
    const result = await desktopAnalyticsService.capture(CAPTURE_INPUT);

    expect(result).toEqual({ ok: true, value: { captured: true } });
    expect(handleDesktopAnalyticsEvent).toHaveBeenCalledWith(
      CAPTURE_INPUT.rawBody,
      {
        organizationId: "org-1",
        userId: "user-1",
        clerkUserId: "clerk-user-1",
        targetId: "target-1",
        pluginVersion: "0.16.71",
      },
      { capture: captureDesktopAnalytics }
    );
  });

  it("surfaces handler rejections as typed errors", async () => {
    vi.mocked(handleDesktopAnalyticsEvent).mockResolvedValueOnce({
      accepted: false,
      reason: DesktopAnalyticsAckReason.FeatureDisabled,
    });

    const result = await desktopAnalyticsService.capture(CAPTURE_INPUT);

    expect(result).toEqual({
      ok: false,
      error: DesktopAnalyticsAckReason.FeatureDisabled,
    });
  });
});
