/**
 * Compatibility test: compute target registration flow.
 *
 * Validates that when a desktop.hello event arrives without a computeTargetId,
 * the route calls computeTargetsService.register and returns a hello.ack with
 * the newly assigned computeTargetId.
 */

import { Result } from "@repo/api/src/types/result";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports that transitively pull in the mocked modules) ---

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
      countCommandsForTarget: vi.fn().mockResolvedValue(0),
    },
  };
});

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  requeueUndeliveredCommands: vi.fn().mockResolvedValue(0),
}));

vi.mock("@repo/observability/telemetry/metrics", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@repo/observability/telemetry/metrics")
    >();
  return { ...original, emitQueueMetric: vi.fn() };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => p,
}));

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

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

// --- Imports (after mocks) ---

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitQueueMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
import { requeueUndeliveredCommands } from "@/lib/desktop-command-dispatch-queries";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  INTERNAL_SECRET,
  makeSocketEventRequest,
  mockGatewayOwnerAuthContext,
  mockTarget,
} from "./utils/test-fixtures";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const newTarget = { ...mockTarget, id: "new-target-1" };
const COMPUTE_TARGET_ID = "new-target-1";

const helloPayload = {
  machineName: "new-machine",
  platform: "linux",
  pluginVersion: "2.0.0",
  supportedOperations: ["symphony_chat", "git_action"],
  maxInFlightCommands: 3,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(computeTargetsService.register).mockResolvedValue(
    Result.ok(newTarget)
  );
  vi.mocked(computeTargetsService.updateOwned).mockResolvedValue(
    Result.ok(null)
  );
  vi.mocked(
    desktopCommandStore.listNonTerminalDispatchCommands
  ).mockResolvedValue([]);
  vi.mocked(relayEventBus.clearOperationBacklog).mockImplementation(vi.fn());
  vi.mocked(emitQueueMetric).mockClear();
  vi.mocked(log.warn).mockClear();
});

/**
 * `inFlight` is the `{Accepted, Running}` set counted in one statement, matching
 * the production query — not two counts summed, which would let a command
 * transitioning between them be counted twice or missed.
 */
function mockCommandCounts(counts: { queued: number; inFlight: number }): void {
  vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
    (_targetId, statuses) =>
      Promise.resolve(
        statuses === DesktopCommandStatus.Queued
          ? counts.queued
          : counts.inFlight
      )
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /internal/relay/socket-event — compute target registration", () => {
  it("returns HTTP 200", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("calls computeTargetsService.register with the correct arguments", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    await POST(request);

    expect(computeTargetsService.register).toHaveBeenCalledWith(
      mockTarget.organizationId,
      mockTarget.userId,
      expect.objectContaining({
        machineName: "new-machine",
        platform: "linux",
        pluginVersion: "2.0.0",
        supportedOperations: ["symphony_chat", "git_action"],
      })
    );
  });

  it("returns the newly assigned targetId in the response body", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);
    const result = await response.json();

    expect(result.targetId).toBe("new-target-1");
  });

  it("emits desktop.hello.ack with the new computeTargetId", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload);

    const response = await POST(request);
    const result = await response.json();

    expect(result.emit[0].event).toBe("desktop.hello.ack");
    expect(result.emit[0].payload).toEqual(
      expect.objectContaining({
        computeTargetId: "new-target-1",
      })
    );
  });

  it("keeps gateway-owner identity out of registration ack", async () => {
    const request = makeSocketEventRequest("desktop.hello", helloPayload, {
      auth: mockGatewayOwnerAuthContext,
    });

    const response = await POST(request);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(computeTargetsService.register).toHaveBeenCalledWith(
      "org-1",
      "user_db_1",
      expect.any(Object)
    );
    expect(result.emit[0].payload).toEqual(
      expect.objectContaining({
        computeTargetId: "new-target-1",
      })
    );
    expect(result.emit[0].payload.clerkUserId).toBeUndefined();
    expect(result.emit[0].payload.organizationId).toBeUndefined();
    expect(result.emit[0].payload.userId).toBeUndefined();
  });

  it("emits queued_command_count metric with the queued count (AC-001)", async () => {
    mockCommandCounts({ queued: 2, inFlight: 1 });

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    expect(emitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "queued_command_count",
        value: 2,
        computeTargetId: COMPUTE_TARGET_ID,
        origin: Origin.Api,
        filterToken: FilterToken.CommandQueued,
      })
    );
  });

  it("emits in_flight_command_count metric with the in-flight count (AC-002)", async () => {
    mockCommandCounts({ queued: 2, inFlight: 1 });

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    expect(emitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "in_flight_command_count",
        value: 1,
        computeTargetId: COMPUTE_TARGET_ID,
        origin: Origin.Api,
        filterToken: FilterToken.CommandDispatched,
      })
    );
  });

  // ISS-8453 retired hello's executor_saturation. The three cases that stood
  // here asserted it over `{Accepted + Running}` command rows, which is the
  // count that read 53.0 against a ceiling of 2 in production. Saturation is now
  // taken from the occupancy the desktop reports on presence, and a handshake
  // reports none — so the honest hello contract is the queue gauges plus a
  // skip. The arithmetic those cases covered is pinned on the presence path in
  // service-presence-fleet-capacity.test.ts.
  // ISS-8453 AC-001/AC-002. Production reconnected with 106 pending against a
  // declared ceiling of 2 and shipped all 106 in one frame. `helloPayload`
  // declares 3, written out below as an independent literal rather than read
  // back off the payload — a fixture that derives its expectation from the
  // value under test passes at any value.
  it("releases only up to maxInFlightCommands on reconnect and requeues the rest (AC-001, AC-002)", async () => {
    const DECLARED_CEILING = 3;
    const PENDING_BACKLOG = 20;
    const pending = Array.from({ length: PENDING_BACKLOG }, (_, index) => ({
      commandId: `cmd-${index}`,
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: "health_check",
      status: DesktopCommandStatus.Queued,
      lastSequenceAcked: 0,
      method: "POST" as const,
      path: "/api/gateway/health-check",
      createdAt: new Date(Date.UTC(2026, 7, 28, 18, index)).toISOString(),
    }));
    vi.mocked(
      desktopCommandStore.listNonTerminalDispatchCommands
    ).mockResolvedValue(pending);

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    const response = await POST(request);
    const result = await response.json();

    const commandEmits = result.emit.filter(
      (instruction: { event: string }) =>
        instruction.event === "desktop.command"
    );
    expect(commandEmits).toHaveLength(DECLARED_CEILING);
    // FIFO: the ceiling is spent on the oldest work, not an arbitrary slice.
    expect(
      commandEmits.map(
        (instruction: { payload: { commandId: string } }) =>
          instruction.payload.commandId
      )
    ).toEqual(["cmd-0", "cmd-1", "cmd-2"]);

    // The withheld remainder is returned to `queued` so the drain can find it —
    // without this they would strand until the next reconnect.
    expect(requeueUndeliveredCommands).toHaveBeenCalledWith(
      COMPUTE_TARGET_ID,
      pending.slice(DECLARED_CEILING).map((command) => command.commandId)
    );
  });

  it("emits the queue gauges but skips executor_saturation on hello, which carries no occupancy (AC-003)", async () => {
    mockCommandCounts({ queued: 2, inFlight: 3 });

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).toEqual(
      expect.arrayContaining([
        "queued_command_count",
        "in_flight_command_count",
      ])
    );
    expect(metricNames).not.toContain("executor_saturation");
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "activeCommands_absent" })
    );
  });

  // ISS-8547 bounded the declared ceiling at the PARSE, so a declared 0 is
  // floored to 1 before the saturation path ever sees it and can no longer reach
  // that path's `maxInFlightCommands_invalid` branch. AC-004 is unchanged — a
  // declared 0 must not publish a saturation ratio, and must not be throttled
  // silently — but the row that says why moved to the clamp, and its declared /
  // applied pair is pinned here because that pair IS the reason.
  it("skips executor_saturation and reports the clamp when maxInFlightCommands is 0 (AC-004)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockResolvedValue(0);

    const payloadWith0Max = { ...helloPayload, maxInFlightCommands: 0 };
    const request = makeSocketEventRequest("desktop.hello", payloadWith0Max);
    await POST(request);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).not.toContain("executor_saturation");

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "desktop.hello.maxInFlightCommands.clamped",
      expect.objectContaining({ declared: 0, applied: 1 })
    );
  });

  // ISS-8171 demoted the absence case from warn to debug: an old desktop that
  // predates the capability is expected version skew, so it belongs off the warn
  // dashboards a real data defect should reach. The demotion changes the level
  // only — it does not reduce the number of rows shipped.
  it("skips executor_saturation and logs the absence at debug when maxInFlightCommands is undefined (AC-004)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockResolvedValue(0);

    const { maxInFlightCommands: _omitted, ...payloadWithoutMax } =
      helloPayload;
    const request = makeSocketEventRequest(
      "desktop.hello",
      payloadWithoutMax as Record<string, unknown>
    );
    await POST(request);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).not.toContain("executor_saturation");

    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_absent" })
    );
  });

  // A non-numeric value never reaches the emit as itself: the hello handler
  // narrows anything non-numeric to `undefined` before persisting or emitting,
  // so at this boundary it is indistinguishable from a field that was omitted.
  it("skips executor_saturation and treats a non-numeric maxInFlightCommands as absent (AC-004)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockResolvedValue(0);

    const payloadWithStringMax = {
      ...helloPayload,
      maxInFlightCommands: "not-a-number" as unknown as number,
    };
    const request = makeSocketEventRequest(
      "desktop.hello",
      payloadWithStringMax as Record<string, unknown>
    );
    await POST(request);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).not.toContain("executor_saturation");

    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ reason: "maxInFlightCommands_absent" })
    );
  });

  it("returns HTTP 200 and emits no fleet-capacity metrics when countCommandsForTarget rejects (AC-005)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockRejectedValue(
      new Error("db connection failed")
    );

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    const response = await POST(request);

    expect(response.status).toBe(200);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).not.toContain("queued_command_count");
    expect(metricNames).not.toContain("in_flight_command_count");
    expect(metricNames).not.toContain("executor_saturation");

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "fleet.capacity_metrics.query_failed",
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("still returns the expected ack response when countCommandsForTarget rejects (AC-005)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockRejectedValue(
      new Error("db connection failed")
    );

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    const response = await POST(request);
    const result = await response.json();

    expect(result.emit[0].event).toBe("desktop.hello.ack");
    expect(result.emit[0].payload).toEqual(
      expect.objectContaining({
        computeTargetId: COMPUTE_TARGET_ID,
      })
    );
  });

  it("fleet-capacity metric calls do NOT include a commandId property (AC-006)", async () => {
    mockCommandCounts({ queued: 2, inFlight: 1 });

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    const fleetCapacityMetricNames = [
      "queued_command_count",
      "in_flight_command_count",
      "executor_saturation",
    ];
    const fleetCalls = vi
      .mocked(emitQueueMetric)
      .mock.calls.filter((call) =>
        fleetCapacityMetricNames.includes(call[0].metric)
      );

    expect(fleetCalls.length).toBeGreaterThan(0);
    for (const [metricArg] of fleetCalls) {
      expect(metricArg).not.toHaveProperty("commandId");
    }
  });
});
