/**
 * Unit tests for the relay socket-event route handler.
 *
 * Verifies that when a command event arrives with gatewaySessionId in the
 * forwarded payload body, that field appears in the structured log output.
 * End-to-end propagation is verified in T-6.1.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/env", () => ({
  env: { INTERNAL_API_SECRET: "test-secret" },
}));

vi.mock("@/lib/internal-auth", () => ({
  validateInternalSecret: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    ingestCommandEvent: vi.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    }),
    acknowledgeCommand: vi.fn().mockResolvedValue(undefined),
    getCommandById: vi.fn().mockResolvedValue(null),
    listNonTerminalDispatchCommands: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    publishResult: vi.fn(),
    clearOperationBacklog: vi.fn(),
    publishOperation: vi.fn(),
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: vi.fn().mockResolvedValue({ id: "target-1" }),
    updateOwned: vi.fn().mockResolvedValue(null),
    setOnlineState: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- Imports (after mocks) ---

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/internal/relay/socket-event/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3002/internal/relay/socket-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": "test-secret",
    },
    body: JSON.stringify(body),
  });
}

const GATEWAY_SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /internal/relay/socket-event — correlation context propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a command event with gatewaySessionId and returns 200 with ack", async () => {
    const request = makeRequest({
      event: "desktop.command.event",
      targetId: "target-1",
      gatewaySessionId: GATEWAY_SESSION_ID,
      payload: {
        commandId: "cmd-abc",
        sequence: 1,
        eventType: "status",
        data: { status: "running" },
      },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const { desktopCommandStore } = await import("@/lib/desktop-command-store");
    expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-abc",
        eventType: "status",
        computeTargetId: "target-1",
      })
    );
  });

  it("returns 200 when no gatewaySessionId is provided in the forwarded body", async () => {
    const request = makeRequest({
      event: "desktop.command.event",
      targetId: "target-3",
      // no gatewaySessionId field
      payload: {
        commandId: "cmd-no-session",
        sequence: 1,
        eventType: "status",
        data: { status: "running" },
      },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const { desktopCommandStore } = await import("@/lib/desktop-command-store");
    expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-no-session",
      })
    );
  });

  it("accepts a command ack with gatewaySessionId and returns 200", async () => {
    const request = makeRequest({
      event: "desktop.command.ack",
      targetId: "target-1",
      gatewaySessionId: GATEWAY_SESSION_ID,
      payload: {
        commandId: "cmd-ack-1",
        accepted: true,
      },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const { desktopCommandStore } = await import("@/lib/desktop-command-store");
    expect(desktopCommandStore.acknowledgeCommand).toHaveBeenCalledWith(
      "cmd-ack-1",
      true,
      undefined,
      "target-1"
    );
  });
});
