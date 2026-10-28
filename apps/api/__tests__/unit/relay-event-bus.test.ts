import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayEventBus } from "@/lib/relay-event-bus";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

/**
 * `deliveredToSubscriber` is what the command dispatch reports verbatim
 * (`relay-command-helpers.ts`). Before ISS-7558 it meant only "a subscriber object exists", so an
 * operation a subscriber could not convert was reported as delivered and then sat
 * Queued until it expired. It now means "a subscriber accepted it".
 */
describe("relayEventBus.publishOperation — subscriber acceptance", () => {
  const TARGET_ID = "target-acceptance";
  const operation = {
    operationId: "op-accept",
    operation: "symphony_chat",
    params: { ticketId: "ENG-1" },
    streaming: false,
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    relayEventBus.__resetForTests();
  });

  it("reports NOT delivered when the only subscriber rejects", () => {
    const unsubscribe = relayEventBus.subscribeOperations(
      TARGET_ID,
      () => false
    );

    expect(
      relayEventBus.publishOperation(TARGET_ID, operation).deliveredToSubscriber
    ).toBe(false);

    unsubscribe();
  });

  it("reports delivered when the only subscriber returns undefined", () => {
    // The SSE subscriber (compute-targets/[id]/stream/route.ts) forwards the raw
    // operation and returns nothing. Requiring an explicit `true` would silently
    // reclassify every SSE-only delivery as a failure.
    const unsubscribe = relayEventBus.subscribeOperations(TARGET_ID, () => {
      // intentionally returns undefined, exactly like the SSE subscriber
    });

    expect(
      relayEventBus.publishOperation(TARGET_ID, operation).deliveredToSubscriber
    ).toBe(true);

    unsubscribe();
  });

  it("reports delivered when one subscriber rejects but another accepts", () => {
    const unsubscribeRejecting = relayEventBus.subscribeOperations(
      TARGET_ID,
      () => false
    );
    const unsubscribeAccepting = relayEventBus.subscribeOperations(
      TARGET_ID,
      () => true
    );

    expect(
      relayEventBus.publishOperation(TARGET_ID, operation).deliveredToSubscriber
    ).toBe(true);

    unsubscribeRejecting();
    unsubscribeAccepting();
  });

  it("still reports delivered when a subscriber throws", () => {
    // A throw is AMBIGUOUS -- the emit may have partially written -- so it is not
    // proof of non-delivery. member-pack-install-service.ts documents why
    // terminalizing an ambiguous failure is the duplicate-install hazard. Pinned
    // so a later change cannot quietly reclassify it as proven-not-delivered.
    const unsubscribe = relayEventBus.subscribeOperations(TARGET_ID, () => {
      throw new Error("emit blew up");
    });

    expect(
      relayEventBus.publishOperation(TARGET_ID, operation).deliveredToSubscriber
    ).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      "Failed delivering relay operation",
      expect.objectContaining({ operationId: operation.operationId })
    );

    unsubscribe();
  });

  it("logs a rejection during backlog replay, where the operation is dropped for good", () => {
    // The backlog entry is deleted before replay, so a rejecting subscriber here
    // loses the operation with no other trace.
    expect(
      relayEventBus.publishOperation(TARGET_ID, operation).deliveredToSubscriber
    ).toBe(false);

    const unsubscribe = relayEventBus.subscribeOperations(
      TARGET_ID,
      () => false
    );

    expect(log.error).toHaveBeenCalledWith(
      "Rejected queued relay operation on replay",
      expect.objectContaining({ operationId: operation.operationId })
    );

    unsubscribe();
  });
});

describe("operationBacklog TTL sweep (ISS-7964)", () => {
  const REPLAY_TTL_MS = 10 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    relayEventBus.__resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes stale targets past TTL on the next publishOperation call", () => {
    const makeOp = (id: string) =>
      ({
        operationId: id,
        operation: "symphony_chat",
        params: {},
        streaming: false,
      }) as const;

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    relayEventBus.publishOperation("stale-a", makeOp("op-a"));
    relayEventBus.publishOperation("stale-b", makeOp("op-b"));
    relayEventBus.publishOperation("stale-c", makeOp("op-c"));

    vi.setSystemTime(t0 + REPLAY_TTL_MS + 1);

    relayEventBus.publishOperation("fresh-d", makeOp("op-d"));

    const staleReceived: unknown[] = [];
    const unsubA = relayEventBus.subscribeOperations("stale-a", (op) => {
      staleReceived.push(op);
    });
    const unsubB = relayEventBus.subscribeOperations("stale-b", (op) => {
      staleReceived.push(op);
    });
    const unsubC = relayEventBus.subscribeOperations("stale-c", (op) => {
      staleReceived.push(op);
    });
    expect(staleReceived).toEqual([]);

    const freshReceived: unknown[] = [];
    const unsubD = relayEventBus.subscribeOperations("fresh-d", (op) => {
      freshReceived.push(op);
    });
    expect(freshReceived).toEqual([makeOp("op-d")]);

    unsubA();
    unsubB();
    unsubC();
    unsubD();
  });

  it("prunes stale entries on subscribe even without an intervening publish", () => {
    const makeOp = (id: string) =>
      ({
        operationId: id,
        operation: "symphony_chat",
        params: {},
        streaming: false,
      }) as const;

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    relayEventBus.publishOperation("target-expire", makeOp("op-expire"));

    vi.setSystemTime(t0 + REPLAY_TTL_MS + 1);

    const received: unknown[] = [];
    const unsub = relayEventBus.subscribeOperations("target-expire", (op) => {
      received.push(op);
    });
    expect(received).toEqual([]);

    unsub();
  });

  it("preserves backlog entries inside the TTL window for reconnecting targets", () => {
    const makeOp = (id: string) =>
      ({
        operationId: id,
        operation: "symphony_chat",
        params: {},
        streaming: false,
      }) as const;

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    relayEventBus.publishOperation("target-alive", makeOp("op-alive"));

    vi.setSystemTime(t0 + REPLAY_TTL_MS - 1);

    relayEventBus.publishOperation("target-trigger", makeOp("op-trigger"));

    const received: unknown[] = [];
    const unsub = relayEventBus.subscribeOperations("target-alive", (op) => {
      received.push(op);
    });
    expect(received).toEqual([makeOp("op-alive")]);

    unsub();
  });

  it("refreshes lastUpdatedAt on a repeat publish, so a late operation is not swept against the first timestamp", () => {
    const makeOp = (id: string) =>
      ({
        operationId: id,
        operation: "symphony_chat",
        params: {},
        streaming: false,
      }) as const;

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    relayEventBus.publishOperation("target-refresh", makeOp("op-first"));

    vi.setSystemTime(t0 + REPLAY_TTL_MS - 1);
    relayEventBus.publishOperation("target-refresh", makeOp("op-late"));

    // Past the FIRST operation's expiry but inside the window the second one
    // re-armed. Both must survive: the TTL tracks last write, not first write.
    vi.setSystemTime(t0 + REPLAY_TTL_MS + 1);

    const received: unknown[] = [];
    const unsub = relayEventBus.subscribeOperations("target-refresh", (op) => {
      received.push(op);
    });
    expect(received).toEqual([makeOp("op-first"), makeOp("op-late")]);

    unsub();
  });

  it("sweeps a stale target when the only traffic is a connected-target publish", () => {
    const makeOp = (id: string) =>
      ({
        operationId: id,
        operation: "symphony_chat",
        params: {},
        streaming: false,
      }) as const;

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);

    relayEventBus.publishOperation("offline-a", makeOp("op-a"));
    relayEventBus.publishOperation("offline-b", makeOp("op-b"));
    expect(relayEventBus.__operationBacklogSizeForTests()).toBe(2);

    const connectedReceived: unknown[] = [];
    const unsubConnected = relayEventBus.subscribeOperations(
      "connected-target",
      (op) => {
        connectedReceived.push(op);
      }
    );

    vi.setSystemTime(t0 + REPLAY_TTL_MS + 1);

    // Delivered straight to the handler, so the backlog branch never runs. Only
    // an unconditional sweep evicts the two offline targets here. Asserted on
    // the map itself because every public read path prunes before it reports.
    relayEventBus.publishOperation("connected-target", makeOp("op-live"));

    expect(connectedReceived).toEqual([makeOp("op-live")]);
    expect(relayEventBus.__operationBacklogSizeForTests()).toBe(0);

    unsubConnected();
  });
});
