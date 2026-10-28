/**
 * ISS-8686: a target holding queued commands with `in_flight = 0` must drain.
 *
 * The drain's other three triggers — reconnect, a terminal command event, and a
 * refused ack — are all downstream of an already-delivered command. At
 * `in_flight = 0` none of them can fire, so before this the backlog sat until
 * the next reconnect. These cases drive that state DIRECTLY through the
 * production presence path and never send a `desktop.hello`, because reconnect
 * is the already-covered trigger and a test that reached the drain through it
 * would stay green with this fix reverted.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFindComputeTargetById,
  mockHeartbeat,
  mockRecordRelayPresence,
  mockCountCommandsForTarget,
  mockCountInFlightCommandsForDispatch,
  mockListQueuedCommandsForDispatch,
  mockDispatchRelayCommandToRelay,
  pendingWork,
} = vi.hoisted(() => ({
  mockFindComputeTargetById: vi.fn(),
  mockHeartbeat: vi.fn(),
  mockRecordRelayPresence: vi.fn(),
  mockCountCommandsForTarget: vi.fn(),
  mockCountInFlightCommandsForDispatch: vi.fn(),
  mockListQueuedCommandsForDispatch: vi.fn(),
  mockDispatchRelayCommandToRelay: vi.fn(),
  pendingWork: [] as Promise<unknown>[],
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    listNonTerminalDispatchCommands: vi.fn(async () => []),
    ingestCommandEvent: vi.fn(),
    getCommandById: vi.fn(),
    countCommandsForTarget: mockCountCommandsForTarget,
  },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    register: vi.fn(),
    updateOwned: vi.fn(),
    setOnlineState: vi.fn(),
    heartbeat: mockHeartbeat,
    recordRelayPresence: mockRecordRelayPresence,
    findById: mockFindComputeTargetById,
  },
  isComputeTargetGatewayConflictResult: () => false,
}));

// Spread the real module: `releaseQueuedCommands` builds its wire payload with
// the real `toRelayOperation`, so only the outbound POST is replaced.
vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/compute-targets/relay-command-helpers")
    >()),
    dispatchRelayCommandToRelay: mockDispatchRelayCommandToRelay,
  })
);

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  // Only a non-null claim matters to the drain from here; the lease's own
  // semantics live in `command-drain.test.ts` and the integration suite.
  acquireCommandDrainLease: vi.fn(async () => new Date()),
  renewCommandDrainLease: vi.fn(async () => new Date()),
  releaseCommandDrainLease: vi.fn(async () => undefined),
  countInFlightCommandsForDispatch: mockCountInFlightCommandsForDispatch,
  listQueuedCommandsForDispatch: mockListQueuedCommandsForDispatch,
  requeueUndeliveredCommands: vi.fn(async () => 0),
}));

vi.mock("@/lib/relay-event-bus", () => ({
  relayEventBus: {
    clearOperationBacklog: vi.fn(),
    subscribeOperations: vi.fn(() => () => {
      // no-op unsubscribe
    }),
    subscribeTargetConnection: vi.fn(() => () => {
      // no-op unsubscribe
    }),
  },
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  isComputeTargetSigningEligible: vi.fn(),
}));

vi.mock("@repo/analytics/server", () => ({ analytics: { capture: vi.fn() } }));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/telemetry/context", () => ({
  buildTelemetryTraceContext: vi.fn(() => ({})),
  ZERO_GATEWAY_SESSION_ID: "zero-gateway-session-id",
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitConnectionStateEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitProtocolMetric: vi.fn(),
  emitQueueMetric: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    pendingWork.push(promise);
    return promise;
  },
}));

vi.mock("@/lib/desktop-gateway-wire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-gateway-wire")>()),
  isTerminalEventData: vi.fn(),
  toEnvelope: <T extends Record<string, unknown>>(payload: T) => payload,
  toWireCommandFromStore: vi.fn((cmd: unknown) => cmd),
}));

import { dispatchSocketEvent } from "../service";
import { resetFleetCapacitySamplerForTests } from "../service/fleet-capacity-sampler";

const TARGET_ID = "target-idle-drain-1";
const AUTH = {
  organizationId: "org-idle-drain",
  userId: "user-idle-drain",
  clerkUserId: "clerk-idle-drain",
};

/**
 * The ceiling the target declares. Written out rather than read back off the
 * capability under test, so a fixture that drifts cannot satisfy its own
 * expectation.
 */
const DECLARED_CEILING = 2;

function queuedCommand(index: number) {
  return {
    commandId: `cmd-idle-${index}`,
    computeTargetId: TARGET_ID,
    operationId: "health_check",
    status: DesktopCommandStatus.Queued,
    lastSequenceAcked: 0,
    method: "POST" as const,
    path: "/api/gateway/health-check",
    createdAt: new Date(Date.UTC(2026, 7, 28, 20, index)).toISOString(),
  };
}

/**
 * The desktop's own view of its queue, as the fleet-capacity sampler reads it.
 * `inFlight` here is the store's unfiltered count; the drain reads its own,
 * path-filtered one, so both are driven to 0 where an idle executor is claimed.
 */
function mockStoreCounts(queued: number, inFlight: number): void {
  mockCountCommandsForTarget.mockImplementation((_targetId, statuses) =>
    Promise.resolve(
      statuses === DesktopCommandStatus.Queued ? queued : inFlight
    )
  );
}

/**
 * Drives the production dispatcher for one presence heartbeat and settles the
 * work it schedules.
 *
 * `handlePresence` registers ONE promise on `waitUntil`, and the drain is
 * awaited inside it rather than registered separately, so settling that promise
 * settles the drain too. Drained in a loop anyway: a future handler that adds a
 * second registration must not silently stop being covered here.
 */
async function dispatchPresence(payload: JsonObject = {}): Promise<void> {
  await dispatchSocketEvent({
    event: "desktop.presence",
    payload,
    auth: AUTH,
    targetId: TARGET_ID,
    correlation: {},
    requestArrivedAt: Date.now(),
  });
  let settled = 0;
  while (settled < pendingWork.length) {
    const batch = pendingWork.slice(settled);
    settled = pendingWork.length;
    await Promise.all(batch);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFleetCapacitySamplerForTests();
  pendingWork.length = 0;
  mockHeartbeat.mockResolvedValue(true);
  mockRecordRelayPresence.mockResolvedValue(true);
  mockFindComputeTargetById.mockResolvedValue({
    id: TARGET_ID,
    capabilities: { maxInFlightCommands: DECLARED_CEILING },
  });
  mockDispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
  mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
  mockListQueuedCommandsForDispatch.mockResolvedValue([]);
  mockStoreCounts(0, 0);
});

describe("dispatchSocketEvent — desktop.presence drains an idle backlog", () => {
  it("dispatches a queued command for a target with in_flight = 0, without a reconnect", async () => {
    const IDLE_IN_FLIGHT = 0;
    mockStoreCounts(3, IDLE_IN_FLIGHT);
    mockCountInFlightCommandsForDispatch.mockResolvedValue(IDLE_IN_FLIGHT);
    mockListQueuedCommandsForDispatch.mockResolvedValue([
      queuedCommand(0),
      queuedCommand(1),
    ]);

    await dispatchPresence();

    // The dispatch is the observable outcome: a drain that resolved without
    // putting a command on the wire would leave the backlog exactly as stuck.
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(2);
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        commandId: queuedCommand(0).commandId,
      })
    );
  });

  it("never releases more than the declared ceiling, however deep the backlog", async () => {
    // The backlog is deeper than the ceiling, so a drain that read the whole
    // queue would burst past it. The SQL cap is what stops that, so the limit
    // the query is asked for is asserted alongside the dispatch count.
    mockStoreCounts(50, 0);
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([
      queuedCommand(0),
      queuedCommand(1),
    ]);

    await dispatchPresence();

    expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID,
      DECLARED_CEILING
    );
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(
      DECLARED_CEILING
    );
  });

  it("releases nothing while the ceiling is already full", async () => {
    // A backlog with a FULL executor must not be woken: the existing terminal
    // and ack triggers own that case, and dispatching here would exceed the
    // ceiling the desktop declared.
    mockStoreCounts(5, DECLARED_CEILING);
    mockCountInFlightCommandsForDispatch.mockResolvedValue(DECLARED_CEILING);

    await dispatchPresence();

    expect(mockListQueuedCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockDispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("costs no drain read at all when the target holds nothing queued", async () => {
    // The gate, asserted as a query that never happens. Presence fires ~27k
    // times a day in production, so an ungated wake would spend three reads on
    // every idle heartbeat in the fleet.
    mockStoreCounts(0, 0);

    await dispatchPresence();

    expect(mockCountInFlightCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockListQueuedCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockDispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("does not drain when the queue depth could not be read", async () => {
    // A failed count is not a depth of zero, and it is not a backlog either.
    // Draining on it would turn an unreadable database into fleet-wide dispatch.
    mockCountCommandsForTarget.mockRejectedValue(new Error("count failed"));

    await dispatchPresence();

    expect(mockCountInFlightCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockDispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("stamps the presence clock, and does not reach the transport-agnostic check-in writer", async () => {
    // ISS-8897. This is the production wiring the new column depends on: the
    // relay presence frame is the ONE path that drives the wake below, so it is
    // the one path allowed to advance `presenceAt`. Routing it back through
    // `heartbeat` would stamp `lastSeenAt` alone and leave every drain decision
    // reading a clock four other transports also move. The negative half is
    // load-bearing on its own — calling BOTH would restore the conflation with
    // an extra column to maintain.
    mockStoreCounts(0, 0);

    await dispatchPresence();

    expect(mockRecordRelayPresence).toHaveBeenCalledWith(
      TARGET_ID,
      AUTH.organizationId,
      AUTH.userId
    );
    expect(mockHeartbeat).not.toHaveBeenCalled();
  });
});
