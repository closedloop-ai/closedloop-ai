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
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitQueueMetric } from "@repo/observability/telemetry/metrics";
import { Origin } from "@repo/observability/telemetry/origin";
import { computeTargetsService } from "@/app/compute-targets/service";
import { POST } from "@/app/internal/relay/socket-event/route";
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
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(2);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }
    );

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
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(2);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }
    );

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

  it("emits executor_saturation=0 when 0 in-flight out of 3 max (AC-003)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(0);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(0);
        }
        return Promise.resolve(0);
      }
    );

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    expect(emitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "executor_saturation",
        value: 0,
        computeTargetId: COMPUTE_TARGET_ID,
        origin: Origin.Api,
      })
    );
  });

  it("emits executor_saturation=1 when 3 in-flight out of 3 max (AC-003)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(0);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(3);
        }
        return Promise.resolve(0);
      }
    );

    const request = makeSocketEventRequest("desktop.hello", helloPayload);
    await POST(request);

    expect(emitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "executor_saturation",
        value: 1,
        computeTargetId: COMPUTE_TARGET_ID,
        origin: Origin.Api,
      })
    );
  });

  it("emits executor_saturation=0.5 when 2 in-flight out of 4 max (AC-003)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(0);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(2);
        }
        return Promise.resolve(0);
      }
    );

    const payloadWith4Max = { ...helloPayload, maxInFlightCommands: 4 };
    const request = makeSocketEventRequest("desktop.hello", payloadWith4Max);
    await POST(request);

    expect(emitQueueMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "executor_saturation",
        value: 0.5,
        computeTargetId: COMPUTE_TARGET_ID,
        origin: Origin.Api,
      })
    );
  });

  it("skips executor_saturation and warns when maxInFlightCommands is 0 (AC-004)", async () => {
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockResolvedValue(0);

    const payloadWith0Max = { ...helloPayload, maxInFlightCommands: 0 };
    const request = makeSocketEventRequest("desktop.hello", payloadWith0Max);
    await POST(request);

    const metricNames = vi
      .mocked(emitQueueMetric)
      .mock.calls.map((call) => call[0].metric);
    expect(metricNames).not.toContain("executor_saturation");

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ event: "executor_saturation_skipped" })
    );
  });

  it("skips executor_saturation and warns when maxInFlightCommands is undefined (AC-004)", async () => {
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

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ event: "executor_saturation_skipped" })
    );
  });

  it("skips executor_saturation and warns when maxInFlightCommands is a non-numeric string (AC-004)", async () => {
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

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "executor_saturation_skipped",
      expect.objectContaining({ event: "executor_saturation_skipped" })
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
    vi.mocked(desktopCommandStore.countCommandsForTarget).mockImplementation(
      (_targetId, statuses) => {
        if (statuses === DesktopCommandStatus.Queued) {
          return Promise.resolve(2);
        }
        if (Array.isArray(statuses)) {
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }
    );

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
