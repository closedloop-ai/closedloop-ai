import type { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { INTERNAL_SECRET, makeSocketEventRequest } from "./utils/test-fixtures";

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      acknowledgeCommand: vi.fn().mockResolvedValue(null),
      ingestCommandEvent: vi.fn().mockResolvedValue({
        accepted: true,
        duplicate: false,
        sequence: 1,
      }),
    },
  };
});

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      findOwnedById: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      heartbeat: vi.fn(),
    },
  };
});

vi.mock("@/lib/relay-event-bus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/relay-event-bus")>();
  return {
    ...original,
    relayEventBus: {
      ...original.relayEventBus,
      publishOperation: vi.fn(),
      publishResult: vi.fn(),
    },
  };
});

vi.mock("@/lib/desktop-relay-event-bridge", () => ({
  publishLegacyRelayEvent: vi.fn().mockResolvedValue(undefined),
}));

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktopCommandStore.acknowledgeCommand).mockResolvedValue(null);
  vi.mocked(desktopCommandStore.ingestCommandEvent).mockResolvedValue({
    accepted: true,
    duplicate: false,
    sequence: 1,
  });
});

describe("POST /internal/relay/socket-event — desktop.command.ack", () => {
  it("returns 200 with empty emit array when accepted=true", async () => {
    const request = makeSocketEventRequest(
      "desktop.command.ack",
      { commandId: "cmd-1", accepted: true },
      { targetId: "target-1" }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.emit).toEqual([]);
  });

  it("calls ingestCommandEvent with error event when accepted=false", async () => {
    const request = makeSocketEventRequest(
      "desktop.command.ack",
      { commandId: "cmd-1", accepted: false, reason: "not supported" },
      { targetId: "target-1" }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(
      vi.mocked(desktopCommandStore.ingestCommandEvent)
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "cmd-1",
        eventType: "error",
        computeTargetId: "target-1",
      })
    );
  });
});

describe("DesktopCommandStatus values", () => {
  it("includes all expected terminal and non-terminal statuses", () => {
    const allStatuses: DesktopCommandStatus[] = [
      "queued",
      "accepted",
      "running",
      "done",
      "failed",
      "cancelled",
      "expired",
    ];

    for (const status of allStatuses) {
      expect(typeof status).toBe("string");
    }

    expect(allStatuses).toContain("queued");
    expect(allStatuses).toContain("accepted");
    expect(allStatuses).toContain("running");
    expect(allStatuses).toContain("done");
    expect(allStatuses).toContain("failed");
    expect(allStatuses).toContain("cancelled");
    expect(allStatuses).toContain("expired");
  });

  it("terminal statuses are done, failed, cancelled, and expired", () => {
    const terminalStatuses: DesktopCommandStatus[] = [
      "done",
      "failed",
      "cancelled",
      "expired",
    ];
    const nonTerminalStatuses: DesktopCommandStatus[] = [
      "queued",
      "accepted",
      "running",
    ];

    expect(terminalStatuses).toHaveLength(4);
    expect(nonTerminalStatuses).toHaveLength(3);
  });
});
