import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { PROTOCOL_VERSION } from "@/lib/desktop-gateway-types";
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
  vi.mocked(computeTargetsService.register).mockResolvedValue(mockTarget);
  vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(mockTarget);
  vi.mocked(computeTargetsService.setOnlineState).mockResolvedValue(true);
  vi.mocked(
    desktopCommandStore.listNonTerminalDispatchCommands
  ).mockResolvedValue([]);
  vi.mocked(relayEventBus.clearOperationBacklog).mockImplementation(vi.fn());
});

describe("POST /internal/relay/socket-event — desktop.hello", () => {
  it("returns desktop.hello.ack with envelope for a new target registration", async () => {
    const request = makeSocketEventRequest("desktop.hello", {
      machineName: mockTarget.machineName,
      platform: mockTarget.platform,
      pluginVersion: "1.0.0",
      supportedOperations: mockTarget.supportedOperations,
      maxInFlightCommands: 4,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.emit).toHaveLength(1);
    expect(body.emit[0].event).toBe("desktop.hello.ack");
    expect(body.emit[0].payload).toEqual(
      makeEnvelope({
        computeTargetId: mockTarget.id,
        sessionId: expect.any(String),
        serverTime: expect.any(String),
      })
    );
  });
});

describe("PROTOCOL_VERSION", () => {
  it("equals '1'", () => {
    expect(PROTOCOL_VERSION).toBe("1");
  });
});
