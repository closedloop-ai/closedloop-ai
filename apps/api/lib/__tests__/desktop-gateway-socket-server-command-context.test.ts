import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDesktopGatewayTestSockets,
  makeDesktopGatewayTestSocket,
} from "@/__tests__/support/lib/desktop-gateway-socket.test-harness";

const {
  mockGetCommandById,
  mockHeartbeat,
  mockIngestCommandEvent,
  mockIsDirectDesktopAuthSigningEligible,
  mockListNonTerminal,
  mockRegister,
  mockSubscribeOperations,
  mockSubscribeTargetConnection,
  mockClearOperationBacklog,
} = vi.hoisted(() => ({
  mockGetCommandById: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockIngestCommandEvent: vi.fn(),
  mockIsDirectDesktopAuthSigningEligible: vi.fn(),
  mockListNonTerminal: vi.fn(),
  mockRegister: vi.fn(),
  mockSubscribeOperations: vi.fn(),
  mockSubscribeTargetConnection: vi.fn(),
  mockClearOperationBacklog: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
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
    setOnlineState: vi.fn(),
    updateOwned: vi.fn(),
  },
  isComputeTargetGatewayConflictResult: (result: { ok: boolean }) =>
    result.ok === false,
}));

vi.mock("../relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: mockClearOperationBacklog,
    subscribeOperations: mockSubscribeOperations,
    subscribeTargetConnection: mockSubscribeTargetConnection,
  },
}));

// Only the function is faked: the real `CommandSigningEligibilityStatus` is
// spread through so the mocked module cannot drift from the shape production
// actually produces.
vi.mock("../compute-target-signing-eligibility", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../compute-target-signing-eligibility")
  >()),
  isDirectDesktopAuthSigningEligible: mockIsDirectDesktopAuthSigningEligible,
}));

vi.mock("../desktop-command-ack-handler", () => ({
  acknowledgeDesktopCommand: vi.fn().mockResolvedValue(undefined),
}));

import { CommandSigningEligibilityStatus } from "../compute-target-signing-eligibility";
import { handleSocketConnection } from "../desktop-gateway-socket-server";

describe("handleSocketConnection command telemetry context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegister.mockResolvedValue({
      ok: true,
      value: { id: "target-direct-1" },
    });
    mockListNonTerminal.mockResolvedValue([]);
    mockSubscribeOperations.mockReturnValue(() => {});
    mockSubscribeTargetConnection.mockReturnValue(() => {});
    mockClearOperationBacklog.mockReturnValue(undefined);
    mockHeartbeat.mockResolvedValue(undefined);
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    });
    mockIngestCommandEvent.mockResolvedValue({
      accepted: true,
      duplicate: false,
      sequence: 1,
    });
    mockGetCommandById.mockResolvedValue(null);
  });

  afterEach(async () => {
    await cleanupDesktopGatewayTestSockets();
    vi.restoreAllMocks();
  });

  it("passes direct socket session context to command event ingestion", async () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket();
    handleSocketConnection(socket as never);

    await handlers.get("desktop.hello")?.({
      gatewayId: "gateway-1",
      machineName: "test-machine",
      maxInFlightCommands: 2,
      platform: "darwin",
      pluginVersion: "1.2.3",
      supportedOperations: [],
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.objectContaining({
          computeTargetId: "target-direct-1",
          sessionId: expect.any(String),
        })
      );
    });

    const helloAck = socket.emit.mock.calls.find(
      ([event]) => event === "desktop.hello.ack"
    )?.[1] as { sessionId: string };

    handlers.get("desktop.command.event")?.({
      commandId: "cmd-direct-1",
      data: { terminal: true },
      eventType: "done",
      sequence: 1,
    });

    await vi.waitFor(() => {
      expect(mockIngestCommandEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: "cmd-direct-1",
          computeTargetId: "target-direct-1",
          context: expect.objectContaining({
            commandId: "cmd-direct-1",
            computeTargetId: "target-direct-1",
            gatewaySessionId: helloAck.sessionId,
            schemaVersion: "1",
          }),
        })
      );
    });

    handlers.get("disconnect")?.();
  });

  it("preserves server capabilities on direct sequence-gap hello acks", async () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket();
    mockIsDirectDesktopAuthSigningEligible.mockResolvedValue({
      status: CommandSigningEligibilityStatus.Eligible,
    });
    handleSocketConnection(socket as never);

    await handlers.get("desktop.hello")?.({
      gatewayId: "gateway-1",
      machineName: "test-machine",
      maxInFlightCommands: 2,
      platform: "darwin",
      pluginVersion: "1.2.3",
      supportedOperations: [],
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.objectContaining({
          computeTargetId: "target-direct-1",
          serverCapabilities: expect.objectContaining({
            agentSessionSync: true,
            computeTargetSigning: true,
          }),
        })
      );
    });

    mockIngestCommandEvent.mockResolvedValueOnce({
      accepted: false,
      reason: "sequence_gap",
    });
    mockGetCommandById.mockResolvedValueOnce({
      commandId: "cmd-direct-gap",
      computeTargetId: "target-direct-1",
      lastSequenceAcked: 7,
    });

    await handlers.get("desktop.command.event")?.({
      commandId: "cmd-direct-gap",
      data: { terminal: false },
      eventType: "chunk",
      sequence: 9,
    });

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith(
        "desktop.hello.ack",
        expect.objectContaining({
          computeTargetId: "target-direct-1",
          resumeFromSequence: { "cmd-direct-gap": 7 },
          serverCapabilities: expect.objectContaining({
            agentSessionSync: true,
            computeTargetSigning: true,
          }),
        })
      );
    });

    handlers.get("disconnect")?.();
  });

  /**
   * The production wiring, not the helper in isolation: reverting the subscriber
   * at `desktop-gateway-socket-server.ts` to its old inline arrow with a bare
   * `return` makes this handler answer `undefined` instead of `false`, which is
   * exactly the ISS-7558 bug -- `publishOperation` would then count it as a
   * delivery. This suite does not mock `../desktop-gateway-wire`, so the real
   * `handleRelayOperationForSocket` runs here.
   */
  it("subscribes a handler that reports rejection for a malformed relay path", async () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket();
    handleSocketConnection(socket as never);

    await handlers.get("desktop.hello")?.({
      gatewayId: "gateway-1",
      machineName: "test-machine",
      maxInFlightCommands: 2,
      platform: "darwin",
      pluginVersion: "1.2.3",
      supportedOperations: [],
    });

    await vi.waitFor(() => {
      expect(mockSubscribeOperations).toHaveBeenCalled();
    });

    const subscriber = mockSubscribeOperations.mock.calls[0][1] as (
      operation: unknown
    ) => boolean | undefined;
    socket.emit.mockClear();

    const accepted = subscriber({
      operationId: "op-malformed",
      operation: "engineer_http_request",
      params: {
        commandId: "cmd-malformed",
        request: { method: "POST", path: "//[" },
      },
      streaming: false,
    });

    expect(accepted).toBe(false);
    expect(socket.emit).not.toHaveBeenCalledWith(
      "desktop.command",
      expect.anything()
    );

    handlers.get("disconnect")?.();
  });

  it("subscribes a handler that emits and reports acceptance for a gateway path", async () => {
    const { handlers, socket } = makeDesktopGatewayTestSocket();
    handleSocketConnection(socket as never);

    await handlers.get("desktop.hello")?.({
      gatewayId: "gateway-1",
      machineName: "test-machine",
      maxInFlightCommands: 2,
      platform: "darwin",
      pluginVersion: "1.2.3",
      supportedOperations: [],
    });

    await vi.waitFor(() => {
      expect(mockSubscribeOperations).toHaveBeenCalled();
    });

    const subscriber = mockSubscribeOperations.mock.calls[0][1] as (
      operation: unknown
    ) => boolean | undefined;
    socket.emit.mockClear();

    const accepted = subscriber({
      operationId: "op-ok",
      operation: "engineer_http_request",
      params: {
        commandId: "cmd-ok",
        request: { method: "POST", path: "/api/gateway/symphony/launch" },
      },
      streaming: false,
    });

    expect(accepted).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith(
      "desktop.command",
      expect.objectContaining({ commandId: "cmd-ok" })
    );

    handlers.get("disconnect")?.();
  });

  /**
   * ISS-9152: the direct-connect server answers `desktop.hello` itself and never
   * passes through the relay that stamps relayed acks, so each of its two ack
   * emissions must state the minting origin on its own. A path and a trailing
   * slash are configured so the assertion also pins the reduction to a bare
   * origin, which is what the relay states and what the desktop compares.
   *
   * The env is set AFTER the module was imported, so these also pin that the
   * value is read per emission: a snapshot taken at import would have seen no
   * configured url at all, and `start-api-server.ts` imports this module before
   * `next()` loads `.env*`.
   */
  describe("ISS-9152: minting origin on the direct transport", () => {
    const CONFIGURED_API_URL = "https://api.origin-a.test/some/base/";
    const CONFIGURED_ORIGIN = "https://api.origin-a.test";
    // `getDynamicUrl` prefers a Vercel-derived preview url over the configured
    // one, so a lane that exports these must not satisfy the assertion instead.
    const ENV_KEYS = [
      "NEXT_PUBLIC_API_URL",
      "VERCEL_ENV",
      "VERCEL_BRANCH_URL",
      "VERCEL_URL",
    ] as const;
    const savedEnv = new Map<string, string | undefined>();

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        savedEnv.set(
          key,
          Object.hasOwn(process.env, key) ? process.env[key] : undefined
        );
        Reflect.deleteProperty(process.env, key);
      }
      process.env.NEXT_PUBLIC_API_URL = CONFIGURED_API_URL;
    });

    afterEach(() => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
      savedEnv.clear();
    });

    it("stamps the configured origin on the hello ack", async () => {
      const { handlers, socket } = makeDesktopGatewayTestSocket();
      handleSocketConnection(socket as never);

      await handlers.get("desktop.hello")?.({
        gatewayId: "gateway-1",
        machineName: "test-machine",
        maxInFlightCommands: 2,
        platform: "darwin",
        pluginVersion: "1.2.3",
        supportedOperations: [],
      });
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith(
          "desktop.hello.ack",
          expect.anything()
        );
      });

      const helloAck = socket.emit.mock.calls.find(
        ([event]) => event === "desktop.hello.ack"
      )?.[1] as Record<string, unknown>;
      expect(helloAck.computeTargetId).toBe("target-direct-1");
      expect(helloAck.mintingApiOrigin).toBe(CONFIGURED_ORIGIN);

      handlers.get("disconnect")?.();
    });

    it("stamps the configured origin on the sequence-gap re-ack", async () => {
      const { handlers, socket } = makeDesktopGatewayTestSocket();
      handleSocketConnection(socket as never);

      await handlers.get("desktop.hello")?.({
        gatewayId: "gateway-1",
        machineName: "test-machine",
        maxInFlightCommands: 2,
        platform: "darwin",
        pluginVersion: "1.2.3",
        supportedOperations: [],
      });
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith(
          "desktop.hello.ack",
          expect.anything()
        );
      });

      mockIngestCommandEvent.mockResolvedValueOnce({
        accepted: false,
        reason: "sequence_gap",
      });
      mockGetCommandById.mockResolvedValueOnce({
        commandId: "cmd-direct-gap",
        computeTargetId: "target-direct-1",
        lastSequenceAcked: 7,
      });
      await handlers.get("desktop.command.event")?.({
        commandId: "cmd-direct-gap",
        data: { terminal: false },
        eventType: "chunk",
        sequence: 9,
      });
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith(
          "desktop.hello.ack",
          expect.objectContaining({ resumeFromSequence: expect.anything() })
        );
      });

      // Only the re-ack carries `resumeFromSequence` here (no pending commands
      // at hello), so this is the second emission site and not the first again.
      const reAck = socket.emit.mock.calls.find(
        ([event, payload]) =>
          event === "desktop.hello.ack" &&
          (payload as Record<string, unknown>).resumeFromSequence !== undefined
      )?.[1] as Record<string, unknown>;
      expect(reAck.resumeFromSequence).toEqual({ "cmd-direct-gap": 7 });
      expect(reAck.mintingApiOrigin).toBe(CONFIGURED_ORIGIN);

      handlers.get("disconnect")?.();
    });

    /**
     * The deployment this whole field exists for is a direct API that is NOT
     * the relay's, and `keys()` cannot tell that apart from a laptop: it
     * resolves an unset `NEXT_PUBLIC_API_URL` to the `http://localhost:3002`
     * default (`getDynamicUrl`), which the ack would then state as an
     * established origin. The desktop compares that against the origin it posts
     * to and refuses its own target, so a server with no configured origin must
     * make no statement rather than a wrong one (whitlockk, #7085). A blank value
     * is the same case — `emptyStringAsUndefined` is set on every schema in
     * this repo, so `NEXT_PUBLIC_API_URL=""` IS unset.
     */
    it.each([
      {
        configure: () =>
          Reflect.deleteProperty(process.env, "NEXT_PUBLIC_API_URL"),
        spelling: "unset",
      },
      {
        configure: () => {
          process.env.NEXT_PUBLIC_API_URL = "";
        },
        spelling: "blank",
      },
    ])(
      "states no origin when NEXT_PUBLIC_API_URL is $spelling",
      async ({ configure }) => {
        configure();
        const { handlers, socket } = makeDesktopGatewayTestSocket();
        handleSocketConnection(socket as never);

        await handlers.get("desktop.hello")?.({
          gatewayId: "gateway-1",
          machineName: "test-machine",
          maxInFlightCommands: 2,
          platform: "darwin",
          pluginVersion: "1.2.3",
          supportedOperations: [],
        });
        await vi.waitFor(() => {
          expect(socket.emit).toHaveBeenCalledWith(
            "desktop.hello.ack",
            expect.anything()
          );
        });

        const helloAck = socket.emit.mock.calls.find(
          ([event]) => event === "desktop.hello.ack"
        )?.[1] as Record<string, unknown>;
        // The ack still lands and still names the target — an unstated origin
        // is this field's defined absent case, not a failure.
        expect(helloAck.computeTargetId).toBe("target-direct-1");
        // The KEY's absence, which is what the desktop reads and what an older
        // API sends. `expect(...mintingApiOrigin).toBeUndefined()` would also
        // pass on a key the sender chose to carry, and a `null` there is
        // "elsewhere" to every origin the desktop could compare against.
        expect(Object.hasOwn(helloAck, "mintingApiOrigin")).toBe(false);

        handlers.get("disconnect")?.();
      }
    );
  });
});
