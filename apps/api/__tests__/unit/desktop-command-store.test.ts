/**
 * Unit tests for desktopCommandStore covering:
 * - countCommandsForTarget — status filter and computeTargetId scoping
 * - markCommandExpired — dropped_expired_work_items metric emission (T-3.1)
 * - ingestCommandEvent — event_ordering_gaps metric on sequence gap (T-3.2)
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

const {
  mockWithDb,
  mockWithDbTx,
  mockEmitQueueMetric,
  mockEmitProtocolMetric,
  desktopCommandCountSpy,
  desktopCommandCreateSpy,
  desktopCommandUpdateManySpy,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockEmitQueueMetric: vi.fn(),
  mockEmitProtocolMetric: vi.fn(),
  desktopCommandCountSpy: vi.fn(),
  desktopCommandCreateSpy: vi.fn(),
  desktopCommandUpdateManySpy: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/emitter", () => ({
  emitCommandLifecycleEvent: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: mockEmitQueueMetric,
  emitProtocolMetric: mockEmitProtocolMetric,
}));

vi.mock("@repo/observability/telemetry/origin", () => ({
  ORIGIN: "test",
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
}));

// --- Imports (after mocks) ---

import {
  type BrowserSignedCommandId,
  DesktopCommandStatus,
} from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopCommandStore } from "@/lib/desktop-command-store";

beforeEach(() => {
  vi.clearAllMocks();
  // Default withDb implementation: call the callback with a DB exposing
  // the spies tests override per-case via `.mockResolvedValueOnce`.
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      desktopCommand: {
        count: desktopCommandCountSpy,
        create: desktopCommandCreateSpy,
        updateMany: desktopCommandUpdateManySpy,
      },
    })
  );
});

function installCreateCommandMock(): void {
  desktopCommandCreateSpy.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) => ({
      id: data.id ?? "server-command-id",
      computeTargetId: data.computeTargetId,
      operationId: data.operationId,
      status: data.status,
      requestPayload: data.requestPayload,
      error: null,
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
      lastSequenceAcked: data.lastSequenceAcked,
      idempotencyKey: data.idempotencyKey,
      requestFingerprint: data.requestFingerprint,
    })
  );
}

// ---------------------------------------------------------------------------
// command signing persistence
// ---------------------------------------------------------------------------

describe("desktopCommandStore.createCommand command signing fields", () => {
  beforeEach(() => {
    desktopCommandStore.__resetForTests();
    installCreateCommandMock();
  });

  it("uses a browser-supplied command id without persisting signature material", async () => {
    const commandId =
      "0196b1bb-7a00-7000-8000-000000000001" as BrowserSignedCommandId;

    await desktopCommandStore.createCommand("target-1", {
      commandId,
      operationId: "git_action",
      method: "POST",
      path: "/api/gateway/git",
      body: { action: "status" },
      signature: "signature-base64",
      signaturePayload: '{"signed":true}',
      publicKeyFingerprint: "cl:testfingerprint",
    });

    const createData = desktopCommandCreateSpy.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(createData.id).toBe(commandId);
    expect(createData.requestPayload).toEqual({
      operationId: "git_action",
      method: "POST",
      path: "/api/gateway/git",
      body: { action: "status" },
    });
  });

  it("keeps request fingerprints stable across browser re-signing", async () => {
    const baseCommand = {
      operationId: "git_action",
      method: "POST" as const,
      path: "/api/gateway/git",
      body: { action: "status", repoPath: "/repo" },
    };

    await desktopCommandStore.createCommand("target-1", {
      ...baseCommand,
      commandId:
        "0196b1bb-7a00-7000-8000-000000000002" as BrowserSignedCommandId,
      signature: "first-signature",
      signaturePayload: '{"nonce":"first"}',
      publicKeyFingerprint: "cl:first",
    });
    await desktopCommandStore.createCommand("target-1", {
      ...baseCommand,
      commandId:
        "0196b1bb-7a00-7000-8000-000000000003" as BrowserSignedCommandId,
      signature: "second-signature",
      signaturePayload: '{"nonce":"second"}',
      publicKeyFingerprint: "cl:second",
    });

    const firstData = desktopCommandCreateSpy.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    const secondData = desktopCommandCreateSpy.mock.calls[1][0].data as Record<
      string,
      unknown
    >;

    expect(firstData.requestFingerprint).toBe(secondData.requestFingerprint);
  });
});

// ---------------------------------------------------------------------------
// countCommandsForTarget
// ---------------------------------------------------------------------------

describe("desktopCommandStore.countCommandsForTarget", () => {
  it("returns the count from the database when matching commands exist", async () => {
    desktopCommandCountSpy.mockResolvedValue(3);

    const result = await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Running
    );

    expect(result).toBe(3);
  });

  it("returns 0 when no commands match the given status", async () => {
    desktopCommandCountSpy.mockResolvedValue(0);

    const result = await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Queued
    );

    expect(result).toBe(0);
  });

  it("scopes the query by computeTargetId — passes computeTargetId in the where clause", async () => {
    desktopCommandCountSpy.mockResolvedValue(2);

    await desktopCommandStore.countCommandsForTarget(
      "target-specific",
      DesktopCommandStatus.Accepted
    );

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.computeTargetId).toBe("target-specific");
  });

  it("uses { in: [...] } for the status filter when an array of statuses is provided", async () => {
    desktopCommandCountSpy.mockResolvedValue(5);

    const statuses = [
      DesktopCommandStatus.Accepted,
      DesktopCommandStatus.Running,
    ];

    await desktopCommandStore.countCommandsForTarget("target-1", statuses);

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.status).toEqual({ in: statuses });
  });

  it("uses the raw string for the status filter when a single status is provided", async () => {
    desktopCommandCountSpy.mockResolvedValue(1);

    await desktopCommandStore.countCommandsForTarget(
      "target-1",
      DesktopCommandStatus.Running
    );

    expect(desktopCommandCountSpy).toHaveBeenCalledOnce();
    const { where } = desktopCommandCountSpy.mock.calls[0][0];
    expect(where.status).toBe(DesktopCommandStatus.Running);
  });
});

// ---------------------------------------------------------------------------
// T-3.1: markCommandExpired — emitQueueMetric for dropped_expired_work_items
// ---------------------------------------------------------------------------

describe("desktopCommandStore.markCommandExpired", () => {
  beforeEach(() => {
    desktopCommandStore.__resetForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits dropped_expired_work_items with count field (not value) when updateMany returns count > 0", async () => {
    const expiredCount = 3;
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: expiredCount });

    await desktopCommandStore.markCommandExpired("cmd-123", "timed out");

    const droppedCall = mockEmitQueueMetric.mock.calls.find(
      (call) => call[0]?.metric === "dropped_expired_work_items"
    );

    expect(droppedCall).toBeDefined();
    const droppedArg = droppedCall?.[0];
    expect(droppedArg).toMatchObject({
      metric: "dropped_expired_work_items",
      count: expiredCount,
    });
    expect(droppedArg?.count).toBe(expiredCount);
    expect(droppedArg?.value).toBeUndefined();
  });

  it("emits dropped_expired_work_items with correct count matching updateMany result", async () => {
    const expiredCount = 1;
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: expiredCount });

    await desktopCommandStore.markCommandExpired("cmd-456");

    const droppedCall = mockEmitQueueMetric.mock.calls.find(
      (call) => call[0]?.metric === "dropped_expired_work_items"
    );

    expect(droppedCall).toBeDefined();
    expect(droppedCall?.[0]?.count).toBe(expiredCount);
    expect(droppedCall?.[0]?.value).toBeUndefined();
  });

  it("does NOT emit dropped_expired_work_items when updateMany returns count === 0", async () => {
    // count === 0 means the command was already in a terminal state —
    // no transition occurred, so the metric should be skipped entirely.
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: 0 });

    await desktopCommandStore.markCommandExpired("cmd-789", "expired by cron");

    const droppedCall = mockEmitQueueMetric.mock.calls.find(
      (call) => call[0]?.metric === "dropped_expired_work_items"
    );

    expect(droppedCall).toBeUndefined();
  });

  it("also does NOT emit command_state_transition when count === 0", async () => {
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: 0 });

    await desktopCommandStore.markCommandExpired("cmd-000");

    expect(mockEmitQueueMetric).not.toHaveBeenCalled();
  });

  it("catches emitQueueMetric throw at dropped_expired_work_items site and completes without throw", async () => {
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: 2 });

    mockEmitQueueMetric
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });

    await expect(
      desktopCommandStore.markCommandExpired("cmd-safe-emit")
    ).resolves.not.toThrow();
  });

  it("emits computeTargetId in dropped_expired_work_items when context includes it", async () => {
    desktopCommandUpdateManySpy.mockResolvedValueOnce({ count: 2 });
    const context = {
      computeTargetId: "target-99",
      gatewaySessionId: "session-1",
      schemaVersion: "1.0",
    };

    await desktopCommandStore.markCommandExpired("cmd-ctx", undefined, context);

    const droppedCall = mockEmitQueueMetric.mock.calls.find(
      (call) => call[0]?.metric === "dropped_expired_work_items"
    );

    expect(droppedCall?.[0]).toMatchObject({
      metric: "dropped_expired_work_items",
      count: 2,
      computeTargetId: "target-99",
    });
  });
});

// ---------------------------------------------------------------------------
// T-3.2: ingestCommandEvent — emitProtocolMetric for event_ordering_gaps
// ---------------------------------------------------------------------------

describe("desktopCommandStore.ingestCommandEvent", () => {
  // A minimal StoredCommandRow-shaped object returned by withDb.tx's findUnique/findFirst.
  function makeCommandRow(
    lastSequenceAcked: number,
    computeTargetId = "target-1"
  ) {
    return {
      id: "cmd-seq-1",
      computeTargetId,
      operationId: "op-1",
      status: "running",
      requestPayload: {
        operationId: "op-1",
        method: "POST",
        path: "/api/gateway",
      },
      error: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      startedAt: new Date("2024-01-01T00:00:01Z"),
      finishedAt: null,
      lastSequenceAcked,
      idempotencyKey: null,
      requestFingerprint: "fp-1",
    };
  }

  beforeEach(() => {
    desktopCommandStore.__resetForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits event_ordering_gaps with value equal to gap delta when sequence > expected", async () => {
    const lastSequenceAcked = 2;
    const inputSequence = 5;
    const expectedSequence = lastSequenceAcked + 1; // 3
    const gapDelta = inputSequence - expectedSequence; // 2

    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        desktopCommand: {
          findUnique: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          findFirst: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          update: vi.fn(),
        },
        desktopCommandEvent: {
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    const result = await desktopCommandStore.ingestCommandEvent({
      commandId: "cmd-seq-1",
      eventType: "chunk",
      data: { text: "hello" },
      sequence: inputSequence,
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: "sequence_gap",
      expected: expectedSequence,
    });

    const gapCall = mockEmitProtocolMetric.mock.calls.find(
      (call) => call[0]?.metric === "event_ordering_gaps"
    );

    expect(gapCall).toBeDefined();
    expect(gapCall?.[0]).toMatchObject({
      metric: "event_ordering_gaps",
      value: gapDelta,
    });
    expect(gapCall?.[0]?.value).toBe(gapDelta);
  });

  it("emits event_ordering_gaps metric for sequence gap", async () => {
    const lastSequenceAcked = 0;
    const inputSequence = 3;

    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        desktopCommand: {
          findUnique: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          findFirst: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          update: vi.fn(),
        },
        desktopCommandEvent: {
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    await desktopCommandStore.ingestCommandEvent({
      commandId: "cmd-seq-1",
      eventType: "chunk",
      data: null,
      sequence: inputSequence,
    });

    const gapCall = mockEmitProtocolMetric.mock.calls.find(
      (call) => call[0]?.metric === "event_ordering_gaps"
    );
    expect(gapCall).toBeDefined();
  });

  it("includes computeTargetId in event_ordering_gaps metric when input has it", async () => {
    const lastSequenceAcked = 1;
    const inputSequence = 4;
    const computeTargetId = "target-gap-test";
    const expectedSequence = lastSequenceAcked + 1; // 2
    const gapDelta = inputSequence - expectedSequence; // 2

    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        desktopCommand: {
          findUnique: vi
            .fn()
            .mockResolvedValue(
              makeCommandRow(lastSequenceAcked, computeTargetId)
            ),
          findFirst: vi
            .fn()
            .mockResolvedValue(
              makeCommandRow(lastSequenceAcked, computeTargetId)
            ),
          update: vi.fn(),
        },
        desktopCommandEvent: {
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    await desktopCommandStore.ingestCommandEvent({
      commandId: "cmd-seq-1",
      eventType: "chunk",
      data: null,
      sequence: inputSequence,
      computeTargetId,
    });

    const gapCall = mockEmitProtocolMetric.mock.calls.find(
      (call) => call[0]?.metric === "event_ordering_gaps"
    );

    expect(gapCall?.[0]).toMatchObject({
      metric: "event_ordering_gaps",
      value: gapDelta,
      computeTargetId,
    });
  });

  it("catches emitProtocolMetric throw at event_ordering_gaps site and completes without throw", async () => {
    const lastSequenceAcked = 1;
    const inputSequence = 5;

    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        desktopCommand: {
          findUnique: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          findFirst: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          update: vi.fn(),
        },
        desktopCommandEvent: {
          create: vi.fn(),
        },
      };
      return fn(tx);
    });

    mockEmitProtocolMetric.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(
      desktopCommandStore.ingestCommandEvent({
        commandId: "cmd-seq-1",
        eventType: "chunk",
        data: null,
        sequence: inputSequence,
      })
    ).resolves.not.toThrow();
  });

  it("does NOT emit event_ordering_gaps when sequence equals expected (no gap)", async () => {
    const lastSequenceAcked = 2;
    const inputSequence = lastSequenceAcked + 1; // exactly expected — no gap

    mockWithDbTx.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        desktopCommand: {
          findUnique: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          findFirst: vi
            .fn()
            .mockResolvedValue(makeCommandRow(lastSequenceAcked)),
          update: vi.fn().mockResolvedValue({}),
        },
        desktopCommandEvent: {
          create: vi.fn().mockResolvedValue({ createdAt: new Date() }),
        },
      };
      return fn(tx);
    });

    await desktopCommandStore.ingestCommandEvent({
      commandId: "cmd-seq-1",
      eventType: "chunk",
      data: null,
      sequence: inputSequence,
    });

    const gapCall = mockEmitProtocolMetric.mock.calls.find(
      (call) => call[0]?.metric === "event_ordering_gaps"
    );
    expect(gapCall).toBeUndefined();
  });
});
