/**
 * ISS-11283: branch coverage for `ClaudeCodeTelemetrySyncService` lifecycle and
 * gating edges the focused suite does not reach — the interval timer
 * (start/stop idempotence, the default and injected interval), the in-flight
 * tick guard, the pre-drain gate, a tick failure (Error and non-Error), a
 * mid-drain target switch, the status-less and status-bearing deferral log
 * lines, and the partial-source narrowing.
 *
 * Driven against an in-memory store double (the seam the service declares for
 * exactly this). No case inspects the per-session payload the store would
 * persist; only session ids, counters, and the lane's own log lines.
 */
import {
  ClaudeCodeTelemetryDropReason,
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
  type DesktopClaudeCodeDropCounterInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeCodeTelemetrySyncSourceKey,
  type ClaudeCodeTelemetryPendingSession,
  ClaudeCodeTelemetrySyncService,
  type ClaudeCodeTelemetrySyncServiceOptions,
  type ClaudeCodeTelemetrySyncStore,
  resolveClaudeCodeTelemetrySyncStore,
} from "../src/main/agent-sync/claude-code-telemetry-sync-service.js";
import type { DesktopClaudeCodeTelemetryClientResult } from "../src/main/dashboard/desktop-claude-code-telemetry-client.js";
import { deferred } from "./deferred.js";

const TARGET = "target-iss11283-telemetry";
const SOURCE_KEY = buildClaudeCodeTelemetrySyncSourceKey(TARGET);
const OBSERVED_TO = "2026-09-21T00:00:00.000Z";

const DROP_COUNTER: DesktopClaudeCodeDropCounterInput = {
  harness: "claude",
  reason: ClaudeCodeTelemetryDropReason.ReceiverBackpressure,
  droppedCount: "3",
  firstObservedAt: OBSERVED_TO,
  lastObservedAt: OBSERVED_TO,
};

type SendSession = ClaudeCodeTelemetrySyncServiceOptions["sendSession"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingSession(sessionId: string): ClaudeCodeTelemetryPendingSession {
  return {
    sessionId,
    session: {
      externalSessionId: sessionId,
      harness: "claude",
      costEventCount: 1,
      components: [],
    },
    observedTo: OBSERVED_TO,
  };
}

function storeWith(
  pending: ClaudeCodeTelemetryPendingSession[],
  undeliveredCounters = false
): ClaudeCodeTelemetrySyncStore & {
  loadPendingSessions: ReturnType<typeof vi.fn>;
  recordDelivered: ReturnType<typeof vi.fn>;
} {
  return {
    loadPendingSessions: vi.fn(() => Promise.resolve(pending)),
    loadDropCounters: () =>
      Promise.resolve({
        counters: undeliveredCounters ? [DROP_COUNTER] : [],
        undelivered: undeliveredCounters,
      }),
    markDropCountersDelivered: () => Promise.resolve(),
    recordDelivered: vi.fn(() => Promise.resolve()),
    recordRejection: () => Promise.resolve(1),
    recordSessionAbsent: () => Promise.resolve(1),
    recordAbandoned: () => Promise.resolve(),
  };
}

function accepted(sessionId?: string): DesktopClaudeCodeTelemetryClientResult {
  return {
    kind: "ack",
    ack: {
      accepted: true,
      protocolVersion: DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
      ...(sessionId ? { externalSessionId: sessionId } : {}),
    },
  };
}

function serviceWith(
  overrides: Partial<ClaudeCodeTelemetrySyncServiceOptions> &
    Pick<ClaudeCodeTelemetrySyncServiceOptions, "store" | "sendSession">
): { service: ClaudeCodeTelemetrySyncService; logs: string[] } {
  const logs: string[] = [];
  const service = new ClaudeCodeTelemetrySyncService({
    isReady: () => true,
    getComputeTargetId: () => TARGET,
    log: (message) => logs.push(message),
    now: () => Date.parse(OBSERVED_TO),
    ...overrides,
  });
  return { service, logs };
}

describe("ClaudeCodeTelemetrySyncService interval timer", () => {
  it("arms one timer at the injected interval, ignores a second start, and clears it on stop", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const store = storeWith([]);
    const { service } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() => Promise.resolve(accepted())),
      intervalMs: 1234,
    });

    service.start();
    service.start();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1233);
    expect(store.loadPendingSessions).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // The drain reads the page synchronously inside the tick the timer kicks.
    expect(store.loadPendingSessions).toHaveBeenCalledTimes(1);
    expect(store.loadPendingSessions.mock.calls[0]?.[0]).toBe(SOURCE_KEY);

    service.stop();
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without an injected interval, arms one timer that has not fired by 1234ms", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const store = storeWith([]);
    const { service } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() => Promise.resolve(accepted())),
    });

    service.start();
    vi.advanceTimersByTime(1234);

    expect(vi.getTimerCount()).toBe(1);
    expect(store.loadPendingSessions).not.toHaveBeenCalled();
    service.stop();
  });
});

describe("ClaudeCodeTelemetrySyncService tick admission", () => {
  it("admits one tick at a time through refresh()", async () => {
    const gate = deferred();
    const sendEntered = deferred();
    const deliveredOnce = deferred();
    const store = storeWith([pendingSession("s-1")]);
    store.recordDelivered.mockImplementation(() => {
      deliveredOnce.resolve();
      return Promise.resolve();
    });
    const sendSession = vi.fn<SendSession>(async () => {
      sendEntered.resolve();
      await gate.promise;
      return accepted("s-1");
    });
    const { service } = serviceWith({ store: () => store, sendSession });

    service.refresh();
    await sendEntered.promise;
    service.refresh();
    gate.resolve();
    await deliveredOnce.promise;

    expect(store.recordDelivered).toHaveBeenCalledWith(
      SOURCE_KEY,
      "s-1",
      OBSERVED_TO
    );
    expect(store.loadPendingSessions).toHaveBeenCalledTimes(1);
    expect(sendSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "no store", store: null, target: TARGET, ready: true },
    { label: "no compute target", store: "live", target: null, ready: true },
    { label: "a closed gate", store: "live", target: TARGET, ready: false },
  ] as const)(
    "does not read the store when syncOnce finds $label",
    async ({ store: storeMode, target, ready }) => {
      const store = storeWith([pendingSession("s-1")]);
      const sendSession = vi.fn<SendSession>(() =>
        Promise.resolve(accepted("s-1"))
      );
      const { service } = serviceWith({
        store: () => (storeMode === "live" ? store : null),
        getComputeTargetId: () => target,
        isReady: () => ready,
        sendSession,
      });

      await service.syncOnce();

      expect(store.loadPendingSessions).not.toHaveBeenCalled();
      expect(sendSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      label: "an Error",
      thrown: new Error("db-host exited"),
      text: "db-host exited",
    },
    { label: "a non-Error", thrown: "SQLITE_BUSY", text: "SQLITE_BUSY" },
  ])("logs a tick failure carrying $label", async ({ thrown, text }) => {
    const store = storeWith([]);
    store.loadPendingSessions.mockImplementation(() => Promise.reject(thrown));
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() => Promise.resolve(accepted())),
    });

    await service.syncOnce();

    expect(logs).toEqual([`tick failed: ${text}`]);
  });

  it("keeps the watermark owed when the compute target switches during send", async () => {
    let target = TARGET;
    const store = storeWith([pendingSession("s-1"), pendingSession("s-2")]);
    const sendSession = vi.fn<SendSession>((input) => {
      target = "target-other";
      return Promise.resolve(accepted(input.session?.externalSessionId));
    });
    const { service } = serviceWith({
      store: () => store,
      getComputeTargetId: () => target,
      sendSession,
    });

    await service.syncOnce();

    expect(sendSession).toHaveBeenCalledTimes(1);
    expect(sendSession.mock.calls[0]?.[0].session?.externalSessionId).toBe(
      "s-1"
    );
    expect(store.recordDelivered).not.toHaveBeenCalled();

    await service.syncOnce();
    expect(sendSession).toHaveBeenCalledTimes(3);
    expect(store.recordDelivered).toHaveBeenCalledTimes(2);
  });
});

describe("ClaudeCodeTelemetrySyncService deferral log lines", () => {
  it("omits the status on a counters-only deferral whose result carries no status value", async () => {
    const store = storeWith([], true);
    const sendSession = vi.fn<SendSession>(() =>
      Promise.resolve({
        kind: "retry",
        error: "socket hang up",
        status: undefined,
      })
    );
    const { service, logs } = serviceWith({ store: () => store, sendSession });

    await service.syncOnce();

    expect(sendSession).toHaveBeenCalledWith(
      { dropCounters: [DROP_COUNTER] },
      expect.any(Function)
    );
    expect(logs).toEqual([
      "claude code telemetry drop-counter delivery deferred (retry)",
    ]);
  });

  it("names the status on a counters-only deferral and holds the cooldown on the next tick", async () => {
    const store = storeWith([], true);
    const sendSession = vi.fn<SendSession>(() =>
      Promise.resolve({ kind: "rejected", status: 400 })
    );
    const { service, logs } = serviceWith({ store: () => store, sendSession });

    await service.syncOnce();
    await service.syncOnce();

    expect(sendSession).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      "claude code telemetry drop-counter delivery deferred (rejected 400)",
    ]);
  });

  it("marks the counters delivered on an accepted counters-only delivery", async () => {
    const store = storeWith([], true);
    const markDelivered = vi.spyOn(store, "markDropCountersDelivered");
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() => Promise.resolve(accepted())),
    });

    await service.syncOnce();

    expect(markDelivered).toHaveBeenCalledWith([DROP_COUNTER]);
    expect(logs).toEqual([]);
  });

  it("names the status on a lane-wide unavailable deferral", async () => {
    const store = storeWith([pendingSession("s-1")]);
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() =>
        Promise.resolve({ kind: "unavailable", status: 501 })
      ),
    });

    await service.syncOnce();

    expect(logs).toEqual([
      "claude code telemetry sync deferred (unavailable 501)",
    ]);
    expect(store.recordDelivered).not.toHaveBeenCalled();
  });

  it("omits the status on a lane-wide unavailable deferral whose result carries none", async () => {
    const store = storeWith([pendingSession("s-1")]);
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() =>
        Promise.resolve({ kind: "unavailable" })
      ),
    });

    await service.syncOnce();

    expect(logs).toEqual(["claude code telemetry sync deferred (unavailable)"]);
  });

  it("restarts a session's retry tally after it drops off the page", async () => {
    let page = [pendingSession("s-1")];
    const store = storeWith([]);
    store.loadPendingSessions.mockImplementation(() => Promise.resolve(page));
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>((input) =>
        Promise.resolve(
          input.session?.externalSessionId === "s-1"
            ? { kind: "retry", error: "bad gateway", status: 502 }
            : accepted(input.session?.externalSessionId)
        )
      ),
    });

    await service.syncOnce();
    await service.syncOnce();
    page = [pendingSession("s-2")];
    await service.syncOnce();
    page = [pendingSession("s-1")];
    await service.syncOnce();

    expect(logs).toEqual([
      "claude code telemetry sync deferred (retry 502) on s-1, attempt 1",
      "claude code telemetry sync deferred (retry 502) on s-1, attempt 2",
      "claude code telemetry sync deferred (retry 502) on s-1, attempt 1",
    ]);
  });

  it("omits the status on a retry deferral whose result carries none", async () => {
    const store = storeWith([pendingSession("s-1")]);
    const { service, logs } = serviceWith({
      store: () => store,
      sendSession: vi.fn<SendSession>(() =>
        Promise.resolve({ kind: "retry", error: "socket hang up" })
      ),
    });

    await service.syncOnce();

    expect(logs).toEqual([
      "claude code telemetry sync deferred (retry) on s-1, attempt 1",
    ]);
  });
});

describe("resolveClaudeCodeTelemetrySyncStore", () => {
  it("returns null for a source missing any lane method", () => {
    expect(resolveClaudeCodeTelemetrySyncStore(null)).toBeNull();
    expect(
      resolveClaudeCodeTelemetrySyncStore({
        loadClaudeCodeTelemetryPendingSessions: () => Promise.resolve([]),
        loadClaudeCodeTelemetryDropCounters: () =>
          Promise.resolve({ counters: [], undelivered: false }),
        markClaudeCodeTelemetryDropCountersDelivered: () => Promise.resolve(),
        recordClaudeCodeTelemetryDelivered: () => Promise.resolve(),
        recordClaudeCodeTelemetryRejection: () => Promise.resolve(1),
        recordClaudeCodeTelemetrySessionAbsent: () => Promise.resolve(1),
      })
    ).toBeNull();
  });
});

describe("resolveClaudeCodeTelemetrySyncStore forwarding", () => {
  it("forwards every store call and its arguments to a complete source", async () => {
    const pending = [pendingSession("s-1")];
    const snapshot = { counters: [DROP_COUNTER], undelivered: true };
    const source = {
      loadClaudeCodeTelemetryPendingSessions: vi.fn(() =>
        Promise.resolve(pending)
      ),
      loadClaudeCodeTelemetryDropCounters: vi.fn(() =>
        Promise.resolve(snapshot)
      ),
      markClaudeCodeTelemetryDropCountersDelivered: vi.fn(() =>
        Promise.resolve()
      ),
      recordClaudeCodeTelemetryDelivered: vi.fn(() => Promise.resolve()),
      recordClaudeCodeTelemetryRejection: vi.fn(() => Promise.resolve(2)),
      recordClaudeCodeTelemetrySessionAbsent: vi.fn(() => Promise.resolve(3)),
      recordClaudeCodeTelemetryAbandoned: vi.fn(() => Promise.resolve()),
    };
    const store = resolveClaudeCodeTelemetrySyncStore(source);
    if (!store) {
      throw new Error("expected a resolved telemetry store");
    }

    expect(await store.loadPendingSessions(SOURCE_KEY, 4)).toBe(pending);
    expect(await store.loadDropCounters()).toBe(snapshot);
    await store.markDropCountersDelivered([DROP_COUNTER]);
    await store.recordDelivered(SOURCE_KEY, "s-1", OBSERVED_TO);
    expect(await store.recordRejection(SOURCE_KEY, "s-1")).toBe(2);
    expect(await store.recordSessionAbsent(SOURCE_KEY, "s-1")).toBe(3);
    await store.recordAbandoned(SOURCE_KEY, "s-1", OBSERVED_TO, "why");

    expect(source.loadClaudeCodeTelemetryPendingSessions).toHaveBeenCalledWith(
      SOURCE_KEY,
      4
    );
    expect(
      source.markClaudeCodeTelemetryDropCountersDelivered
    ).toHaveBeenCalledWith([DROP_COUNTER]);
    expect(source.recordClaudeCodeTelemetryDelivered).toHaveBeenCalledWith(
      SOURCE_KEY,
      "s-1",
      OBSERVED_TO
    );
    expect(source.recordClaudeCodeTelemetryRejection).toHaveBeenCalledWith(
      SOURCE_KEY,
      "s-1"
    );
    expect(source.recordClaudeCodeTelemetrySessionAbsent).toHaveBeenCalledWith(
      SOURCE_KEY,
      "s-1"
    );
    expect(source.recordClaudeCodeTelemetryAbandoned).toHaveBeenCalledWith(
      SOURCE_KEY,
      "s-1",
      OBSERVED_TO,
      "why"
    );
  });
});

describe("periodic telemetry callback completion", () => {
  it("returns the shared drain through the final store await and admits a new tick after settlement", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cursorDelivered = deferred();
    const countersMarked = deferred();
    const countersEntered = deferred();
    const store = storeWith([pendingSession("s-1")]);
    store.recordDelivered.mockImplementation(() => {
      cursorDelivered.resolve();
      return Promise.resolve();
    });
    store.markDropCountersDelivered = () => {
      countersEntered.resolve();
      return countersMarked.promise;
    };
    const { service } = serviceWith({
      store: () => store,
      sendSession: () => Promise.resolve(accepted("s-1")),
    });
    const timer = vi.spyOn(globalThis, "setInterval");
    try {
      service.start();
      const callback = registeredIntervalCallback(timer.mock.calls[0]?.[0]);
      const completion = callback();
      expect(completion).toBeInstanceOf(Promise);
      await cursorDelivered.promise;
      await countersEntered.promise;
      const completionState = Promise.resolve(completion).then(() => "settled");
      // A native event-loop turn drains promise jobs without releasing the store.
      const eventLoopTurn = new Promise<string>((resolve) => {
        setImmediate(() => resolve("pending"));
      });
      expect(await Promise.race([completionState, eventLoopTurn])).toBe(
        "pending"
      );
      expect(callback()).toBe(completion);
      expect(store.loadPendingSessions).toHaveBeenCalledTimes(1);
      countersMarked.resolve();
      await completion;
      store.loadPendingSessions.mockResolvedValue([]);
      const next = callback();
      expect(next).toBeInstanceOf(Promise);
      expect(next).not.toBe(completion);
      await next;
      expect(store.loadPendingSessions).toHaveBeenCalledTimes(2);
    } finally {
      countersMarked.resolve();
      service.stop();
    }
  });

  it("preserves rejection and clears admission when failure precedes the drain catch", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const failure = new Error("synthetic store admission failure");
    let failAdmission = true;
    const store = storeWith([]);
    const { service } = serviceWith({
      store: () => {
        if (failAdmission) {
          throw failure;
        }
        return store;
      },
      sendSession: () => Promise.resolve(accepted()),
    });
    const timer = vi.spyOn(globalThis, "setInterval");
    try {
      service.start();
      const callback = registeredIntervalCallback(timer.mock.calls[0]?.[0]);
      const failed = callback();
      expect(failed).toBeInstanceOf(Promise);
      await expect(failed).rejects.toBe(failure);
      failAdmission = false;
      const recovered = callback();
      expect(recovered).not.toBe(failed);
      await expect(recovered).resolves.toBeUndefined();
      expect(store.loadPendingSessions).toHaveBeenCalledTimes(1);
    } finally {
      service.stop();
    }
  });
});

function registeredIntervalCallback(value: unknown): () => unknown {
  if (typeof value !== "function") {
    throw new Error("The production start() callback was not registered.");
  }
  return () => value();
}
