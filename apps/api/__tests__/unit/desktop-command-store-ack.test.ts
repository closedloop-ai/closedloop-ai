/**
 * Unit tests for desktopCommandStore.acknowledgeCommand —
 * CommandAcknowledged lifecycle emission.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/telemetry/origin", () => ({
  ORIGIN: "api",
  Origin: {
    Api: "api",
    Desktop: "desktop",
    Relay: "relay",
    Unknown: "unknown",
  },
  KNOWN_ORIGINS: ["desktop", "api", "relay"],
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitCommandLifecycleEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: vi.fn(),
}));

// --- Database mock ---
// acknowledgeCommand calls:
//   1. findCommandByIdScoped → withDb (findFirst / findUnique)
//   2. withDb (updateMany) → { count }
//   3. findCommandByIdScoped again → withDb (findFirst / findUnique)

let mockFindFirst = vi.fn();
let mockUpdateMany = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        desktopCommand: {
          findUnique: mockFindFirst,
          findFirst: mockFindFirst,
          updateMany: mockUpdateMany,
        },
      })
    ),
    { tx: vi.fn() }
  ),
}));

// --- Imports (after mocks) ---

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { emitCommandLifecycleEvent } from "@repo/observability/telemetry/emitter";
import { emitQueueMetric } from "@repo/observability/telemetry/metrics";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { TERMINAL_DESKTOP_COMMAND_STATUSES } from "@/lib/desktop-command-mappers";
import { desktopCommandStore } from "@/lib/desktop-command-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const COMMAND_ID = "cmd-ack-test-1";
const COMPUTE_TARGET_ID = "target-ack-1";
const OPERATION_ID = "op-ack-1";
/**
 * The queue entry these rows carry.
 *
 * ISS-9630 stamps the ack with the entry it answers rather than with wall-clock
 * now, so a fixture without this would exercise only the null-`queuedAt`
 * fallback and the assertions below could not name the instant they expect.
 */
const QUEUED_AT = new Date("2026-09-11T11:00:00.000Z");

function makeCommandRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: COMMAND_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    operationId: OPERATION_ID,
    status: "queued",
    requestPayload: {
      operationId: OPERATION_ID,
      method: "POST",
      path: "/api/gateway",
    },
    error: null,
    createdAt: new Date(Date.now() - 100),
    queuedAt: QUEUED_AT,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    lastSequenceAcked: 0,
    idempotencyKey: null,
    requestFingerprint: "fp-1",
    ...overrides,
  };
}

function makeContext(gatewaySessionId = VALID_UUID) {
  return buildTelemetryTraceContext({
    gatewaySessionId,
    computeTargetId: COMPUTE_TARGET_ID,
  });
}

describe("acknowledgeCommand — CommandAcknowledged lifecycle emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();

    // Default: findFirst returns a row, updateMany transitions, re-fetch returns updated
    mockFindFirst = vi.fn().mockResolvedValue(makeCommandRow());
    mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  });

  it.each([
    { accepted: true, label: "accepted=true", expectedStatus: "accepted" },
    { accepted: false, label: "accepted=false", expectedStatus: "failed" },
  ])("emits CommandAcknowledged on $label path", async ({ accepted }) => {
    // Re-assign after clearAllMocks resets the fn refs
    mockFindFirst.mockResolvedValue(makeCommandRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const ctx = makeContext();

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      accepted,
      accepted ? undefined : "not supported",
      COMPUTE_TARGET_ID,
      ctx
    );

    // (a) first arg is TelemetryCategory.CommandAcknowledged
    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledWith(
      TelemetryCategory.CommandAcknowledged,
      expect.anything(),
      expect.anything()
    );

    // (b) Production code spreads `...context` first and then sets
    // commandId / operationId / computeTargetId from the command row, so the
    // row-level values unconditionally win over any defaults in ctx.
    // gatewaySessionId is only in ctx, so it is preserved from the spread.
    const [, traceArg] = vi.mocked(emitCommandLifecycleEvent).mock.calls[0];
    expect(traceArg).toMatchObject({
      commandId: COMMAND_ID,
      operationId: OPERATION_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      gatewaySessionId: VALID_UUID,
    });

    // (c) options third arg has diagnostics.ackLatencyMs as non-negative number
    const [, , optionsArg] = vi.mocked(emitCommandLifecycleEvent).mock.calls[0];
    expect(optionsArg).toMatchObject({
      diagnostics: {
        ackLatencyMs: expect.any(Number),
      },
    });
    const ackLatency = (optionsArg as { diagnostics: { ackLatencyMs: number } })
      .diagnostics.ackLatencyMs;
    expect(ackLatency).toBeGreaterThanOrEqual(0);
  });

  it("does not throw when gatewaySessionId is the zero-UUID sentinel", async () => {
    mockFindFirst.mockResolvedValue(makeCommandRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const ctx = makeContext(ZERO_UUID);

    await expect(
      desktopCommandStore.acknowledgeCommand(
        COMMAND_ID,
        true,
        undefined,
        COMPUTE_TARGET_ID,
        ctx
      )
    ).resolves.not.toThrow();
  });

  it("does not emit CommandAcknowledged when context is omitted", async () => {
    mockFindFirst.mockResolvedValue(makeCommandRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID
    );

    expect(vi.mocked(emitCommandLifecycleEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(emitQueueMetric)).toHaveBeenCalled();
  });

  it("does not inject an explicit origin key into the trace arg (origin is auto-stamped downstream by the emitter)", async () => {
    mockFindFirst.mockResolvedValue(makeCommandRow());
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    const [, traceArg] = vi.mocked(emitCommandLifecycleEvent).mock.calls[0];
    expect(traceArg).not.toHaveProperty("origin");
  });
});

describe("acknowledgeCommand — lifecycle emitter throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("returns non-null DesktopCommandSummary even when emitCommandLifecycleEvent throws", async () => {
    mockFindFirst = vi.fn().mockResolvedValue(makeCommandRow());
    mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    vi.mocked(emitCommandLifecycleEvent).mockImplementation(() => {
      throw new Error("boom");
    });

    const result = await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(result).not.toBeNull();
    expect(result?.commandId).toBe(COMMAND_ID);
  });

  it("calls emitQueueMetric even when emitCommandLifecycleEvent throws", async () => {
    mockFindFirst = vi.fn().mockResolvedValue(makeCommandRow());
    mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    vi.mocked(emitCommandLifecycleEvent).mockImplementation(() => {
      throw new Error("boom");
    });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(vi.mocked(emitQueueMetric)).toHaveBeenCalled();
  });

  it("calls the DB updateMany even when emitCommandLifecycleEvent throws", async () => {
    mockFindFirst = vi.fn().mockResolvedValue(makeCommandRow());
    mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    vi.mocked(emitCommandLifecycleEvent).mockImplementation(() => {
      throw new Error("boom");
    });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: COMMAND_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        status: DesktopCommandStatus.Queued,
        // The freshness guard: this ack may only move a record no newer
        // delivery's ack has already written. Its behaviour is pinned in
        // `desktop-command-acked-at.test.ts`; it appears here because this case
        // asserts the WHOLE call, so an omission would read as a silent drop.
        OR: [{ ackedAt: null }, { ackedAt: { lt: QUEUED_AT } }],
      },
      // ISS-9630 added the ack timestamp to this write — the queue entry being
      // answered, not the wall clock, which is why it is `QUEUED_AT` and not a
      // frozen-now. The race that makes the difference load-bearing is covered
      // in `desktop-command-acked-at.test.ts`; what this case owes is that the
      // write still happens when the emitter throws.
      data: {
        status: DesktopCommandStatus.Accepted,
        ackedAt: QUEUED_AT,
      },
    });
  });

  it("uses notIn guard for a non-Queued non-terminal row", async () => {
    // command.status is already "accepted" (not "queued"), so the acceptance
    // branch's `data = { status: Accepted }` shortcut does not apply — the
    // production code falls through to the status-less branch and guards with
    // `notIn`. Since ISS-9630 that branch is no longer empty: it records the
    // ack timestamp, which is the whole point of the column.
    mockFindFirst = vi
      .fn()
      .mockResolvedValue(
        makeCommandRow({ status: DesktopCommandStatus.Accepted })
      );
    mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: COMMAND_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        status: { notIn: TERMINAL_DESKTOP_COMMAND_STATUSES },
        OR: [{ ackedAt: null }, { ackedAt: { lt: QUEUED_AT } }],
      },
      // ISS-9630: this write used to be empty. It now carries the ack
      // timestamp and nothing else — an ack for an already-running command
      // must still not move `status`, which is what the absence of a `status`
      // key here pins.
      data: { ackedAt: QUEUED_AT },
    });
  });
});

describe("acknowledgeCommand — at-least-once emission across races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopCommandStore.__resetForTests();
  });

  it("emits CommandAcknowledged on each ack call (at-least-once; downstream dedupes on commandId+timestamp)", async () => {
    // First call: updateMany transitions the row
    // Second call: race — updateMany returns 0 (row already advanced on an
    // independent path, e.g. desktop.command.event → running). We still want
    // the ack-latency signal for the second arrival. Downstream is responsible
    // for dedup across the at-least-once stream.
    let callCount = 0;
    mockFindFirst = vi.fn().mockImplementation(() => {
      return Promise.resolve(makeCommandRow());
    });
    mockUpdateMany = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({ count: callCount === 1 ? 1 : 0 });
    });

    const ctx = makeContext();

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      ctx
    );
    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      ctx
    );

    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(emitCommandLifecycleEvent).mock.calls) {
      expect(call[0]).toBe(TelemetryCategory.CommandAcknowledged);
    }
  });

  it("emits CommandAcknowledged when the queued→running race causes updateMany to match zero rows", async () => {
    // Snapshot sees status="queued", but the event path transitions to
    // "running" between findFirst and updateMany. updateMany's `status=queued`
    // guard therefore matches nothing (count=0) — the ack still arrived and
    // must produce a telemetry event.
    mockFindFirst.mockResolvedValue(makeCommandRow({ status: "queued" }));
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledWith(
      TelemetryCategory.CommandAcknowledged,
      expect.objectContaining({ commandId: COMMAND_ID }),
      expect.objectContaining({
        diagnostics: { ackLatencyMs: expect.any(Number) },
      })
    );
    // No state transition was written, so the metric must NOT fire.
    expect(vi.mocked(emitQueueMetric)).not.toHaveBeenCalled();
  });

  it("emits CommandAcknowledged when the snapshot already shows status=running (no state transition written)", async () => {
    // Event path already moved the row to "running" before ack handling
    // began; acknowledgeCommand takes the `data = {}` branch (toStatus
    // undefined) and updateMany succeeds under the `notIn` guard. The ack
    // still arrived and must emit.
    mockFindFirst.mockResolvedValue(makeCommandRow({ status: "running" }));
    mockUpdateMany.mockResolvedValue({ count: 1 });

    await desktopCommandStore.acknowledgeCommand(
      COMMAND_ID,
      true,
      undefined,
      COMPUTE_TARGET_ID,
      makeContext()
    );

    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitCommandLifecycleEvent)).toHaveBeenCalledWith(
      TelemetryCategory.CommandAcknowledged,
      expect.objectContaining({ commandId: COMMAND_ID }),
      expect.objectContaining({
        diagnostics: { ackLatencyMs: expect.any(Number) },
      })
    );
    // `data` was empty, so state-transition metric must NOT fire.
    expect(vi.mocked(emitQueueMetric)).not.toHaveBeenCalled();
  });
});
