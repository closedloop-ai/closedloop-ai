/**
 * ISS-11283: branch coverage for `AgentSessionSyncService` edges the focused
 * suites do not reach — the start/refresh/notify/inject lifecycle guards, a
 * source that disappears after the pass captured it (outbox + cursor writers
 * resolve the live source), a stop or source reset that races the payload
 * prepare or the source close, and a chunked session dead-lettered on its
 * first chunk. Drives the real service over the shared in-memory
 * `FakeSyncSource`; only the transport and the payload-prep worker boundary
 * are replaced.
 */
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { inProcessAgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-sync-payload.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import {
  type AgentSessionSyncSource,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { settle } from "./agent-session-sync-service-fixture.js";
import {
  flushAgentSessionSync,
  makeOversizedSession,
  pumpSyncDrainTurn,
} from "./agent-session-sync-service-fixtures.js";
import { deferred } from "./deferred.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const TARGET = "target-iss11283-session";
const UPDATED_AT = "2026-06-08T12:05:00.000Z";
const STALE_SOURCE_MESSAGE =
  "skipping agent-session sync batch from a stale dashboard source";

type SendBatch = AgentSessionSyncServiceOptions["sendBatch"];

const services: AgentSessionSyncService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) {
    service.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function acceptAll(): Mock<SendBatch> {
  return vi.fn<SendBatch>((batch: AgentSessionSyncTransportPayload) =>
    Promise.resolve<DesktopAgentSessionsAck>({
      accepted: true,
      acceptedSessionIds: batch.sessions.map((s) => s.externalSessionId),
    })
  );
}

function makeTrackedService(
  overrides: Partial<AgentSessionSyncServiceOptions> &
    Pick<AgentSessionSyncServiceOptions, "sendBatch">
): AgentSessionSyncService {
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSyncComputeTargetId: () => TARGET,
    ...overrides,
  });
  services.push(service);
  return service;
}

function passTraceCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) =>
    String(call[1]).startsWith("pass trace:")
  ).length;
}

function loggedMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[1]));
}

describe("AgentSessionSyncService lifecycle guards", () => {
  it("ignores a second start() once started", async () => {
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    // Every admitted pass waits for a background slot first, so this counts
    // passes — including the idle ones the pass trace does not log.
    const waitForBackgroundSlot = vi.fn(() => Promise.resolve());
    const service = makeTrackedService({
      getSource: () => source,
      sendBatch,
      waitForBackgroundSlot,
    });

    service.start();
    await settle(service);
    expect(waitForBackgroundSlot).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledTimes(1);

    service.start();
    await settle(service);

    expect(waitForBackgroundSlot).toHaveBeenCalledTimes(1);
    expect(source.listUpdatedCursorCalls).toHaveLength(1);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("does nothing on refresh() before start()", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const info = vi.spyOn(gatewayLog, "info");
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    const service = makeTrackedService({ getSource: () => source, sendBatch });

    service.refresh();
    await flushAgentSessionSync();
    await settle(service);

    expect(source.loadSyncedSessionIds).toEqual([]);
    expect(source.listAllCursorCallCount).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(passTraceCount(info)).toBe(0);
  });

  it("runs a pass on a work-arrival signal once an ack proved the lane, even with the transport flag down", async () => {
    const info = vi.spyOn(gatewayLog, "info");
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    let ready = true;
    const service = makeTrackedService({
      isHttpReady: () => ready,
      getSource: () => source,
      sendBatch,
    });
    service.start();
    await settle(service);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    ready = false;
    source.upsert(makeSyncedSession("s-2", "2026-06-08T12:06:00.000Z"));
    const passesBefore = passTraceCount(info);

    service.notifyLocalSessionActivity();
    await pumpSyncDrainTurn();
    await settle(service);

    expect(passTraceCount(info)).toBeGreaterThan(passesBefore);
  });

  it("nudges a pass that sends injected ids when the lane may run", async () => {
    const source = new FakeSyncSource([]);
    const sendBatch = acceptAll();
    const service = makeTrackedService({ getSource: () => source, sendBatch });
    service.start();
    await settle(service);
    source.upsert(makeSyncedSession("late-1", UPDATED_AT));

    service.injectBackfillIds(
      ["late-1"],
      buildAgentSessionSyncSourceKey(TARGET)
    );
    await settle(service);

    expect(
      sendBatch.mock.calls.flatMap(([batch]) =>
        batch.sessions.map((s) => s.externalSessionId)
      )
    ).toEqual(["late-1"]);
  });

  it("drops a work-arrival signal on a stopped service without arming a timer", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const service = makeTrackedService({
      getSource: () => source,
      sendBatch: acceptAll(),
    });

    service.notifyLocalSessionActivity();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a work-arrival signal while the transport is down and no ack has landed", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    const service = makeTrackedService({
      isHttpReady: () => false,
      getSource: () => source,
      sendBatch,
    });
    service.start();
    expect(vi.getTimerCount()).toBe(0);

    service.notifyLocalSessionActivity();
    await flushAgentSessionSync();

    expect(vi.getTimerCount()).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("queues injected ids without nudging a pass when the lane may not run", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const info = vi.spyOn(gatewayLog, "info");
    const source = new FakeSyncSource([]);
    const sendBatch = acceptAll();
    let ready = true;
    const service = makeTrackedService({
      isHttpReady: () => ready,
      getSource: () => source,
      sendBatch,
    });
    service.start();
    await settle(service);
    ready = false;
    service.refresh();
    expect(vi.getTimerCount()).toBe(0);
    source.upsert(makeSyncedSession("late-1", UPDATED_AT));

    service.injectBackfillIds(
      ["late-1"],
      buildAgentSessionSyncSourceKey(TARGET)
    );
    await flushAgentSessionSync();

    expect(loggedMessages(info)).toContain(
      "injected 1 session(s) into the live backfill queue"
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe("AgentSessionSyncService live source resolution", () => {
  it("writes the outbox and the cursor through the live source", async () => {
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const enqueue = vi.spyOn(source, "enqueueOutboxEntries");
    const clear = vi.spyOn(source, "clearOutboxEntries");
    const service = makeTrackedService({
      getSource: () => source,
      sendBatch: acceptAll(),
    });

    service.start();
    await settle(service);

    expect(enqueue).toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0]?.[0]).toBe(
      buildAgentSessionSyncSourceKey(TARGET)
    );
    expect(source.advanceCalls.length).toBeGreaterThan(0);
  });

  it("skips outbox and cursor writes when the source is gone after the pass captured it", async () => {
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const enqueue = vi.spyOn(source, "enqueueOutboxEntries");
    const clear = vi.spyOn(source, "clearOutboxEntries");
    const sendBatch = acceptAll();
    let getSourceCalls = 0;
    const service = makeTrackedService({
      getSource: () => {
        getSourceCalls += 1;
        return getSourceCalls === 1 ? source : null;
      },
      sendBatch,
    });

    service.start();
    await settle(service);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(source.advanceCalls).toEqual([]);
    expect(service.readCursorBoundary()).toBeNull();
  });

  it("dead-letters a throwing send under the key the pass hydrated, not a target switched mid-send", async () => {
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const deadLetter = vi.spyOn(source, "markOutboxDeadLettered");
    let target = TARGET;
    const service = makeTrackedService({
      getSource: () => source,
      getSyncComputeTargetId: () => target,
      sendBatch: vi.fn<SendBatch>(() => {
        target = "target-iss11283-switched";
        return Promise.reject(
          new TypeError("Do not know how to serialize a BigInt")
        );
      }),
    });

    service.start();
    await settle(service);

    expect(deadLetter).toHaveBeenCalled();
    expect(deadLetter.mock.calls[0]?.[0]).toBe(
      buildAgentSessionSyncSourceKey(TARGET)
    );
  });

  it("reads no cursor boundary when no source getter is wired", () => {
    const service = makeTrackedService({ sendBatch: acceptAll() });

    expect(service.readCursorBoundary()).toBeNull();
  });
});

describe("AgentSessionSyncService stale source mid-pass", () => {
  it("abandons the pass without sending when stop() races the payload prepare", async () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    const prepareEntered = deferred();
    const gate = deferred();
    const preparePayloads: AgentSessionPayloadPreparer = async (...args) => {
      prepareEntered.resolve();
      await gate.promise;
      return await inProcessAgentSessionPayloadPreparer(...args);
    };
    const service = makeTrackedService({
      getSource: () => source,
      sendBatch,
      preparePayloads,
    });

    service.start();
    await prepareEntered.promise;
    service.stop();
    gate.resolve();
    await settle(service);

    expect(sendBatch).not.toHaveBeenCalled();
    expect(loggedMessages(debug)).not.toContain(STALE_SOURCE_MESSAGE);
  });

  it("skips the built batch when a source reset lands during the source close", async () => {
    const debug = vi.spyOn(gatewayLog, "debug");
    const sendBatch = acceptAll();
    let service: AgentSessionSyncService | null = null;
    let closes = 0;
    const source: AgentSessionSyncSource = Object.assign(
      new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]),
      {
        close: () => {
          closes += 1;
          if (closes === 1) {
            service?.resetSourceState();
          }
        },
      }
    );
    service = makeTrackedService({ getSource: () => source, sendBatch });

    service.start();
    await settle(service);

    expect(closes).toBe(1);
    expect(loggedMessages(debug)).toContain(STALE_SOURCE_MESSAGE);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe("AgentSessionSyncService chunked session dead-letter", () => {
  it("dead-letters a session whose payload prep fails deterministically while no chunk tail is pinned", async () => {
    const warn = vi.spyOn(gatewayLog, "warn");
    const source = new FakeSyncSource([makeSyncedSession("s-1", UPDATED_AT)]);
    const sendBatch = acceptAll();
    const preparePayloads: AgentSessionPayloadPreparer = () =>
      Promise.reject(new TypeError("Do not know how to serialize a BigInt"));
    const service = makeTrackedService({
      getSource: () => source,
      sendBatch,
      preparePayloads,
    });

    service.start();
    await settle(service);

    expect(sendBatch).not.toHaveBeenCalled();
    expect(service.getSyncProgress().deadLetteredSessions).toBe(1);
    expect(
      warn.mock.calls.filter((call) =>
        String(call[1]).startsWith("sync failed:")
      )
    ).toEqual([]);
  });

  it("discards the pending chunk tail when the first chunk's send dead-letters the session", async () => {
    const source = new FakeSyncSource([makeOversizedSession("big-1")]);
    const sendBatch = vi.fn<SendBatch>(() =>
      Promise.reject(new TypeError("Do not know how to serialize a BigInt"))
    );
    const service = makeTrackedService({ getSource: () => source, sendBatch });

    service.start();
    await settle(service);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const firstChunk = sendBatch.mock.calls[0]?.[0].sessions[0]?.chunk;
    expect(firstChunk?.index).toBe(0);
    expect(firstChunk?.total ?? 0).toBeGreaterThan(1);

    expect(service.getSyncProgress().deadLetteredSessions).toBe(1);

    service.refresh();
    await settle(service);

    // The idle revisit re-prepares big-1 from a fresh chunk 0; the discarded
    // tail (index 1) is never sent.
    const laterChunks = sendBatch.mock.calls
      .slice(1)
      .map(([batch]) => batch.sessions[0]?.chunk?.index);
    expect(laterChunks.length).toBeGreaterThan(0);
    expect(laterChunks.every((index) => index === 0)).toBe(true);
  });
});

describe("AgentSessionSyncService foreign-owned withhold parking", () => {
  const identity = { organizationId: "org-a", userId: "user-a" };
  const emptyAdoption = {
    adoptedIds: [],
    declined: 0,
    skippedAlreadyLive: 0,
    retiredSourceKeys: 0,
    parkedRows: 0,
  };

  function foreignSource(): {
    source: AgentSessionSyncSource;
    adopt: ReturnType<typeof vi.fn>;
  } {
    const adopt = vi.fn(() => Promise.resolve(emptyAdoption));
    const source = Object.assign(
      new FakeSyncSource([
        {
          ...makeSyncedSession("foreign-1", UPDATED_AT),
          organizationId: "org-b",
          userId: "user-b",
        },
      ]),
      { adoptOutboxRowsFromRetiredComputeTargets: adopt }
    );
    return { source, adopt };
  }

  it("parks the withheld rows through the live source under the hydrated key", async () => {
    const { source, adopt } = foreignSource();
    const sendBatch = acceptAll();
    const service = makeTrackedService({
      getSource: () => source,
      getSyncIdentity: () => identity,
      sendBatch,
    });

    service.start();
    await settle(service);

    expect(sendBatch).not.toHaveBeenCalled();
    // Once at hydration, once for the withhold's park.
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(adopt).toHaveBeenLastCalledWith(
      buildAgentSessionSyncSourceKey(TARGET),
      identity,
      null
    );
  });

  it("skips the park when the source is gone after the pass captured it", async () => {
    const { source, adopt } = foreignSource();
    const sendBatch = acceptAll();
    let getSourceCalls = 0;
    const service = makeTrackedService({
      getSource: () => {
        getSourceCalls += 1;
        return getSourceCalls === 1 ? source : null;
      },
      getSyncIdentity: () => identity,
      sendBatch,
    });

    service.start();
    await settle(service);

    expect(sendBatch).not.toHaveBeenCalled();
    // Only the hydration sweep, which runs on the pass's captured source.
    expect(adopt).toHaveBeenCalledTimes(1);
  });
});
