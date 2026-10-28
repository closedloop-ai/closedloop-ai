import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDesktopGatewayTestSockets,
  makeDesktopGatewayTestSocket,
} from "@/__tests__/support/lib/desktop-gateway-socket.test-harness";

const {
  mockAcknowledgeDesktopCommand,
  mockGetCommandById,
  mockHeartbeat,
  mockIngestCommandEvent,
  mockListNonTerminal,
  mockLogError,
  mockLogWarn,
  mockPublishLegacyRelayEvent,
  mockRegister,
  mockSetOnlineState,
  mockSigningEligibility,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
} = vi.hoisted(() => ({
  mockAcknowledgeDesktopCommand: vi.fn(),
  mockGetCommandById: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockIngestCommandEvent: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockPublishLegacyRelayEvent: vi.fn(),
  mockRegister: vi.fn(),
  mockSetOnlineState: vi.fn(),
  mockSigningEligibility: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: vi.fn(), warn: mockLogWarn },
}));

vi.mock("../desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: mockGetCommandById,
    ingestCommandEvent: mockIngestCommandEvent,
    listNonTerminalDispatchCommands: mockListNonTerminal,
  },
}));

vi.mock("../../app/compute-targets/service", () => ({
  computeTargetsService: {
    heartbeat: mockHeartbeat,
    register: mockRegister,
    setOnlineState: mockSetOnlineState,
    updateOwned: vi.fn(),
  },
  isComputeTargetGatewayConflictResult: () => false,
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: vi.fn(),
    subscribeOperations: mockSubscribeOperations,
    subscribeTargetConnection: mockSubscribeTargetConnection,
  },
}));

vi.mock("../compute-target-signing-eligibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../compute-target-signing-eligibility")
  >()),
  isDirectDesktopAuthSigningEligible: mockSigningEligibility,
}));

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: mockAcknowledgeDesktopCommand,
}));

import { CommandSigningEligibilityStatus } from "../compute-target-signing-eligibility";
import { handleSocketConnection } from "../desktop-gateway-socket-server";

const HELLO_PAYLOAD = {
  gatewayId: "gateway-1",
  machineName: "test-machine",
  maxInFlightCommands: 2,
  platform: "darwin",
  pluginVersion: "1.2.3",
  supportedOperations: [],
};

const COMMAND_ACK = {
  accepted: true,
  commandId: "cmd-1",
};

const COMMAND_EVENT = {
  commandId: "cmd-1",
  data: { terminal: false },
  eventType: "chunk",
  sequence: 1,
};

async function connectAndSayHello() {
  const result = makeDesktopGatewayTestSocket({ idPrefix: "handler-errors" });
  handleSocketConnection(result.socket as never);
  await result.handlers.get("desktop.hello")?.(HELLO_PAYLOAD);
  await vi.waitFor(() => {
    const ack = result.socket.emit.mock.calls.find(
      ([event, payload]) =>
        event === "desktop.hello.ack" &&
        (payload as { computeTargetId?: string }).computeTargetId === "target-1"
    );
    if (!ack) {
      throw new Error("desktop.hello.ack was not emitted for target-1");
    }
  });
  result.socket.emit.mockClear();
  return result;
}

describe("direct socket handler refusal and recovery branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({ ok: true, value: { id: "target-1" } });
    mockListNonTerminal.mockResolvedValue([]);
    mockSubscribeOperations.mockReturnValue(() => {});
    mockSubscribeTargetConnection.mockReturnValue(() => {});
    mockHeartbeat.mockResolvedValue(undefined);
    mockSetOnlineState.mockResolvedValue(true);
    mockSigningEligibility.mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    });
    mockAcknowledgeDesktopCommand.mockResolvedValue(undefined);
    mockIngestCommandEvent.mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
    mockGetCommandById.mockResolvedValue(null);
    mockPublishLegacyRelayEvent.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await cleanupDesktopGatewayTestSockets();
    vi.restoreAllMocks();
  });

  it("force-disconnects before registering handlers when auth context is absent", () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket({
      authenticated: false,
      idPrefix: "missing-auth",
    });

    handleSocketConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(handlers.size).toBe(0);
  });

  it.each([
    ["desktop.presence", undefined],
    ["desktop.command.ack", COMMAND_ACK],
    ["desktop.command.event", COMMAND_EVENT],
  ])("ignores %s before hello establishes context", (event, payload) => {
    const { handlers, socket } = makeDesktopGatewayTestSocket({
      idPrefix: "no-context",
    });
    handleSocketConnection(socket as never);

    handlers.get(event)?.(payload);

    expect(mockHeartbeat).not.toHaveBeenCalled();
    expect(mockAcknowledgeDesktopCommand).not.toHaveBeenCalled();
    expect(mockIngestCommandEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["desktop.command.ack", { accepted: "yes", commandId: "cmd-1" }],
    [
      "desktop.command.event",
      { commandId: "cmd-1", eventType: "chunk", sequence: 0 },
    ],
  ])("ignores malformed %s payloads", async (event, payload) => {
    const { handlers } = await connectAndSayHello();

    handlers.get(event)?.(payload);
    await Promise.resolve();

    expect(mockAcknowledgeDesktopCommand).not.toHaveBeenCalled();
    expect(mockIngestCommandEvent).not.toHaveBeenCalled();
  });

  it("logs an attributed command-ack dependency rejection", async () => {
    mockAcknowledgeDesktopCommand.mockRejectedValue(new Error("ack failed"));
    const { handlers } = await connectAndSayHello();

    handlers.get("desktop.command.ack")?.(COMMAND_ACK);

    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed handling desktop.command.ack",
        expect.objectContaining({
          commandId: "cmd-1",
          computeTargetId: "target-1",
          error: expect.any(Error),
        })
      );
    });
  });

  it("logs an attributed presence dependency rejection", async () => {
    mockHeartbeat.mockRejectedValue(new Error("heartbeat failed"));
    const { handlers } = await connectAndSayHello();

    handlers.get("desktop.presence")?.();

    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed updating desktop presence heartbeat",
        expect.objectContaining({
          computeTargetId: "target-1",
          error: expect.any(Error),
        })
      );
    });
  });

  it("does not recover an unknown-command rejection as a sequence gap", async () => {
    mockIngestCommandEvent.mockResolvedValue({
      accepted: false,
      reason: "unknown_command",
    });
    const { handlers, socket } = await connectAndSayHello();

    handlers.get("desktop.command.event")?.(COMMAND_EVENT);

    await vi.waitFor(() => {
      expect(mockIngestCommandEvent).toHaveBeenCalledOnce();
    });
    expect(mockGetCommandById).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("emits no recovery frame when the sequence-gap row is absent", async () => {
    mockIngestCommandEvent.mockResolvedValue({
      accepted: false,
      reason: "sequence_gap",
    });
    mockGetCommandById.mockResolvedValue(null);
    const { handlers, socket } = await connectAndSayHello();

    handlers.get("desktop.command.event")?.(COMMAND_EVENT);

    await vi.waitFor(() => {
      expect(mockGetCommandById).toHaveBeenCalledWith("cmd-1");
    });
    expect(socket.emit).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("contains an ingestion rejection and still processes the next event for the same command", async () => {
    mockIngestCommandEvent
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce({
        accepted: true,
        duplicate: false,
        sequence: 2,
      });
    const { handlers, socket } = await connectAndSayHello();

    handlers.get("desktop.command.event")?.(COMMAND_EVENT);
    handlers.get("desktop.command.event")?.({ ...COMMAND_EVENT, sequence: 2 });

    await vi.waitFor(() => {
      expect(mockIngestCommandEvent).toHaveBeenCalledTimes(2);
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.command.event.ack",
        expect.objectContaining({ commandId: "cmd-1", sequence: 2 })
      );
    });
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed handling desktop.command.event",
      expect.objectContaining({
        commandId: "cmd-1",
        computeTargetId: "target-1",
        error: expect.any(Error),
      })
    );
  });
});
