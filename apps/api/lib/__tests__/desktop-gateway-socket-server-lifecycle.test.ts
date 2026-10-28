import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDesktopGatewayTestSockets,
  makeDesktopGatewayTestSocket,
} from "@/__tests__/support/lib/desktop-gateway-socket.test-harness";

const {
  mockClearOperationBacklog,
  mockHeartbeat,
  mockListNonTerminal,
  mockLogError,
  mockLogInfo,
  mockLogWarn,
  mockRegister,
  mockSetOnlineState,
  mockSigningEligibility,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
  mockUnsubscribeOperations,
  mockUnsubscribeTargetConnection,
  mockUpdateOwned,
} = vi.hoisted(() => ({
  mockClearOperationBacklog: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockLogError: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockRegister: vi.fn(),
  mockSetOnlineState: vi.fn(),
  mockSigningEligibility: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
  mockUnsubscribeOperations: vi.fn(),
  mockUnsubscribeTargetConnection: vi.fn(),
  mockUpdateOwned: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mockLogError, info: mockLogInfo, warn: mockLogWarn },
}));

vi.mock("../desktop-command-store", () => ({
  desktopCommandStore: {
    getCommandById: vi.fn(),
    ingestCommandEvent: vi.fn(),
    listNonTerminalDispatchCommands: mockListNonTerminal,
  },
}));

vi.mock("../../app/compute-targets/service", () => ({
  computeTargetsService: {
    heartbeat: mockHeartbeat,
    register: mockRegister,
    setOnlineState: mockSetOnlineState,
    updateOwned: mockUpdateOwned,
  },
  isComputeTargetGatewayConflictResult: (result: {
    ok: boolean;
    error?: string;
  }) => !result.ok && result.error === "gateway_conflict",
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: mockClearOperationBacklog,
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
  acknowledgeDesktopCommand: vi.fn(),
}));

import { CommandSigningEligibilityStatus } from "../compute-target-signing-eligibility";
import { handleSocketConnection } from "../desktop-gateway-socket-server";

const BASE_HELLO = {
  gatewayId: "gateway-1",
  machineName: "test-machine",
  maxInFlightCommands: 2,
  platform: "darwin",
  pluginVersion: "1.2.3",
  supportedOperations: [],
};

function beginHello(overrides: Record<string, unknown> = {}) {
  const result = makeDesktopGatewayTestSocket({ idPrefix: "lifecycle" });
  handleSocketConnection(result.socket as never);
  result.handlers.get("desktop.hello")?.({ ...BASE_HELLO, ...overrides });
  return result;
}

async function waitForNack(
  socket: ReturnType<typeof makeDesktopGatewayTestSocket>["socket"],
  reason: DesktopHelloNackReason
) {
  await vi.waitFor(() => {
    const nack = socket.emit.mock.calls.find(
      ([event, payload]) =>
        event === "desktop.hello.nack" &&
        (payload as { reason?: DesktopHelloNackReason }).reason === reason
    );
    if (!nack || socket.disconnect.mock.calls.length === 0) {
      throw new Error(`desktop.hello.nack was not emitted for ${reason}`);
    }
  });
}

describe("direct socket hello and connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({ ok: true, value: { id: "target-1" } });
    mockUpdateOwned.mockResolvedValue({
      ok: true,
      value: { id: "target-existing" },
    });
    mockListNonTerminal.mockResolvedValue([]);
    mockSetOnlineState.mockResolvedValue(true);
    mockHeartbeat.mockResolvedValue(undefined);
    mockSigningEligibility.mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    });
    mockSubscribeOperations.mockReturnValue(mockUnsubscribeOperations);
    mockSubscribeTargetConnection.mockReturnValue(
      mockUnsubscribeTargetConnection
    );
  });

  afterEach(async () => {
    await cleanupDesktopGatewayTestSockets();
    vi.restoreAllMocks();
  });

  it("nacks and disconnects when updating an existing target rejects", async () => {
    mockUpdateOwned.mockRejectedValue(new Error("update failed"));

    const { socket } = beginHello({ computeTargetId: "target-existing" });

    await waitForNack(socket, DesktopHelloNackReason.ComputeTargetUpdateFailed);
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.ComputeTargetUpdateFailed,
      })
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("nacks and disconnects when target registration rejects", async () => {
    mockRegister.mockRejectedValue(new Error("register failed"));

    const { socket } = beginHello();

    await waitForNack(
      socket,
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
      })
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("disconnects an update-owned gateway conflict without a nack or fallback registration", async () => {
    mockUpdateOwned.mockResolvedValue({
      ok: false,
      error: "gateway_conflict",
    });

    const { socket } = beginHello({ computeTargetId: "target-existing" });

    await vi.waitFor(() => {
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
    expect(socket.emit).not.toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.anything()
    );
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("disconnects a registration gateway conflict without a nack", async () => {
    mockRegister.mockResolvedValue({ ok: false, error: "gateway_conflict" });

    const { socket } = beginHello();

    await vi.waitFor(() => {
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
    expect(socket.emit).not.toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.anything()
    );
  });

  it("nacks and disconnects when pending-command lookup rejects", async () => {
    mockListNonTerminal.mockRejectedValue(new Error("lookup failed"));

    const { socket } = beginHello();

    await waitForNack(
      socket,
      DesktopHelloNackReason.PendingCommandsLookupFailed
    );
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.PendingCommandsLookupFailed,
      })
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("nacks and disconnects when the online-state update rejects", async () => {
    mockSetOnlineState.mockRejectedValue(new Error("online failed"));

    const { socket } = beginHello({ computeTargetId: "target-existing" });

    await waitForNack(socket, DesktopHelloNackReason.OnlineStateUpdateFailed);
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.hello.nack",
      expect.objectContaining({
        reason: DesktopHelloNackReason.OnlineStateUpdateFailed,
      })
    );
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("compensates and emits no ack when the socket disconnects mid-hello", async () => {
    const second = makeDesktopGatewayTestSocket({ idPrefix: "mid-hello" });
    handleSocketConnection(second.socket as never);
    mockListNonTerminal.mockImplementation(() => {
      second.socket.connected = false;
      return Promise.resolve([]);
    });
    second.handlers.get("desktop.hello")?.({
      ...BASE_HELLO,
      computeTargetId: "target-existing",
    });

    await vi.waitFor(() => {
      expect(mockSetOnlineState).toHaveBeenCalledWith(
        "target-existing",
        "org-1",
        "user-1",
        false
      );
    });
    expect(second.socket.emit).not.toHaveBeenCalledWith(
      "desktop.hello.ack",
      expect.anything()
    );
    expect(mockUnsubscribeOperations).toHaveBeenCalled();
    expect(mockUnsubscribeTargetConnection).toHaveBeenCalled();
  });

  it("logs a rejected mid-hello offline compensation", async () => {
    const result = makeDesktopGatewayTestSocket({ idPrefix: "compensation" });
    handleSocketConnection(result.socket as never);
    mockListNonTerminal.mockImplementation(() => {
      result.socket.connected = false;
      return Promise.resolve([]);
    });
    mockSetOnlineState.mockImplementation(
      (_targetId, _organizationId, _userId, online: boolean) => {
        if (!online) {
          return Promise.reject(new Error("offline failed"));
        }
        return Promise.resolve(true);
      }
    );

    result.handlers.get("desktop.hello")?.({
      ...BASE_HELLO,
      computeTargetId: "target-existing",
    });

    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to compensate online state after disconnect during hello",
        expect.objectContaining({
          computeTargetId: "target-existing",
          error: expect.any(Error),
        })
      );
    });
  });

  it("warns but still acks when setting online reports no update", async () => {
    mockSetOnlineState.mockResolvedValue(false);

    const { socket } = beginHello({ computeTargetId: "target-existing" });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.objectContaining({ computeTargetId: "target-existing" })
      );
    });
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Desktop target online-state update missed during hello",
      expect.objectContaining({ computeTargetId: "target-existing" })
    );
  });

  it("disconnects malformed hello without emitting a nack", () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket({
      idPrefix: "malformed-hello",
    });
    handleSocketConnection(socket as never);

    handlers.get("desktop.hello")?.({});

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("drops a duplicate hello while the first handshake is in flight", async () => {
    let resolvePending: (value: unknown[]) => void = () => {};
    mockListNonTerminal.mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      })
    );
    const { handlers, socket } = beginHello();

    handlers.get("desktop.hello")?.(BASE_HELLO);

    await vi.waitFor(() => {
      expect(mockRegister).toHaveBeenCalledOnce();
    });
    resolvePending([]);
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.anything()
      );
    });
    expect(mockRegister).toHaveBeenCalledOnce();
  });

  it("contains a rejected hello and clears the latch for a later retry", async () => {
    mockClearOperationBacklog.mockImplementationOnce(() => {
      throw new Error("backlog failed");
    });
    const { handlers, socket } = beginHello();

    await vi.waitFor(() => {
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
    handlers.get("desktop.hello")?.(BASE_HELLO);

    await vi.waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(2);
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.anything()
      );
    });
  });

  it("marks the target offline only after its last direct socket disconnects", async () => {
    const { handlers, socket } = beginHello();
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.anything()
      );
    });
    mockSetOnlineState.mockClear();

    handlers.get("disconnect")?.();

    await vi.waitFor(() => {
      expect(mockSetOnlineState).toHaveBeenCalledWith(
        "target-1",
        "org-1",
        "user-1",
        false
      );
    });
  });

  it("logs a rejected last-socket offline update", async () => {
    const { handlers, socket } = beginHello();
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.anything()
      );
    });
    mockSetOnlineState.mockRejectedValue(new Error("offline failed"));

    handlers.get("disconnect")?.();

    await vi.waitFor(() => {
      expect(mockLogError).toHaveBeenCalledWith(
        "Failed handling desktop socket disconnect",
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });
});
