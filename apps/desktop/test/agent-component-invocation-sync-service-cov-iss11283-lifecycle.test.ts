/**
 * ISS-11283: branch coverage for `AgentComponentInvocationSyncService` edges the
 * focused suites do not reach — the start/refresh/schedule lifecycle guards,
 * the syncOnce single-flight and readiness gates, a rejecting transport (Error
 * and non-Error), and `resolveAgentComponentInvocationSyncSource`'s narrowing
 * and fallbacks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  buildAgentComponentInvocationSyncSourceKey,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  AgentComponentInvocationSyncService,
  type AgentComponentInvocationSyncServiceOptions,
  type AgentComponentInvocationSyncSource,
  resolveAgentComponentInvocationSyncSource,
} from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { flush } from "./agent-session-sync-component-test-utils.js";
import { FakeSyncSource } from "./fake-sync-source.js";
import {
  FakeSource,
  PART_CREATED_AT,
  part,
} from "./helpers/invocation-sync-service-fixtures.js";

const TARGET = "target-1";
const SOURCE_KEY = buildAgentComponentInvocationSyncSourceKey(TARGET);
const NOW = new Date("2026-08-01T00:05:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

function serviceFor(
  source: AgentComponentInvocationSyncSource,
  overrides: Partial<AgentComponentInvocationSyncServiceOptions> = {}
): AgentComponentInvocationSyncService {
  return new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => source,
    getComputeTargetId: () => TARGET,
    sendPart: () => Promise.resolve({ kind: "unavailable", status: 404 }),
    now: () => NOW,
    ...overrides,
  });
}

/** A FakeSource with nothing ready whose prepare parks until released. */
function parkedPrepareSource(): { source: FakeSource; release: () => void } {
  const source = new FakeSource(part());
  source.entries = [];
  let release: () => void = () => undefined;
  source.prepareImpl = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  return { source, release: () => release() };
}

describe("AgentComponentInvocationSyncService lifecycle guards", () => {
  it("does not tick on refresh() before start() even with the gate open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = new FakeSource(part());
    source.entries = [];
    const getSource = vi.fn(() => source);
    const service = serviceFor(source, { getSource });

    service.refresh();
    await flush();

    expect(getSource).not.toHaveBeenCalled();
    expect(source.recoverCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the next tick when the scheduled timer fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = new FakeSource(part());
    source.entries = [];
    const service = serviceFor(source);
    try {
      service.start();
      await flush();
      expect(source.recoverCalls).toBe(1);

      vi.advanceTimersToNextTimer();
      await flush();

      expect(source.recoverCalls).toBe(2);
      expect(source.recoveredSourceKeys).toEqual([SOURCE_KEY, SOURCE_KEY]);
    } finally {
      service.stop();
    }
  });

  it("ignores a second start() while already started", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = new FakeSource(part());
    source.entries = [];
    const service = serviceFor(source);
    try {
      service.start();
      await flush();
      expect(source.recoverCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      service.start();
      await flush();

      expect(source.recoverCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("cancels the scheduled tick when refresh() finds the gate closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = new FakeSource(part());
    source.entries = [];
    let ready = true;
    const service = serviceFor(source, { isReady: () => ready });
    try {
      service.start();
      await flush();
      expect(vi.getTimerCount()).toBe(1);

      ready = false;
      service.refresh();

      expect(vi.getTimerCount()).toBe(0);
      expect(source.recoverCalls).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("does not start a second tick or re-enter syncOnce while a tick is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { source, release } = parkedPrepareSource();
    const waitForBackgroundSlot = vi.fn(() => Promise.resolve());
    const service = serviceFor(source, { waitForBackgroundSlot });
    try {
      service.start();
      await flush();
      expect(source.recoverCalls).toBe(1);
      expect(waitForBackgroundSlot).toHaveBeenCalledTimes(1);

      service.refresh();
      await service.syncOnce();
      await flush();

      expect(source.recoverCalls).toBe(1);
      expect(waitForBackgroundSlot).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      release();
      await flush();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      service.stop();
    }
  });

  it("does not schedule the next tick when stop() lands while a tick is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { source, release } = parkedPrepareSource();
    const service = serviceFor(source);
    service.start();
    await flush();
    expect(source.recoverCalls).toBe(1);

    service.stop();
    release();
    await flush();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns from syncOnce before touching the source when the gate is closed", async () => {
    const source = new FakeSource(part());
    const getSource = vi.fn(() => source);
    const waitForBackgroundSlot = vi.fn(() => Promise.resolve());
    const service = serviceFor(source, {
      isReady: () => false,
      getSource,
      waitForBackgroundSlot,
    });

    await service.syncOnce();

    expect(getSource).not.toHaveBeenCalled();
    expect(waitForBackgroundSlot).not.toHaveBeenCalled();
    expect(source.recoverCalls).toBe(0);
  });
});

describe("AgentComponentInvocationSyncService transport rejection", () => {
  it.each([
    {
      label: "an Error",
      thrown: new Error("socket hang up"),
      text: "socket hang up",
    },
    { label: "a non-Error", thrown: "ECONNRESET", text: "ECONNRESET" },
  ])(
    "records an environmental retry carrying the message when sendPart rejects with $label",
    async ({ thrown, text }) => {
      const source = new FakeSource(part());
      const recordRetry = vi.spyOn(source, "recordInvocationSyncRetry");
      const sendPart = vi.fn(() => Promise.reject(thrown));
      const service = serviceFor(source, { sendPart });

      await service.syncOnce();

      expect(sendPart).toHaveBeenCalledWith(part(), TARGET);
      expect(recordRetry).toHaveBeenCalledTimes(1);
      const [sourceKey, retried, retry] = recordRetry.mock.calls[0] ?? [];
      expect(sourceKey).toBe(SOURCE_KEY);
      expect(retried).toEqual(part());
      expect(retry).toMatchObject({
        attemptCount: 0,
        permanentAttemptCount: 0,
        error: text,
        laneStalledSince: NOW.toISOString(),
      });
      expect(source.clearCalls).toBe(0);
      expect(source.deadLetterCalls).toBe(0);
    }
  );
});

describe("resolveAgentComponentInvocationSyncSource", () => {
  it("returns null for a missing source or one lacking any invocation method", () => {
    expect(resolveAgentComponentInvocationSyncSource(null)).toBeNull();
    const partial = Object.assign(new FakeSyncSource([]), {
      prepareInvocationSyncTarget: vi.fn(() => Promise.resolve()),
      loadReadyInvocationSyncParts: vi.fn(() => Promise.resolve([])),
      recoverInvocationSyncDeadLetters: vi.fn(() =>
        Promise.resolve({
          recoveredParts: 0,
          cappedParts: 0,
          quarantinedParts: 0,
        })
      ),
      recordInvocationSyncRetry: vi.fn(() => Promise.resolve()),
      clearAcknowledgedInvocationSyncPart: vi.fn(() => Promise.resolve(true)),
    });

    expect(resolveAgentComponentInvocationSyncSource(partial)).toBeNull();
  });

  it("forwards every call and its arguments to the underlying source", async () => {
    const recovery = { recoveredParts: 1, cappedParts: 2, quarantinedParts: 3 };
    const entry = {
      part: part(),
      attemptCount: 1,
      permanentAttemptCount: 0,
      laneStalledSince: null,
      deadLetterRecoveryCount: 0,
      createdAt: PART_CREATED_AT,
    };
    const methods = {
      prepareInvocationSyncTarget: vi.fn(() => Promise.resolve()),
      loadReadyInvocationSyncParts: vi.fn(() => Promise.resolve([entry])),
      recoverInvocationSyncDeadLetters: vi.fn(() => Promise.resolve(recovery)),
      recordInvocationSyncRetry: vi.fn(() => Promise.resolve()),
      clearAcknowledgedInvocationSyncPart: vi.fn(() => Promise.resolve(true)),
      deadLetterInvocationSyncPart: vi.fn(() => Promise.resolve(true)),
    };
    const resolved = resolveAgentComponentInvocationSyncSource(
      Object.assign(new FakeSyncSource([]), methods)
    );
    if (!resolved) {
      throw new Error("expected a resolved invocation source");
    }
    const identity = { userId: "user-1", organizationId: "org-1" };
    const retry = {
      attemptCount: 1,
      permanentAttemptCount: 0,
      nextAttemptAt: NOW.toISOString(),
      error: "x",
      laneStalledSince: null,
    };
    const ack = {
      externalGenerationId: part().externalGenerationId,
      partIndex: 0,
      partHash: part().partHash,
    };
    const deadLetter = {
      attemptCount: 2,
      permanentAttemptCount: 1,
      error: "y",
    };

    await resolved.prepareInvocationSyncTarget(
      SOURCE_KEY,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      7,
      identity
    );
    expect(
      await resolved.loadReadyInvocationSyncParts(SOURCE_KEY, "t", 4)
    ).toEqual([entry]);
    expect(
      await resolved.recoverInvocationSyncDeadLetters(SOURCE_KEY, "t", 5)
    ).toEqual(recovery);
    await resolved.recordInvocationSyncRetry(SOURCE_KEY, part(), retry);
    expect(
      await resolved.clearAcknowledgedInvocationSyncPart(SOURCE_KEY, ack)
    ).toBe(true);
    expect(
      await resolved.deadLetterInvocationSyncPart(
        SOURCE_KEY,
        part(),
        deadLetter
      )
    ).toBe(true);

    expect(methods.prepareInvocationSyncTarget).toHaveBeenCalledWith(
      SOURCE_KEY,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      7,
      identity
    );
    expect(methods.loadReadyInvocationSyncParts).toHaveBeenCalledWith(
      SOURCE_KEY,
      "t",
      4
    );
    expect(methods.recoverInvocationSyncDeadLetters).toHaveBeenCalledWith(
      SOURCE_KEY,
      "t",
      5
    );
    expect(methods.recordInvocationSyncRetry).toHaveBeenCalledWith(
      SOURCE_KEY,
      part(),
      retry
    );
    expect(methods.clearAcknowledgedInvocationSyncPart).toHaveBeenCalledWith(
      SOURCE_KEY,
      ack
    );
    expect(methods.deadLetterInvocationSyncPart).toHaveBeenCalledWith(
      SOURCE_KEY,
      part(),
      deadLetter
    );
  });

  it("substitutes a safe default when an underlying method yields nothing", async () => {
    // vi.fn() with no implementation returns undefined — a db-host method that
    // resolved to nothing instead of a promise.
    const resolved = resolveAgentComponentInvocationSyncSource(
      Object.assign(new FakeSyncSource([]), {
        prepareInvocationSyncTarget:
          vi.fn<
            NonNullable<
              AgentComponentInvocationSyncSource["prepareInvocationSyncTarget"]
            >
          >(),
        loadReadyInvocationSyncParts:
          vi.fn<
            AgentComponentInvocationSyncSource["loadReadyInvocationSyncParts"]
          >(),
        recoverInvocationSyncDeadLetters:
          vi.fn<
            AgentComponentInvocationSyncSource["recoverInvocationSyncDeadLetters"]
          >(),
        recordInvocationSyncRetry:
          vi.fn<
            AgentComponentInvocationSyncSource["recordInvocationSyncRetry"]
          >(),
        clearAcknowledgedInvocationSyncPart:
          vi.fn<
            AgentComponentInvocationSyncSource["clearAcknowledgedInvocationSyncPart"]
          >(),
        deadLetterInvocationSyncPart:
          vi.fn<
            AgentComponentInvocationSyncSource["deadLetterInvocationSyncPart"]
          >(),
      })
    );
    if (!resolved) {
      throw new Error("expected a resolved invocation source");
    }

    await expect(
      resolved.prepareInvocationSyncTarget(SOURCE_KEY, "template", 1, null)
    ).resolves.toBeUndefined();
    await expect(
      resolved.loadReadyInvocationSyncParts(SOURCE_KEY, "t", 1)
    ).resolves.toEqual([]);
    await expect(
      resolved.recoverInvocationSyncDeadLetters(SOURCE_KEY, "t", 1)
    ).resolves.toEqual({
      recoveredParts: 0,
      cappedParts: 0,
      quarantinedParts: 0,
    });
    await expect(
      resolved.recordInvocationSyncRetry(SOURCE_KEY, part(), {
        attemptCount: 0,
        permanentAttemptCount: 0,
        nextAttemptAt: "t",
        error: "e",
        laneStalledSince: null,
      })
    ).resolves.toBeUndefined();
    await expect(
      resolved.clearAcknowledgedInvocationSyncPart(SOURCE_KEY, {
        externalGenerationId: "g",
        partIndex: 0,
        partHash: "h",
      })
    ).resolves.toBe(false);
    await expect(
      resolved.deadLetterInvocationSyncPart(SOURCE_KEY, part(), {
        attemptCount: 0,
        permanentAttemptCount: 0,
        error: "e",
      })
    ).resolves.toBe(false);
  });
});
