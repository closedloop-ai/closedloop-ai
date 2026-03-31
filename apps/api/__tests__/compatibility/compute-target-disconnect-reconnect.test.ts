import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  INTERNAL_SECRET,
  makeEnvelope,
  makeSocketEventRequest,
  mockTarget,
} from "./utils/test-fixtures";

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      ...original.computeTargetsService,
      register: vi.fn(),
      updateOwned: vi.fn(),
      setOnlineState: vi.fn(),
    },
  };
});

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      listNonTerminalDispatchCommands: vi.fn(),
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
      clearOperationBacklog: vi.fn(),
    },
  };
});

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.setOnlineState).mockResolvedValue(true);
  vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(mockTarget);
  vi.mocked(
    desktopCommandStore.listNonTerminalDispatchCommands
  ).mockResolvedValue([]);
  vi.mocked(relayEventBus.clearOperationBacklog).mockImplementation(vi.fn());
});

describe("POST /internal/relay/socket-event — disconnect", () => {
  it("calls setOnlineState with false and returns empty emit array", async () => {
    const request = new Request(
      "http://localhost:3002/api/internal/relay/socket-event",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_SECRET,
        },
        body: JSON.stringify({
          event: "disconnect",
          targetId: "target-1",
          auth: { organizationId: "org-1", userId: "user-1" },
        }),
      }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.emit).toEqual([]);

    expect(
      vi.mocked(computeTargetsService.setOnlineState)
    ).toHaveBeenCalledWith("target-1", "org-1", "user-1", false);
  });
});

describe("POST /internal/relay/socket-event — reconnect (re-hello with existing targetId)", () => {
  it("returns desktop.hello.ack with resumeFromSequence for pending commands", async () => {
    vi.mocked(computeTargetsService.updateOwned).mockResolvedValue({
      ...mockTarget,
      id: "target-1",
    });
    vi.mocked(
      desktopCommandStore.listNonTerminalDispatchCommands
    ).mockResolvedValue([
      {
        commandId: "cmd-old",
        lastSequenceAcked: 5,
        operationId: "op-1",
        status: "running",
        method: "POST",
        path: "/api/engineer/symphony/chat/abc",
        createdAt: new Date().toISOString(),
      } as any,
    ]);

    const request = makeSocketEventRequest(
      "desktop.hello",
      {
        computeTargetId: "target-1",
        machineName: "test",
        platform: "darwin",
        pluginVersion: "1.0.0",
        supportedOperations: [],
        maxInFlightCommands: 1,
      },
      { auth: { organizationId: "org-1", userId: "user-1" } }
    );

    const response = await POST(request);
    expect(response.status).toBe(200);

    const result = await response.json();
    expect(result.emit[0].event).toBe("desktop.hello.ack");
    expect(result.emit[0].payload).toEqual(
      makeEnvelope({
        computeTargetId: "target-1",
        sessionId: expect.any(String),
        serverTime: expect.any(String),
        resumeFromSequence: { "cmd-old": 5 },
      })
    );
  });
});
