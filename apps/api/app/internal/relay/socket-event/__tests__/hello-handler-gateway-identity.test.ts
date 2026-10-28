import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isComputeTargetSigningEligible: vi.fn(),
  listNonTerminalDispatchCommands: vi.fn(),
  register: vi.fn(),
  setOnlineState: vi.fn(),
  updateOwned: vi.fn(),
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
  requeueUndeliveredCommands: vi.fn(),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    countCommandsForTarget: vi.fn(async () => 0),
    listNonTerminalDispatchCommands: mocks.listNonTerminalDispatchCommands,
  },
}));

vi.mock("@/lib/desktop-gateway-wire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-gateway-wire")>()),
  toEnvelope: <T>(payload: T) => payload,
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: { clearOperationBacklog: vi.fn() },
}));

vi.mock("@/lib/route-utils", () => ({ scheduleLogFlush: vi.fn() }));

vi.mock("../service/github-dirty-scope-drain", () => ({
  scheduleGitHubDirtyScopeRecoveryDrain: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn(() => ({})),
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitConnectionStateEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

import { log } from "@repo/observability/log";
import { handleHello } from "../service/hello-handler";

const AUTH = {
  clerkUserId: "clerk-iss12032",
  organizationId: "org-iss12032",
  userId: "user-iss12032",
};
const TARGET_ID = "target-iss12032";
const HELLO_LOG_MESSAGE = "Relay hello processed";

describe("relay hello gateway identity (ISS-12032)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setOnlineState.mockResolvedValue(true);
    mocks.listNonTerminalDispatchCommands.mockResolvedValue([]);
    mocks.isComputeTargetSigningEligible.mockResolvedValue({
      reason: "missing_gateway",
      status: "ineligible",
    });
  });

  it("asks the reconnect update to clear a gatewayId the hello did not declare", async () => {
    mocks.updateOwned.mockResolvedValue({
      ok: true,
      value: { gatewayId: null, id: TARGET_ID },
    });

    await handleHello(helloPayload({}), AUTH);

    expect(mocks.updateOwned.mock.calls[0]?.[3]).toMatchObject({
      gatewayId: null,
    });
    expect(helloLogFields()).toMatchObject({
      declaredGatewayId: null,
      storedGatewayId: null,
    });
  });

  it("asks the first-connect registration to clear a gatewayId the hello did not declare", async () => {
    mocks.register.mockResolvedValue({
      ok: true,
      value: { gatewayId: null, id: TARGET_ID },
    });

    await handleHello(
      { ...helloPayload({}), computeTargetId: undefined },
      AUTH
    );

    expect(mocks.updateOwned).not.toHaveBeenCalled();
    expect(mocks.register.mock.calls[0]?.[2]).toMatchObject({
      gatewayId: null,
    });
  });

  it("logs the declared gatewayId beside the stored one", async () => {
    mocks.updateOwned.mockResolvedValue({
      ok: true,
      value: { gatewayId: "gateway-current", id: TARGET_ID },
    });

    await handleHello(helloPayload({ gatewayId: "gateway-current" }), AUTH);

    expect(helloLogFields()).toMatchObject({
      declaredGatewayId: "gateway-current",
      storedGatewayId: "gateway-current",
    });
  });
});

function helloPayload(overrides: { gatewayId?: string }) {
  return {
    computeTargetId: TARGET_ID,
    machineName: "iss12032-machine",
    platform: "darwin",
    supportedOperations: [],
    ...overrides,
  };
}

function helloLogFields(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(log.info)
    .mock.calls.find(([message]) => message === HELLO_LOG_MESSAGE);
  return call?.[1] as Record<string, unknown> | undefined;
}
