/**
 * Tier-2 compatibility: cancellation flow.
 *
 * Validates that the internal relay socket-event route handles:
 * 1. A `desktop.command.ack` with `accepted: false` (cancelled) — calls
 *    `acknowledgeCommand` with the correct arguments.
 * 2. A subsequent `desktop.command.event` for a cancelled command — returns
 *    HTTP 200 (the route does not reject events after cancellation).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports that transitively pull in the mocked modules) ---

vi.mock("@/lib/internal-auth", () => ({
  validateInternalSecret: vi.fn().mockReturnValue(true),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    updateOwned: vi.fn(),
    register: vi.fn(),
    setOnlineState: vi.fn(),
    heartbeat: vi.fn(),
  },
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: vi.fn(),
    publishResult: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    acknowledgeCommand: vi.fn().mockResolvedValue(null),
    ingestCommandEvent: vi.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    }),
    getCommandById: vi.fn().mockResolvedValue({
      commandId: "cmd-1",
      computeTargetId: "target-1",
      operationId: "op-1",
      status: "cancelled",
      createdAt: new Date().toISOString(),
      lastSequenceAcked: 0,
    }),
    listNonTerminalDispatchCommands: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/loops/rejected-command-loop-failure", () => ({
  failLoopFromRejectedCommand: vi.fn().mockResolvedValue({ failed: false }),
}));

// --- Imports (after mocks) ---

import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET_ID = "target-1";

function makeRequest(event: string, payload: Record<string, unknown>): Request {
  return new Request("http://localhost:3002/api/internal/relay/socket-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload, targetId: TARGET_ID }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tier-2: cancellation flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(desktopCommandStore.acknowledgeCommand).mockResolvedValue(null);
    vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
    vi.mocked(desktopCommandStore.getCommandById).mockResolvedValue({
      commandId: "cmd-1",
      computeTargetId: TARGET_ID,
      operationId: "op-1",
      status: "cancelled",
      createdAt: new Date().toISOString(),
      lastSequenceAcked: 0,
    } as any);
  });

  describe("desktop.command.ack with accepted: false", () => {
    it("returns HTTP 200", async () => {
      const request = makeRequest("desktop.command.ack", {
        commandId: "cmd-1",
        accepted: false,
        reason: "cancelled",
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("calls acknowledgeCommand with commandId, accepted=false, reason, and targetId", async () => {
      const request = makeRequest("desktop.command.ack", {
        commandId: "cmd-1",
        accepted: false,
        reason: "cancelled",
      });

      await POST(request);

      expect(desktopCommandStore.acknowledgeCommand).toHaveBeenCalledWith(
        "cmd-1",
        false,
        "cancelled",
        TARGET_ID,
        undefined
      );
    });

    it("calls ingestCommandEvent with a terminal error event when ack is rejected", async () => {
      const request = makeRequest("desktop.command.ack", {
        commandId: "cmd-1",
        accepted: false,
        reason: "cancelled",
      });

      await POST(request);

      expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: "cmd-1",
          eventType: "error",
          computeTargetId: TARGET_ID,
        })
      );
    });
  });

  describe("desktop.command.event after cancellation", () => {
    it("returns HTTP 200 for a subsequent event after command is cancelled", async () => {
      const request = makeRequest("desktop.command.event", {
        commandId: "cmd-1",
        sequence: 2,
        eventType: "chunk",
        data: { text: "late chunk" },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it("does not reject subsequent events — ingestCommandEvent is invoked", async () => {
      const request = makeRequest("desktop.command.event", {
        commandId: "cmd-1",
        sequence: 2,
        eventType: "chunk",
        data: { text: "late chunk" },
      });

      await POST(request);

      expect(desktopCommandStore.ingestCommandEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: "cmd-1",
          sequence: 2,
          computeTargetId: TARGET_ID,
        })
      );
    });
  });
});
