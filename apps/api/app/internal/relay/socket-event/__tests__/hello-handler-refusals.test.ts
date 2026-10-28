import {
  DesktopCommandStatus,
  DesktopHelloNackReason,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_OPERATIONS_MAX_COUNT } from "@/lib/compute-target-field-limits";

const mocks = vi.hoisted(() => ({
  clearOperationBacklog: vi.fn(),
  countCommandsForTarget: vi.fn(),
  isComputeTargetSigningEligible: vi.fn(),
  listNonTerminalDispatchCommands: vi.fn(),
  register: vi.fn(),
  requeueUndeliveredCommands: vi.fn(),
  scheduleGitHubDirtyScopeRecoveryDrain: vi.fn(),
  setOnlineState: vi.fn(),
  updateOwned: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: mocks.register,
    setOnlineState: mocks.setOnlineState,
    updateOwned: mocks.updateOwned,
  },
  isComputeTargetGatewayConflictResult: () => false,
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isComputeTargetSigningEligible: mocks.isComputeTargetSigningEligible,
}));

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  requeueUndeliveredCommands: mocks.requeueUndeliveredCommands,
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    countCommandsForTarget: mocks.countCommandsForTarget,
    listNonTerminalDispatchCommands: mocks.listNonTerminalDispatchCommands,
  },
}));

vi.mock("@/lib/desktop-gateway-wire", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-gateway-wire")>();
  return {
    ...original,
    toEnvelope: <T>(payload: T) => payload,
    toWireCommandFromStore: <T>(command: T) => command,
  };
});

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: { clearOperationBacklog: mocks.clearOperationBacklog },
}));

vi.mock("@/lib/route-utils", () => ({ scheduleLogFlush: vi.fn() }));

vi.mock("../service/github-dirty-scope-drain", () => ({
  scheduleGitHubDirtyScopeRecoveryDrain:
    mocks.scheduleGitHubDirtyScopeRecoveryDrain,
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn().mockReturnValue({}),
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitConnectionStateEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

import { log } from "@repo/observability/log";
import {
  COMPUTE_TARGET_REGISTER_ORG_MISMATCH_EVENT,
  resetOwnershipRefusalEmissionWindowsForTest,
} from "@/app/compute-targets/service/ownership-refusal-telemetry";
import { MACHINE_NAME_MAX_LENGTH } from "@/lib/compute-target-field-limits";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";
import { handleHello } from "../service/hello-handler";

const AUTH = {
  clerkUserId: "clerk-bug1",
  organizationId: "org-bug1",
  userId: "user-bug1",
};
const TARGET_ID = "target-bug1";

function pendingCommand(commandId: string, path: string, sequence: number) {
  return {
    commandId,
    computeTargetId: TARGET_ID,
    operationId: "health_check",
    status: DesktopCommandStatus.Queued,
    lastSequenceAcked: sequence,
    method: "POST" as const,
    path,
    createdAt: new Date(Date.UTC(2026, 7, 30, 12, sequence)).toISOString(),
  };
}

describe("relay hello pending-command path refusal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-bug1", id: TARGET_ID },
    });
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
    mocks.countCommandsForTarget.mockResolvedValue(0);
    mocks.requeueUndeliveredCommands.mockResolvedValue(0);
  });

  it("filters legacy rows before applying the reconnect ceiling", async () => {
    const legacy = pendingCommand("legacy-command", "/api/desktop/health", 3);
    const valid = pendingCommand("gateway-command", "/api/gateway/health", 7);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([legacy, valid]);

    const result = await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        maxInFlightCommands: 1,
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    const ack = result.emit.find(
      (entry) => entry.event === "desktop.hello.ack"
    );
    const commandFrames = result.emit.filter(
      (entry) => entry.event === "desktop.command"
    );

    expect(commandFrames).toEqual([
      { event: "desktop.command", payload: valid },
    ]);
    expect(ack?.payload).toMatchObject({
      computeTargetId: TARGET_ID,
      resumeFromSequence: { "gateway-command": 7 },
    });
    expect(ack?.payload).not.toHaveProperty(
      "resumeFromSequence.legacy-command"
    );
    // The legacy row is intentionally retained for a later explicit policy,
    // while the valid row was delivered. Neither belongs in the withheld set.
    expect(mocks.requeueUndeliveredCommands).not.toHaveBeenCalled();
  });

  // A skipped row is retained non-terminal and replayed by neither lane, so
  // this warn is the only operational record that it existed. The direct socket
  // has emitted it since before the partition reached the relay; a relay that
  // partitions silently is the same divergence in the other direction.
  it("warns for each skipped row and for no delivered one", async () => {
    const legacy = pendingCommand("legacy-command", "/api/desktop/health", 3);
    const corrupt = pendingCommand("corrupt-command", null as never, 4);
    const valid = pendingCommand("gateway-command", "/api/gateway/health", 7);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([
      legacy,
      corrupt,
      valid,
    ]);

    await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    const skipWarnings = vi
      .mocked(log.warn)
      .mock.calls.filter(
        ([message]) =>
          message ===
          "Pending command has non-gateway path — possible legacy command in store"
      );

    expect(skipWarnings.map(([, context]) => context)).toEqual([
      {
        commandId: "legacy-command",
        computeTargetId: TARGET_ID,
        path: "/api/desktop/health",
      },
      {
        commandId: "corrupt-command",
        computeTargetId: TARGET_ID,
        path: null,
      },
    ]);
    expect(
      skipWarnings.some(
        ([, context]) =>
          (context as { commandId: string }).commandId === "gateway-command"
      )
    ).toBe(false);
  });
});

// ISS-8547: a clamped ceiling must be reported, not silent. Without this signal
// a legitimately higher-throughput client is throttled with nothing on the wire
// or in the logs saying why — the logging behavior itself is the contract under
// test, which is the documented carve-out for asserting a log call.
describe("relay hello maxInFlightCommands clamp reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-bug1", id: TARGET_ID },
    });
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
    mocks.countCommandsForTarget.mockResolvedValue(0);
    mocks.requeueUndeliveredCommands.mockResolvedValue(0);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([]);
  });

  it("reports a clamp on log.warn when the declared ceiling exceeds MAX_IN_FLIGHT_COMMANDS_CEILING", async () => {
    await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        maxInFlightCommands: Number.MAX_SAFE_INTEGER,
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    expect(log.warn).toHaveBeenCalledWith(
      "desktop.hello.maxInFlightCommands.clamped",
      expect.objectContaining({
        applied: MAX_IN_FLIGHT_COMMANDS_CEILING,
        declared: Number.MAX_SAFE_INTEGER,
      })
    );
  });

  it("does not report a clamp on log.warn when the declared ceiling is within range", async () => {
    await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        maxInFlightCommands: 2,
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    expect(log.warn).not.toHaveBeenCalledWith(
      "desktop.hello.maxInFlightCommands.clamped",
      expect.anything()
    );
  });

  // ISS-8547 review: the clamp used to run only at the emit, AFTER the raw
  // declaration had already been written to `compute_targets.capabilities` and
  // handed to `emitFleetCapacityMetrics`. The drain was capped at 64 while the
  // row and the saturation ratio still reported 9007199254740991 — a stored
  // invalid value and a confidently wrong measurement. Asserting the PERSISTED
  // capability is what pins that: a clamp that only bounds the emit passes every
  // other case in this file.
  it("persists the APPLIED ceiling, not the raw declaration", async () => {
    await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        maxInFlightCommands: Number.MAX_SAFE_INTEGER,
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    const persisted = (mocks.register.mock.calls[0] ?? [])
      .map(
        (argument) =>
          (argument as { capabilities?: Record<string, unknown> } | undefined)
            ?.capabilities
      )
      .find((value) => value !== undefined);

    expect(persisted?.maxInFlightCommands).toBe(MAX_IN_FLIGHT_COMMANDS_CEILING);
  });

  it("persists an in-range declaration unchanged", async () => {
    // The mutation this kills is a clamp that also rewrites the valid path —
    // a target declaring 2 must still store 2, not the ceiling.
    await handleHello(
      {
        gatewayId: "gateway-bug1",
        machineName: "bug1-machine",
        maxInFlightCommands: 2,
        platform: "linux",
        supportedOperations: [],
      },
      AUTH
    );

    const persisted = (mocks.register.mock.calls[0] ?? [])
      .map(
        (argument) =>
          (argument as { capabilities?: Record<string, unknown> } | undefined)
            ?.capabilities
      )
      .find((value) => value !== undefined);

    expect(persisted?.maxInFlightCommands).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ISS-8880 §5 — machineName length refusal on the relay hello lane
// ---------------------------------------------------------------------------

/**
 * `compute_targets.machine_name` carries `@@unique([userId, machineName])`, a
 * btree unique index. The REST lane bounds it at 120; this lane bounded nothing
 * at all, so an over-length name reached Prisma and raised SQLSTATE 54000
 * ("index row size N exceeds btree version 4 maximum 2704"). `runStage` caught
 * that and nacked, so the desktop got a nack plus a disconnect and could never
 * register — deterministic, so every reconnect failed the same way.
 *
 * The fix refuses it BEFORE any DB call. The desktop-observed outcome must be
 * the SAME nack reason it already gets today, which is why the reason is
 * branched: `resolveRelayHelloTarget` reaches `updateOwned` (→
 * `ComputeTargetUpdateFailed`) when the hello carries a `computeTargetId` — the
 * steady-state reconnect — and `register` (→ `ComputeTargetRegisterFailed`)
 * only on a fresh registration. A single hard-coded reason would silently
 * change the reconnect path's status-bar string and its telemetry mapping.
 */
const OVER_LENGTH_MACHINE_NAME = "m".repeat(MACHINE_NAME_MAX_LENGTH + 1);
const AT_LENGTH_MACHINE_NAME = "m".repeat(MACHINE_NAME_MAX_LENGTH);

function helloPayload(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: "gateway-bug1",
    machineName: "bug1-machine",
    maxInFlightCommands: 1,
    platform: "linux",
    supportedOperations: [],
    ...overrides,
  };
}

function nackReason(result: Awaited<ReturnType<typeof handleHello>>) {
  const nack = result.emit.find(
    (entry) => entry.event === "desktop.hello.nack"
  );
  return (nack?.payload as { reason?: string } | undefined)?.reason;
}

describe("relay hello machineName length refusal (ISS-8880 §5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both write paths are wired to SUCCEED, so a missing guard registers the
    // over-length name and every assertion below fails loudly rather than
    // passing because the stub happened to error.
    mocks.register.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-bug1", id: TARGET_ID },
    });
    mocks.updateOwned.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-bug1", id: TARGET_ID },
    });
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
    mocks.countCommandsForTarget.mockResolvedValue(0);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([]);
    mocks.requeueUndeliveredCommands.mockResolvedValue(0);
  });

  it("nacks a fresh registration with compute_target_register_failed and never calls register", async () => {
    const result = await handleHello(
      helloPayload({ machineName: OVER_LENGTH_MACHINE_NAME }),
      AUTH
    );

    expect(nackReason(result)).toBe(
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    expect(result.disconnect).toBe(true);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.updateOwned).not.toHaveBeenCalled();
  });

  it("nacks a RECONNECT with compute_target_update_failed, the reason that path already produces", async () => {
    const result = await handleHello(
      helloPayload({
        computeTargetId: TARGET_ID,
        machineName: OVER_LENGTH_MACHINE_NAME,
      }),
      AUTH
    );

    // A hard-coded register-failed here would change the desktop's status-bar
    // string and its AuthReason telemetry on the steady-state reconnect path.
    expect(nackReason(result)).toBe(
      DesktopHelloNackReason.ComputeTargetUpdateFailed
    );
    expect(result.disconnect).toBe(true);
    expect(mocks.updateOwned).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("accepts a name exactly at the bound", async () => {
    const result = await handleHello(
      helloPayload({ machineName: AT_LENGTH_MACHINE_NAME }),
      AUTH
    );

    expect(nackReason(result)).toBeUndefined();
    expect(mocks.register).toHaveBeenCalledWith(
      AUTH.organizationId,
      AUTH.userId,
      expect.objectContaining({ machineName: AT_LENGTH_MACHINE_NAME })
    );
  });

  it("counts the padding, because this lane persists it", async () => {
    // This expectation is deliberately INVERTED from what it first asserted,
    // and the inversion is the fix. Measuring the trimmed length bounded a
    // string this lane never stores: `register` is called with the raw value
    // (pinned by the case below), so an at-bound name plus padding still
    // reached the `@@unique([userId, machineName])` btree and raised SQLSTATE
    // 54000 — the permanent handshake loop §5 exists to close. Matching the
    // REST lane's SPELLING was the wrong goal; matching what each lane WRITES
    // is the invariant.
    const padded = `  ${AT_LENGTH_MACHINE_NAME}  `;

    const result = await handleHello(
      helloPayload({ machineName: padded }),
      AUTH
    );

    expect(nackReason(result)).toBe(
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("nacks an oversized capability declaration rather than storing a prefix", async () => {
    // The parse used to `.slice()` to the cap and acknowledge the hello, so a
    // 501-operation desktop registered with 500 and every gate reading
    // `supportedOperations.includes(...)` reported the 501st as unsupported —
    // wrong, and invisible to both ends. `register` must not be reached.
    const result = await handleHello(
      helloPayload({
        supportedOperations: Array.from(
          { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
          (_value, index) => `gateway.op.${index}`
        ),
      }),
      AUTH
    );

    expect(nackReason(result)).toBe(
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("still registers a declaration exactly at the capability cap", async () => {
    // The over-rejection half: a `.max()` off by one would silently lock out a
    // desktop at the boundary.
    const atCap = Array.from(
      { length: SUPPORTED_OPERATIONS_MAX_COUNT },
      (_value, index) => `gateway.op.${index}`
    );

    const result = await handleHello(
      helloPayload({ supportedOperations: atCap }),
      AUTH
    );

    expect(nackReason(result)).toBeUndefined();
    expect(mocks.register).toHaveBeenCalledWith(
      AUTH.organizationId,
      AUTH.userId,
      expect.objectContaining({ supportedOperations: atCap })
    );
  });

  it("persists the machineName UNTRIMMED, exactly as it does today", async () => {
    const padded = "  bug1-machine  ";

    await handleHello(helloPayload({ machineName: padded }), AUTH);

    // The trim is for the length CHECK only. This lane stores the raw value
    // today and `computeTargetsService` does no trimming of its own, so
    // normalizing here would change stored bytes for a previously-valid name.
    expect(mocks.register).toHaveBeenCalledWith(
      AUTH.organizationId,
      AUTH.userId,
      expect.objectContaining({ machineName: padded })
    );
  });

  it("refuses a name one character over the bound", async () => {
    const result = await handleHello(
      helloPayload({ machineName: "m".repeat(MACHINE_NAME_MAX_LENGTH + 1) }),
      AUTH
    );

    expect(nackReason(result)).toBe(
      DesktopHelloNackReason.ComputeTargetRegisterFailed
    );
    expect(mocks.register).not.toHaveBeenCalled();
  });
});

// ISS-11426 path 1: `register` upserts on (userId, machineName) and keeps the
// existing row's org, so a hello in org B can be handed the same user's org-A
// row. The ack is unchanged; the event is the record that it happened.
describe("relay hello register org-mismatch telemetry (ISS-11426)", () => {
  const OTHER_ORG = "org-other";

  beforeEach(() => {
    vi.clearAllMocks();
    resetOwnershipRefusalEmissionWindowsForTest();
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
    mocks.countCommandsForTarget.mockResolvedValue(0);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([]);
    mocks.requeueUndeliveredCommands.mockResolvedValue(0);
  });

  function mismatchEvents() {
    return vi
      .mocked(log.warn)
      .mock.calls.filter(
        ([event]) => event === COMPUTE_TARGET_REGISTER_ORG_MISMATCH_EVENT
      )
      .map(([, fields]) => fields);
  }

  function ackedTargetId(result: Awaited<ReturnType<typeof handleHello>>) {
    const ack = result.emit.find(
      (entry) => entry.event === "desktop.hello.ack"
    );
    return (ack?.payload as { computeTargetId?: string } | undefined)
      ?.computeTargetId;
  }

  it("records a registered row owned by ANOTHER org, and still acks it unchanged", async () => {
    mocks.register.mockResolvedValue({
      ok: true,
      value: {
        gatewayId: "gateway-bug1",
        id: TARGET_ID,
        organizationId: OTHER_ORG,
        userId: AUTH.userId,
      },
    });

    const result = await handleHello(helloPayload(), AUTH);

    expect(ackedTargetId(result)).toBe(TARGET_ID);
    expect(mismatchEvents()).toEqual([
      {
        suppressedCount: 0,
        orgSuppressedCount: 0,
        computeTargetId: TARGET_ID,
        organizationId: AUTH.organizationId,
        userId: AUTH.userId,
        targetOrganizationId: OTHER_ORG,
        targetUserId: AUTH.userId,
      },
    ]);
  });

  it("logs a repeated mismatched hello once per window", async () => {
    mocks.register.mockResolvedValue({
      ok: true,
      value: {
        gatewayId: "gateway-bug1",
        id: TARGET_ID,
        organizationId: OTHER_ORG,
        userId: AUTH.userId,
      },
    });

    await handleHello(helloPayload(), AUTH);
    await handleHello(helloPayload(), AUTH);
    await handleHello(helloPayload(), AUTH);

    expect(mismatchEvents()).toHaveLength(1);
  });

  it("records nothing when the registered row is in the socket's own org", async () => {
    mocks.register.mockResolvedValue({
      ok: true,
      value: {
        gatewayId: "gateway-bug1",
        id: TARGET_ID,
        organizationId: AUTH.organizationId,
        userId: AUTH.userId,
      },
    });

    const result = await handleHello(helloPayload(), AUTH);

    expect(ackedTargetId(result)).toBe(TARGET_ID);
    expect(mismatchEvents()).toEqual([]);
  });

  it("states the socket's credential kind on the ack line, for the join against the HTTP refusal", async () => {
    mocks.register.mockResolvedValue({
      ok: true,
      value: {
        gatewayId: "gateway-bug1",
        id: TARGET_ID,
        organizationId: AUTH.organizationId,
        userId: AUTH.userId,
      },
    });

    await handleHello(helloPayload(), AUTH);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      "Relay hello processed",
      expect.objectContaining({
        authMethod: "api_key",
        computeTargetId: TARGET_ID,
        organizationId: AUTH.organizationId,
        outcome: "ack",
      })
    );
  });
});

// ISS-12435 (PLN-2182 AC-016): an already-installed Desktop build still sends
// the retired loop-runner capabilities and loop operation ids. The literals are
// the old client's wire values, which this repo no longer defines.
describe("relay hello from an old Desktop that still declares Loops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-bug1", id: TARGET_ID },
    });
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
    mocks.countCommandsForTarget.mockResolvedValue(0);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([]);
    mocks.requeueUndeliveredCommands.mockResolvedValue(0);
  });

  it("acks the hello and stores the retired capabilities and operation ids untouched", async () => {
    const result = await handleHello(
      helloPayload({
        capabilities: {
          loopRunnerHeartbeatSupported: true,
          loopRunnerRefreshSupported: true,
        },
        supportedOperations: ["symphony_loop", "codex_review", "git_action"],
      }),
      AUTH
    );

    expect(nackReason(result)).toBeUndefined();
    expect(
      result.emit.find((entry) => entry.event === "desktop.hello.ack")?.payload
    ).toMatchObject({ computeTargetId: TARGET_ID });
    expect(mocks.register).toHaveBeenCalledWith(
      AUTH.organizationId,
      AUTH.userId,
      expect.objectContaining({
        capabilities: expect.objectContaining({
          loopRunnerHeartbeatSupported: true,
          loopRunnerRefreshSupported: true,
        }),
        supportedOperations: ["symphony_loop", "codex_review", "git_action"],
      })
    );
  });
});
