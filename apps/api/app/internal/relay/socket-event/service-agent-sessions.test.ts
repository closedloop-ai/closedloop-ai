import {
  DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { dispatchSocketEvent } from "./service";

vi.mock("@/lib/desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: vi.fn(),
}));

describe("dispatchSocketEvent desktop.agent-sessions", () => {
  beforeEach(() => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockReset();
  });

  it("routes authenticated relay session sync payloads through the shared handler", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValue({
      accepted: true,
    });

    const payload = {
      schemaVersion: 1,
      batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
      syncMode: "incremental",
      sessionCount: 0,
      sessions: [],
    };

    await expect(
      dispatchSocketEvent({
        event: DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
        payload,
        auth: {
          organizationId: "org-1",
          userId: "user-db-1",
          clerkUserId: "clerk-user-1",
        },
        targetId: "target-1",
        correlation: { gatewaySessionId: "session-1" },
        pluginVersion: undefined,
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: { emit: [], ack: { accepted: true } },
    });

    expect(handleDesktopAgentSessionsEvent).toHaveBeenCalledWith(payload, {
      organizationId: "org-1",
      userId: "user-db-1",
      clerkUserId: "clerk-user-1",
      targetId: "target-1",
      gatewaySessionId: "session-1",
      relaySocketId: "socket-1",
    });
  });

  it("returns explicit ack reasons from the shared handler", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValue({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    });

    await expect(
      dispatchSocketEvent({
        event: DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
        payload: {},
        auth: {
          organizationId: "org-1",
          userId: "user-db-1",
          clerkUserId: "clerk-user-1",
        },
        targetId: "target-1",
        correlation: {},
        pluginVersion: undefined,
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: {
        emit: [],
        ack: {
          accepted: false,
          reason: DesktopAgentSessionsAckReason.FeatureDisabled,
        },
      },
    });
  });

  it("rejects relay session sync events without authenticated target context", async () => {
    await expect(
      dispatchSocketEvent({
        event: DESKTOP_AGENT_SESSIONS_SOCKET_EVENT,
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
  });
});
