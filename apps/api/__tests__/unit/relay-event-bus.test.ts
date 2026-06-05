import { vi } from "vitest";
import { relayEventBus } from "@/lib/relay-event-bus";

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
});
