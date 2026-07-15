import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import {
  emitProtocolMetric,
  emitQueueMetric,
  type ProtocolMetric,
} from "@repo/observability/telemetry/metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("replays only result events after the reconnect cursor", () => {
    const operationId = "op-cursor";
    const events = [
      { operationId, event: { content: "a" }, sequence: 1 },
      { operationId, event: { content: "b" }, sequence: 2 },
      { operationId, result: { status: "ok" }, done: true, sequence: 3 },
    ];
    for (const event of events) {
      relayEventBus.publishResult(operationId, event);
    }

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeResults(
      operationId,
      (event) => {
        received.push(event);
      },
      { afterSequence: 2 }
    );

    // Sequences 1 and 2 were already processed by the client; only 3 replays.
    expect(received).toEqual([events[2]]);
    unsubscribe();
  });

  it("replays events without a sequence even when a cursor is set", () => {
    const operationId = "op-cursor-no-seq";
    const withSeq = { operationId, event: { content: "seen" }, sequence: 1 };
    const withoutSeq = { operationId, event: { content: "new" } };

    relayEventBus.publishResult(operationId, withSeq);
    relayEventBus.publishResult(operationId, withoutSeq);

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeResults(
      operationId,
      (event) => {
        received.push(event);
      },
      { afterSequence: 1 }
    );

    // The sequenced event is suppressed; the unsequenced one arrived after it
    // (past the cursor position) and is still delivered.
    expect(received).toEqual([withoutSeq]);
    unsubscribe();
  });

  it("suppresses unsequenced events streamed before the reconnect cursor", () => {
    const operationId = "op-cursor-no-seq-before";
    const before = { operationId, event: { content: "before" } };
    const acked = { operationId, event: { content: "acked" }, sequence: 2 };
    const after = { operationId, event: { content: "after" } };

    relayEventBus.publishResult(operationId, before);
    relayEventBus.publishResult(operationId, acked);
    relayEventBus.publishResult(operationId, after);

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeResults(
      operationId,
      (event) => {
        received.push(event);
      },
      { afterSequence: 2 }
    );

    // `before` was streamed before the acknowledged sequence 2, so it must not
    // be redelivered; only the unsequenced event after the cursor replays.
    expect(received).toEqual([after]);
    unsubscribe();
  });

  it("suppresses unsequenced events before the cursor when the anchoring sequenced event was shifted off", () => {
    // Simulate a backlog that has been trimmed by shift(): the client last saw
    // sequence 3 but those early sequenced events are no longer in the backlog.
    // Unsequenced events that arrived before sequence 4 must not be replayed.
    const operationId = "op-cursor-shifted";
    // seq 1-3 have been shifted off; the surviving backlog starts here:
    const earlyUnsequenced = {
      operationId,
      event: { content: "early-no-seq" },
    };
    const seq4 = { operationId, event: { content: "d" }, sequence: 4 };
    const lateUnsequenced = { operationId, event: { content: "late-no-seq" } };
    const seq5 = { operationId, event: { content: "e" }, sequence: 5 };

    relayEventBus.publishResult(operationId, earlyUnsequenced);
    relayEventBus.publishResult(operationId, seq4);
    relayEventBus.publishResult(operationId, lateUnsequenced);
    relayEventBus.publishResult(operationId, seq5);

    const received: unknown[] = [];
    const unsubscribe = relayEventBus.subscribeResults(
      operationId,
      (event) => {
        received.push(event);
      },
      { afterSequence: 3 }
    );

    // earlyUnsequenced was delivered before seq 4 (the first new-sequence event),
    // so it must be suppressed even though seq 1-3 are gone from the backlog.
    // seq4, lateUnsequenced, and seq5 are all past the cursor and must replay.
    expect(received).toEqual([seq4, lateUnsequenced, seq5]);
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
        filterToken: FilterToken.CommandReplay,
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
