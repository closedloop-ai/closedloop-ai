import {
  emitProtocolMetric,
  emitQueueMetric,
  type ProtocolMetric,
} from "@repo/observability/telemetry/metrics";
import { vi } from "vitest";
import { relayEventBus } from "@/lib/relay-event-bus";

type ReplayWindowUsageMetric = ProtocolMetric & {
  metric: "replay_window_usage";
};

const isReplayWindowUsageCall = (
  call: [ProtocolMetric]
): call is [ReplayWindowUsageMetric] =>
  call[0].metric === "replay_window_usage";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitProtocolMetric: vi.fn(),
  emitQueueMetric: vi.fn(),
}));

describe("relayEventBus", () => {
  beforeEach(() => {
    relayEventBus.__resetForTests();
  });

  it("replays queued operations when a target subscriber connects", () => {
    const targetId = "target-queue";
    const operation = {
      operationId: "op-1",
      operation: "symphony_chat",
      params: { ticketId: "ENG-1" },
      streaming: true,
    } as const;

    const publishResult = relayEventBus.publishOperation(targetId, operation);
    expect(publishResult.deliveredToSubscriber).toBe(false);

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeOperations(targetId, (event) => {
      received.push(event);
    });

    expect(received).toEqual([operation]);
    unsubscribe();
  });

  it("replays stored result events for late subscribers", () => {
    const operationId = "op-replay";
    const first = { operationId, event: { type: "text", content: "hi" } };
    const second = { operationId, result: { status: "ok" }, done: true };

    relayEventBus.publishResult(operationId, first);
    relayEventBus.publishResult(operationId, second);

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeResults(operationId, (event) => {
      received.push(event);
    });

    expect(received).toEqual([first, second]);
    unsubscribe();
  });

  it("closes active target connections on demand", () => {
    const targetId = "target-close";
    const onClose = vi.fn();

    const unsubscribe = relayEventBus.subscribeTargetConnection(
      targetId,
      onClose
    );
    relayEventBus.closeTargetConnections(targetId);

    expect(onClose).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  describe("replay_frequency metric via subscribeResults", () => {
    beforeEach(() => {
      vi.mocked(emitQueueMetric).mockClear();
    });

    it("emits replay_frequency with count:1 and value matching the number of replayed events", () => {
      const operationId = "op-replay-freq";
      const eventCount = 3;

      for (let i = 0; i < eventCount; i++) {
        relayEventBus.publishResult(operationId, {
          operationId,
          event: { type: "text", content: `msg-${i}` },
        });
      }

      const received: unknown[] = [];
      const unsubscribe = relayEventBus.subscribeResults(
        operationId,
        (event) => {
          received.push(event);
        }
      );

      const calls = vi
        .mocked(emitQueueMetric)
        .mock.calls.filter(([arg]) => arg.metric === "replay_frequency");

      expect(calls.length).toBe(1);
      expect(calls[0][0]).toMatchObject({
        metric: "replay_frequency",
        count: 1,
        value: eventCount,
      });

      unsubscribe();
    });

    it("emits replay_frequency after the replay for-loop completes (all events delivered before emission)", () => {
      const operationId = "op-replay-order";
      const eventCount = 4;

      for (let i = 0; i < eventCount; i++) {
        relayEventBus.publishResult(operationId, {
          operationId,
          event: { type: "text", content: `msg-${i}` },
        });
      }

      const onEvent = vi.fn();
      const unsubscribe = relayEventBus.subscribeResults(operationId, onEvent);

      // onEvent should have been called eventCount times (all replayed)
      expect(onEvent).toHaveBeenCalledTimes(eventCount);

      // emitQueueMetric should have been called exactly once for replay_frequency
      const queueCalls = vi
        .mocked(emitQueueMetric)
        .mock.calls.filter(([arg]) => arg.metric === "replay_frequency");
      expect(queueCalls.length).toBe(1);

      // Verify ordering: all onEvent invocations come before emitQueueMetric.
      // mock.invocationCallOrder tracks the global call order across all vi.fn() mocks.
      const lastOnEventOrder = Math.max(...onEvent.mock.invocationCallOrder);
      const emitQueueMetricOrder =
        vi.mocked(emitQueueMetric).mock.invocationCallOrder[
          vi.mocked(emitQueueMetric).mock.invocationCallOrder.length - 1
        ];

      expect(lastOnEventOrder).toBeLessThan(emitQueueMetricOrder);

      unsubscribe();
    });

    it("does not emit replay_frequency when there are no queued events", () => {
      const operationId = "op-replay-empty";

      const unsubscribe = relayEventBus.subscribeResults(operationId, vi.fn());

      const calls = vi
        .mocked(emitQueueMetric)
        .mock.calls.filter(([arg]) => arg.metric === "replay_frequency");

      expect(calls.length).toBe(0);

      unsubscribe();
    });

    it("catches emitQueueMetric throw at replay_frequency site and completes without throw", () => {
      const operationId = "op-replay-freq-throw";

      relayEventBus.publishResult(operationId, {
        operationId,
        event: { type: "text", content: "hi" },
      });

      vi.mocked(emitQueueMetric).mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => {
        const unsubscribe = relayEventBus.subscribeResults(
          operationId,
          vi.fn()
        );
        unsubscribe();
      }).not.toThrow();
    });
  });

  describe("replay_window_usage metric via publishResult", () => {
    const MAX_RESULT_EVENTS = 500;

    beforeEach(() => {
      vi.mocked(emitProtocolMetric).mockClear();
    });

    it("emits replay_window_usage with value in [0,1] for an empty-then-one-event backlog", () => {
      const operationId = "op-metric-empty";
      relayEventBus.publishResult(operationId, {
        operationId,
        event: { type: "text", content: "a" },
      });

      const calls = vi
        .mocked(emitProtocolMetric)
        .mock.calls.filter(isReplayWindowUsageCall);
      expect(calls.length).toBeGreaterThan(0);

      for (const [payload] of calls) {
        expect(payload.value).toBeGreaterThanOrEqual(0);
        expect(payload.value).toBeLessThanOrEqual(1);
        expect("operationId" in payload).toBe(false);
      }
    });

    it("emits replay_window_usage with value in [0,1] for a mid-range backlog", () => {
      const operationId = "op-metric-mid";
      const midCount = Math.floor(MAX_RESULT_EVENTS / 2);

      for (let i = 0; i < midCount; i++) {
        relayEventBus.publishResult(operationId, {
          operationId,
          event: { type: "text", content: `msg-${i}` },
        });
      }

      const calls = vi
        .mocked(emitProtocolMetric)
        .mock.calls.filter(isReplayWindowUsageCall);
      expect(calls.length).toBe(midCount);

      const lastCallEntry = calls.at(-1);
      expect(lastCallEntry).toBeDefined();
      const lastCall = lastCallEntry![0];
      expect(lastCall.value).toBeGreaterThanOrEqual(0);
      expect(lastCall.value).toBeLessThanOrEqual(1);
      expect("operationId" in lastCall).toBe(false);
    });

    it("emits replay_window_usage with value in [0,1] when backlog is at MAX_RESULT_EVENTS capacity", () => {
      const operationId = "op-metric-full";

      for (let i = 0; i < MAX_RESULT_EVENTS + 1; i++) {
        relayEventBus.publishResult(operationId, {
          operationId,
          event: { type: "text", content: `msg-${i}` },
        });
      }

      const calls = vi
        .mocked(emitProtocolMetric)
        .mock.calls.filter(isReplayWindowUsageCall);
      expect(calls.length).toBe(MAX_RESULT_EVENTS + 1);

      const lastCallEntry = calls.at(-1);
      expect(lastCallEntry).toBeDefined();
      const lastCall = lastCallEntry![0];
      expect(lastCall.value).toBe(1);
      expect("operationId" in lastCall).toBe(false);
    });

    it("catches emitProtocolMetric throw at replay_window_usage site and completes without throw", () => {
      const operationId = "op-replay-window-throw";

      vi.mocked(emitProtocolMetric).mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => {
        relayEventBus.publishResult(operationId, {
          operationId,
          event: { type: "text", content: "hello" },
        });
      }).not.toThrow();
    });
  });
});
