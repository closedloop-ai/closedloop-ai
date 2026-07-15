import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, mock, test } from "node:test";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  buildRelayValidationPopHeaders,
  type CloudSocketOptions,
  CloudSocketService,
  parseDesktopAgentSessionsAck,
  parseDesktopHelloAck,
  parseServerCapabilities,
  refreshRelayValidationPopHeadersForSocket,
} from "../src/main/cloud-socket.js";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  DesktopPopUnavailableError,
  RELAY_API_KEY_VERIFY_PATH,
} from "../src/main/desktop-pop.js";
import { gatewayLog } from "../src/main/gateway-logger.js";
import { buildCommandSigningCapabilities } from "../src/shared/command-signing-policy.js";
import { GATEWAY_PROTOCOL_VERSION } from "../src/shared/contracts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELLO_ACK_TIMEOUT_RESET_PATTERN =
  /socket\.on\("desktop\.hello\.ack",[\s\S]*?this\.helloAckTimeoutCount = 0;/;

function createStubOptions(
  overrides?: Partial<CloudSocketOptions>
): CloudSocketOptions {
  return {
    getRelayOrigin: () => "https://relay.example.com",
    getApiKey: () => "test-key",
    getAllowedDirectories: () => ["/tmp"],
    getMaxInFlightCommands: () => 5,
    getEnabledOperations: () => ["test_op"],
    machineName: "test-machine",
    pluginVersion: "1.0.0-test",
    desktopClientVersion: "0.13.9-test",
    gatewayProtocolVersion: "0.1.0",
    ...overrides,
  };
}

afterEach(() => {
  mock.timers.reset();
  gatewayLog.clear();
  gatewayLog.setVerbose(false);
});

// ---------------------------------------------------------------------------
// T-6.1: Presence state log deduplication
// ---------------------------------------------------------------------------

describe("T-6.1: Presence state log deduplication", () => {
  test("(a) sendPresence logs only on state transitions", () => {
    gatewayLog.setVerbose(true);
    gatewayLog.clear(); // clear the "Verbose logging enabled" entry

    const service = new CloudSocketService(createStubOptions());

    // First call with "online" — should log
    service.sendPresence({ state: "online", activeCommands: 0, queueDepth: 0 });
    const afterFirst = gatewayLog
      .getEntries()
      .filter(
        (e) =>
          e.tag === "cloud-socket" && e.message.includes("Sending presence:")
      );
    assert.equal(afterFirst.length, 1, "First presence call should log");

    // Repeated "online" — should NOT produce a new log entry
    service.sendPresence({ state: "online", activeCommands: 1, queueDepth: 0 });
    const afterRepeat = gatewayLog
      .getEntries()
      .filter(
        (e) =>
          e.tag === "cloud-socket" && e.message.includes("Sending presence:")
      );
    assert.equal(
      afterRepeat.length,
      1,
      "Repeated same state should not log again"
    );

    // Transition to degraded — should log
    service.sendPresence({ state: "degraded", error: "test error" });
    const afterDegraded = gatewayLog
      .getEntries()
      .filter(
        (e) =>
          e.tag === "cloud-socket" && e.message.includes("Sending presence:")
      );
    assert.equal(
      afterDegraded.length,
      2,
      "State transition should produce new log"
    );

    // Repeated degraded — should NOT log
    service.sendPresence({ state: "degraded", error: "different error" });
    const afterRepeatDegraded = gatewayLog
      .getEntries()
      .filter(
        (e) =>
          e.tag === "cloud-socket" && e.message.includes("Sending presence:")
      );
    assert.equal(
      afterRepeatDegraded.length,
      2,
      "Repeated degraded should not log"
    );

    // Back to online — should log
    service.sendPresence({ state: "online", activeCommands: 0, queueDepth: 0 });
    const afterBackOnline = gatewayLog
      .getEntries()
      .filter(
        (e) =>
          e.tag === "cloud-socket" && e.message.includes("Sending presence:")
      );
    assert.equal(
      afterBackOnline.length,
      3,
      "Transition back to online should log"
    );
  });
});

describe("relay validation PoP headers", () => {
  test("managed keys sign the relay API-key verification path", async () => {
    let capturedRequest: unknown;
    const headers = await buildRelayValidationPopHeaders(
      "DESKTOP_MANAGED",
      (request) => {
        capturedRequest = request;
        return {
          [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
          [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984000",
          [DESKTOP_POP_SIGNATURE_HEADER]: "signature",
        };
      }
    );

    assert.deepEqual(capturedRequest, {
      method: "POST",
      pathname: RELAY_API_KEY_VERIFY_PATH,
    });
    assert.deepEqual(headers, {
      [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
      [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984000",
      [DESKTOP_POP_SIGNATURE_HEADER]: "signature",
    });
  });

  test("manual keys omit relay PoP headers and do not call signer", async () => {
    let signerCalled = false;
    const headers = await buildRelayValidationPopHeaders("USER_CREATED", () => {
      signerCalled = true;
      return null;
    });

    assert.equal(headers, undefined);
    assert.equal(signerCalled, false);
  });

  test("managed signing unavailable falls back to bearer-only compatibility", async () => {
    const unavailableReports: Array<{ surface: string; reason: string }> = [];
    const headers = await buildRelayValidationPopHeaders(
      "DESKTOP_MANAGED",
      () => null,
      (surface, reason) => unavailableReports.push({ surface, reason })
    );

    assert.equal(headers, undefined);
    assert.deepEqual(unavailableReports, [
      {
        surface: RELAY_API_KEY_VERIFY_PATH,
        reason: "sign_failed_or_null",
      },
    ]);
    assert.equal(
      gatewayLog
        .getEntries()
        .some(
          (entry) =>
            entry.tag === "desktop-pop" &&
            entry.message.includes("continuing bearer-only compatibility mode")
        ),
      true
    );
  });

  test("managed signing reports precise redacted unavailable reasons", async () => {
    const unavailableReports: Array<{ surface: string; reason: string }> = [];

    const headers = await buildRelayValidationPopHeaders(
      "DESKTOP_MANAGED",
      () => {
        throw new DesktopPopUnavailableError("safe_storage_unavailable");
      },
      (surface, reason) => unavailableReports.push({ surface, reason })
    );

    assert.equal(headers, undefined);
    assert.deepEqual(unavailableReports, [
      {
        surface: RELAY_API_KEY_VERIFY_PATH,
        reason: "safe_storage_unavailable",
      },
    ]);
  });

  test("manual reconnect refreshes stale relay PoP extraHeaders", async () => {
    const socket = {
      io: {
        opts: {
          extraHeaders: {
            [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
            [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984000",
            [DESKTOP_POP_SIGNATURE_HEADER]: "old-signature",
          },
        },
      },
    };

    await refreshRelayValidationPopHeadersForSocket(
      socket as unknown as Parameters<
        typeof refreshRelayValidationPopHeadersForSocket
      >[0],
      "DESKTOP_MANAGED",
      () => ({
        [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
        [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984060",
        [DESKTOP_POP_SIGNATURE_HEADER]: "new-signature",
      })
    );

    assert.deepEqual(socket.io.opts.extraHeaders, {
      [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
      [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984060",
      [DESKTOP_POP_SIGNATURE_HEADER]: "new-signature",
    });
  });
});

// ---------------------------------------------------------------------------
// T-3.1: GATEWAY_PROTOCOL_VERSION constant value
// ---------------------------------------------------------------------------

describe("T-3.1: GATEWAY_PROTOCOL_VERSION constant", () => {
  test("GATEWAY_PROTOCOL_VERSION is '0.1.0'", () => {
    assert.equal(GATEWAY_PROTOCOL_VERSION, "0.1.0");
  });
});

// ---------------------------------------------------------------------------
// T-3.1: desktop.hello payload version fields
// ---------------------------------------------------------------------------

/**
 * Minimal fake socket that records events emitted via socket.emit().
 * We inject this into the CloudSocketService's private `socket` field
 * so we can capture the desktop.hello payload without a real Socket.IO
 * server connection.
 */
class FakeSocket extends EventEmitter {
  connected = true;
  readonly emittedEvents: Array<{ name: string; payload: unknown }> = [];

  emit(name: string, ...args: unknown[]): boolean {
    this.emittedEvents.push({ name, payload: args[0] });
    return super.emit(name, ...args);
  }

  disconnect(): this {
    this.connected = false;
    return this;
  }

  removeAllListeners(event?: string): this {
    super.removeAllListeners(event);
    return this;
  }
}

describe("T-3.1: hello payload version fields", () => {
  test("CloudSocketService emits version fields and local capabilities in desktop.hello", () => {
    const service = new CloudSocketService(
      createStubOptions({
        desktopClientVersion: "0.13.9-test",
        gatewayProtocolVersion: "0.1.0",
        pluginVersion: "1.0.0-test",
        getCapabilities: () => ({ commandSigning: true }),
      })
    );

    // Inject a fake socket so we can capture what emitHello emits without
    // establishing a real Socket.IO connection.
    const fakeSocket = new FakeSocket();
    (service as unknown as Record<string, unknown>).socket = fakeSocket;

    // Call the private emitHello method directly via prototype access.
    // This exercises the same code path triggered on connect, building the
    // DesktopHelloEvent from options and emitting it on the socket.
    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.emitHello.call(service);

    // Verify the desktop.hello event was emitted with all three version fields
    const helloEvents = fakeSocket.emittedEvents.filter(
      (e) => e.name === "desktop.hello"
    );
    assert.equal(
      helloEvents.length,
      1,
      "Expected exactly one desktop.hello emission"
    );

    const hello = helloEvents[0].payload as Record<string, unknown>;
    assert.equal(
      hello.desktopClientVersion,
      "0.13.9-test",
      "desktopClientVersion must match"
    );
    assert.equal(
      hello.gatewayProtocolVersion,
      "0.1.0",
      "gatewayProtocolVersion must match"
    );
    assert.equal(hello.pluginVersion, "1.0.0-test", "pluginVersion must match");
    assert.deepEqual(hello.capabilities, { commandSigning: true });

    service.stop();
  });

  test("CloudSocketService omits commandSigningRequired until enforcement opt-in is enabled", () => {
    const service = new CloudSocketService(
      createStubOptions({
        getCapabilities: () =>
          buildCommandSigningCapabilities({
            commandSigningEnforcementEnabled: false,
          }),
      })
    );
    const fakeSocket = new FakeSocket();
    (service as unknown as Record<string, unknown>).socket = fakeSocket;

    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.emitHello.call(service);

    const hello = fakeSocket.emittedEvents.find(
      (e) => e.name === "desktop.hello"
    )?.payload as Record<string, unknown>;
    assert.deepEqual(hello.capabilities, {
      tools: {
        claude: false,
        codex: false,
        git: false,
        gh: false,
        python3: false,
      },
      versions: {},
      commandSigning: true,
    });

    service.stop();
  });

  test("CloudSocketService includes commandSigningRequired when enforcement opt-in is enabled", () => {
    const service = new CloudSocketService(
      createStubOptions({
        getCapabilities: () =>
          buildCommandSigningCapabilities({
            commandSigningEnforcementEnabled: true,
          }),
      })
    );
    const fakeSocket = new FakeSocket();
    (service as unknown as Record<string, unknown>).socket = fakeSocket;

    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.emitHello.call(service);

    const hello = fakeSocket.emittedEvents.find(
      (e) => e.name === "desktop.hello"
    )?.payload as Record<string, unknown>;
    assert.equal(
      (hello.capabilities as Record<string, unknown>).commandSigningRequired,
      true
    );

    service.stop();
  });

  test("parseServerCapabilities requires explicit true flags", () => {
    assert.deepEqual(
      parseServerCapabilities({
        computeTargetSigning: true,
        agentSessionSync: true,
      }),
      {
        computeTargetSigning: true,
        agentSessionSync: true,
      }
    );
    assert.equal(
      parseServerCapabilities({ computeTargetSigning: false }),
      undefined
    );
    assert.deepEqual(parseServerCapabilities({ agentSessionSync: true }), {
      agentSessionSync: true,
    });
    assert.equal(
      parseServerCapabilities({ computeTargetSigning: "true" }),
      undefined
    );
    assert.equal(parseServerCapabilities(undefined), undefined);
  });

  test("parseDesktopHelloAck ignores identity fields owned by server analytics", () => {
    const ack = parseDesktopHelloAck({
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: "2026-05-11T00:00:00.000Z",
      clerkUserId: " clerk_user_1 ",
      organizationId: " org-1 ",
      userId: "user_db_1",
      serverCapabilities: {
        computeTargetSigning: true,
        agentSessionSync: true,
      },
      resumeFromSequence: { "cmd-1": 2 },
    });

    assert.ok(ack);
    assert.equal(ack.computeTargetId, "target-1");
    assert.equal(
      (ack as unknown as Record<string, unknown>).clerkUserId,
      undefined
    );
    assert.equal(
      (ack as unknown as Record<string, unknown>).organizationId,
      undefined
    );
    assert.equal((ack as unknown as Record<string, unknown>).userId, undefined);
    assert.deepEqual(ack.serverCapabilities, {
      computeTargetSigning: true,
      agentSessionSync: true,
    });
    assert.deepEqual(ack.resumeFromSequence, { "cmd-1": 2 });
  });

  test("parseDesktopHelloAck accepts older ack payloads without identity", () => {
    const ack = parseDesktopHelloAck({
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: "2026-05-11T00:00:00.000Z",
    });

    assert.ok(ack);
    assert.equal(ack.computeTargetId, "target-1");
    assert.equal(
      (ack as unknown as Record<string, unknown>).clerkUserId,
      undefined
    );
    assert.equal(
      (ack as unknown as Record<string, unknown>).organizationId,
      undefined
    );
  });

  test("parseDesktopAgentSessionsAck keeps malformed payloads retryable", () => {
    assert.deepEqual(parseDesktopAgentSessionsAck({ accepted: true }), {
      accepted: true,
    });
    assert.deepEqual(
      parseDesktopAgentSessionsAck({ reason: "feature_disabled" }),
      {
        accepted: false,
        reason: "feature_disabled",
      }
    );
    assert.deepEqual(parseDesktopAgentSessionsAck({ reason: "bogus" }), {
      accepted: false,
      reason: "rate_limited",
    });
  });

  test("sendAgentSessions keeps batches retryable until the relay is ready", async () => {
    const service = new CloudSocketService(createStubOptions());

    const ack = await service.sendAgentSessions({
      schemaVersion: 1,
      batchId: "batch-1",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 0,
      sessions: [],
    });

    assert.deepEqual(ack, {
      accepted: false,
      reason: "rate_limited",
    });
  });
});

// ---------------------------------------------------------------------------
// FEA-1404: hello-ack timeout recovery + diagnostics
// ---------------------------------------------------------------------------

describe("FEA-1404: hello-ack timeout recovery", () => {
  test("first hello-ack timeout re-emits hello on same socket; second timeout forces reconnect", () => {
    mock.timers.enable({ apis: ["setTimeout"] });

    const service = new CloudSocketService(
      createStubOptions({
        desktopClientVersion: "0.15.86-test",
        gatewayProtocolVersion: "0.1.0",
      })
    );
    const fakeSocket = new FakeSocket();
    (fakeSocket as unknown as { id: string }).id = "sock-FEA1404";
    (service as unknown as Record<string, unknown>).socket = fakeSocket;
    (service as unknown as Record<string, unknown>).stopped = false;
    (service as unknown as Record<string, unknown>).awaitingHelloAck = true;

    // Prime the timer + counter as the connect handler would.
    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.emitHello.call(service);
    proto.scheduleHelloAckTimeout.call(service);

    assert.equal(fakeSocket.emittedEvents.length, 1, "initial hello emitted");

    // Tick to first timeout (10s).
    mock.timers.tick(10_000);

    // After the first timeout, hello must have been re-emitted on the same
    // socket (cumulative 2 emits) — the socket must still be connected.
    assert.equal(
      fakeSocket.emittedEvents.length,
      2,
      "first timeout re-emits hello on the same socket"
    );
    assert.equal(
      fakeSocket.connected,
      true,
      "socket must remain connected after the first timeout"
    );
    assert.equal(
      (service as unknown as { helloAckTimeoutCount: number })
        .helloAckTimeoutCount,
      1,
      "counter advances to 1 after first timeout"
    );

    // Tick to second timeout (another 10s). This is the MAX; the supervisor
    // must NOT re-emit hello on the same socket — instead it disconnects so
    // the existing 'disconnect' listener can schedule a fresh handshake.
    mock.timers.tick(10_000);

    assert.equal(
      fakeSocket.emittedEvents.length,
      2,
      "second timeout must NOT re-emit hello — it must recycle the socket"
    );
    assert.equal(
      fakeSocket.connected,
      false,
      "second timeout must call socket.disconnect() to force a clean reconnect"
    );
    assert.equal(
      (service as unknown as { helloAckTimeoutCount: number })
        .helloAckTimeoutCount,
      2,
      "counter advances to 2 (MAX_HELLO_ACK_TIMEOUTS_PER_SOCKET)"
    );
    // End-to-end recovery chain assertion: socket.disconnect() alone is not
    // enough. We need scheduleSocketReconnect to have been called so that a
    // fresh handshake actually happens in ~20s, not after the 60s recovery
    // timer. FakeSocket.disconnect() does not emit a 'disconnect' event, so
    // this check would fail if the supervisor relied solely on the listener
    // chain to schedule the reconnect.
    assert.notEqual(
      (service as unknown as { reconnectTimer: NodeJS.Timeout | null })
        .reconnectTimer,
      null,
      "second timeout must schedule a reconnect timer (not rely solely on the disconnect listener firing)"
    );

    service.stop();
  });

  test("hello-ack timeout log includes socketId, computeTargetId, gatewayId, and versions", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    gatewayLog.setVerbose(false);
    gatewayLog.clear();

    const service = new CloudSocketService(
      createStubOptions({
        getGatewayId: () => "gw-test-123",
        desktopClientVersion: "0.15.86-test",
        gatewayProtocolVersion: "0.2.0-test",
      })
    );
    const fakeSocket = new FakeSocket();
    (fakeSocket as unknown as { id: string }).id = "sock-diag";
    (service as unknown as Record<string, unknown>).socket = fakeSocket;
    (service as unknown as Record<string, unknown>).stopped = false;
    (service as unknown as Record<string, unknown>).awaitingHelloAck = true;

    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.scheduleHelloAckTimeout.call(service);
    mock.timers.tick(10_000);

    const entries = gatewayLog.getEntries();
    const timeoutEntry = entries.find(
      (e) => e.tag === "cloud-socket" && /Hello ack timeout/.test(e.message)
    );
    assert.ok(timeoutEntry, "hello ack timeout entry must be logged");
    assert.match(timeoutEntry.message, /socketId=sock-diag/);
    assert.match(
      timeoutEntry.message,
      /computeTargetId=\(none — first connect\)/
    );
    assert.match(timeoutEntry.message, /gatewayId=gw-test-123/);
    assert.match(timeoutEntry.message, /desktopClientVersion=0\.15\.86-test/);
    assert.match(timeoutEntry.message, /gatewayProtocolVersion=0\.2\.0-test/);
    // The "(1/2)" counter helps correlate cycles in the log.
    assert.match(timeoutEntry.message, /\(1\/2\)/);

    service.stop();
  });

  test("counter resets on stop() and start() so a fresh connect always begins at 0", async () => {
    // Pre-poison the counter to simulate a service that previously timed out.
    const service = new CloudSocketService(
      createStubOptions({
        getApiKey: () => null, // makes start() bail right after the reset
      })
    );
    (service as unknown as Record<string, unknown>).helloAckTimeoutCount = 7;

    service.stop();
    assert.equal(
      (service as unknown as { helloAckTimeoutCount: number })
        .helloAckTimeoutCount,
      0,
      "stop() must reset helloAckTimeoutCount to 0"
    );

    (service as unknown as Record<string, unknown>).helloAckTimeoutCount = 9;
    await service.start();
    assert.equal(
      (service as unknown as { helloAckTimeoutCount: number })
        .helloAckTimeoutCount,
      0,
      "start() must reset helloAckTimeoutCount to 0"
    );
  });

  test("source contains a reset of helloAckTimeoutCount on the desktop.hello.ack listener", () => {
    // Belt-and-suspenders: the desktop.hello.ack listener is attached only
    // inside connect() against a live Socket.IO instance, so it's not
    // ergonomic to drive from a unit test. Pin the reset via a source check
    // so a future refactor that removes it fails this test.
    const source = readFileSync(
      new URL("../src/main/cloud-socket.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      source,
      HELLO_ACK_TIMEOUT_RESET_PATTERN,
      "desktop.hello.ack listener must reset helloAckTimeoutCount to 0"
    );
  });

  test("source contains the defensive restart() fallback when socket is null at MAX timeouts", () => {
    // Belt-and-suspenders for the otherwise-unreachable else branch in
    // scheduleHelloAckTimeout: if a future refactor relaxes the short-circuit
    // guards at the top of the callback (`this.stopped || !this.awaitingHelloAck`)
    // such that the timeout body can reach the MAX path with `this.socket === null`,
    // the supervisor must still drive recovery via restart() rather than
    // silently no-op into the 60s RECOVERY_TIMEOUT_MS path. Pin the branch
    // via source inspection.
    const source = readFileSync(
      new URL("../src/main/cloud-socket.ts", import.meta.url),
      "utf8"
    );
    const forcingReconnectSection = source.match(
      /Forcing reconnect after[\s\S]{0,1500}?\}\s*return;/
    );
    assert.ok(
      forcingReconnectSection,
      "forcing-reconnect block must exist in cloud-socket.ts"
    );
    // The connected/half-open path uses socket.disconnect() + scheduleSocketReconnect.
    assert.match(
      forcingReconnectSection[0],
      /if \(socket\) \{[\s\S]{0,400}socket\.disconnect\(\);[\s\S]{0,200}this\.scheduleSocketReconnect\(socket\);[\s\S]{0,200}\} else \{[\s\S]{0,500}this\.restart\(\);/,
      "MAX-timeout block must include both the socket-present recovery and the defensive restart() fallback for the socket-null case"
    );
  });
});

describe("agent-session ack timing", () => {
  test("sendAgentSessions waits for the longer relay ack window before timing out", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });

    const service = new CloudSocketService(createStubOptions());
    const fakeSocket = new FakeSocket();
    (service as unknown as Record<string, unknown>).socket = fakeSocket;
    (service as unknown as Record<string, unknown>).stopped = false;
    (service as unknown as Record<string, unknown>).targetId = "target-1";

    const ackPromise = service.sendAgentSessions({
      schemaVersion: 1,
      batchId: "batch-1",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 0,
      sessions: [],
    });

    mock.timers.tick(29_999);
    await Promise.resolve();

    let settled = false;
    void ackPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(
      settled,
      false,
      "agent-session acks must remain pending before the full 30s window elapses"
    );

    mock.timers.tick(1);
    const ack = await ackPromise;
    assert.deepEqual(ack, {
      accepted: false,
      reason: "ack_timeout",
    });
  });
});

// ---------------------------------------------------------------------------
// T-6.2: Capability flags loopRunnerRefreshSupported and loopRunnerHeartbeatSupported
// ---------------------------------------------------------------------------

describe("T-6.2: capability flags loopRunnerRefreshSupported and loopRunnerHeartbeatSupported", () => {
  test("desktop.hello capabilities include loopRunnerRefreshSupported=true and loopRunnerHeartbeatSupported=true", () => {
    const service = new CloudSocketService(
      createStubOptions({
        getCapabilities: () => ({
          tools: {
            claude: false,
            codex: false,
            git: false,
            gh: false,
            python3: false,
          },
          versions: {},
          commandSigning: true,
          loopRunnerRefreshSupported: true,
          loopRunnerHeartbeatSupported: true,
        }),
      })
    );

    const fakeSocket = new FakeSocket();
    (service as unknown as Record<string, unknown>).socket = fakeSocket;

    const proto = Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => void
    >;
    proto.emitHello.call(service);

    const hello = fakeSocket.emittedEvents.find(
      (e) => e.name === "desktop.hello"
    )?.payload as Record<string, unknown>;
    assert.ok(hello, "Expected desktop.hello to be emitted");

    const caps = hello.capabilities as Record<string, unknown>;
    assert.equal(
      caps.loopRunnerRefreshSupported,
      true,
      "loopRunnerRefreshSupported must be true"
    );
    assert.equal(
      caps.loopRunnerHeartbeatSupported,
      true,
      "loopRunnerHeartbeatSupported must be true"
    );

    service.stop();
  });
});
