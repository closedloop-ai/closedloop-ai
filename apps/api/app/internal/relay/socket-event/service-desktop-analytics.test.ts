import {
  DESKTOP_ANALYTICS_SOCKET_EVENT,
  DesktopAnalyticsAckReason,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDesktopAnalyticsEvent } from "@/lib/desktop-analytics-handler";
import { dispatchSocketEvent } from "./service";

vi.mock("@/lib/desktop-analytics-handler", () => ({
  handleDesktopAnalyticsEvent: vi.fn(),
}));

describe("dispatchSocketEvent desktop.analytics", () => {
  beforeEach(() => {
    vi.mocked(handleDesktopAnalyticsEvent).mockReset();
  });

  it("routes authenticated relay analytics to the shared handler and returns ack", async () => {
    vi.mocked(handleDesktopAnalyticsEvent).mockResolvedValue({
      accepted: true,
    });

    const payload = {
      event: "command_completed",
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: { command_id: "cmd-1" },
      pluginVersion: "1.0.0",
    };
    const response = await dispatchSocketEvent({
      event: DESKTOP_ANALYTICS_SOCKET_EVENT,
      payload,
      auth: {
        organizationId: "org-1",
        userId: "user_db_1",
        clerkUserId: "clerk_user_1",
      },
      targetId: "target-1",
      correlation: { gatewaySessionId: "session-1" },
      pluginVersion: "1.0.0",
      relaySocketId: "socket-1",
      requestArrivedAt: 1000,
    });

    expect(response).toEqual({
      ok: true,
      response: { emit: [], ack: { accepted: true } },
    });
    expect(handleDesktopAnalyticsEvent).toHaveBeenCalledWith(
      payload,
      {
        organizationId: "org-1",
        userId: "user_db_1",
        clerkUserId: "clerk_user_1",
        targetId: "target-1",
        gatewaySessionId: "session-1",
        pluginVersion: "1.0.0",
        relaySocketId: "socket-1",
      },
      { capture: expect.any(Function) }
    );
  });

  it("routes Desktop agent-session sync failure analytics unchanged to the shared handler", async () => {
    vi.mocked(handleDesktopAnalyticsEvent).mockResolvedValue({
      accepted: true,
    });

    const payload = {
      event: DesktopAnalyticsEventName.AgentSessionSyncBatchFailed,
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: {
        reason: "ack_timeout",
        sync_mode: "backfill",
        session_count: 42,
        payload_bytes: 4096,
      },
      pluginVersion: "1.0.0",
    };

    await expect(
      dispatchSocketEvent({
        event: DESKTOP_ANALYTICS_SOCKET_EVENT,
        payload,
        auth: {
          organizationId: "org-1",
          userId: "user_db_1",
          clerkUserId: "clerk_user_1",
        },
        targetId: "target-1",
        correlation: { gatewaySessionId: "session-1" },
        pluginVersion: "1.0.0",
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: { emit: [], ack: { accepted: true } },
    });

    expect(handleDesktopAnalyticsEvent).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        targetId: "target-1",
        gatewaySessionId: "session-1",
        relaySocketId: "socket-1",
      }),
      { capture: expect.any(Function) }
    );
  });

  it.each([
    DesktopAnalyticsAckReason.FeatureDisabled,
    DesktopAnalyticsAckReason.RateLimited,
    DesktopAnalyticsAckReason.ValidationFailed,
  ])("returns %s ack from the shared handler", async (reason) => {
    vi.mocked(handleDesktopAnalyticsEvent).mockResolvedValue({
      accepted: false,
      reason,
    });

    await expect(
      dispatchSocketEvent({
        event: DESKTOP_ANALYTICS_SOCKET_EVENT,
        payload: {
          event: "desktop_connection_established",
          occurredAt: "2026-05-12T00:00:00.000Z",
          properties: { desktop_client_version: "0.15.3" },
        },
        auth: {
          organizationId: "org-1",
          userId: "user_db_1",
          clerkUserId: "clerk_user_1",
        },
        targetId: "target-1",
        correlation: { gatewaySessionId: "session-1" },
        pluginVersion: "1.0.0",
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: { emit: [], ack: { accepted: false, reason } },
    });
  });

  it("rejects relay analytics without authenticated target context", async () => {
    await expect(
      dispatchSocketEvent({
        event: DESKTOP_ANALYTICS_SOCKET_EVENT,
        payload: {},
        auth: null,
        targetId: "target-1",
        correlation: {},
        pluginVersion: undefined,
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: false,
      error: "Missing auth/targetId",
      status: 400,
    });
    expect(handleDesktopAnalyticsEvent).not.toHaveBeenCalled();
  });
});
