import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSessionLimits,
  SESSION_LIMIT_STALE_AFTER_MS,
  SessionLimitSnapshotSource,
  SessionLimitsSnapshotStore,
  type StoredSessionLimitSnapshot,
} from "../src/main/session-limits/snapshot-store.js";
import {
  registerSessionLimitsIpcHandlers,
  type SessionLimitsIpcDeps,
} from "../src/main/session-limits-ipc.js";
import type { SessionLimitsSnapshot } from "../src/shared/session-limits-channel.js";

const NOW = 1_784_646_000_000; // fixed "now" in epoch ms.

function snapshot(
  utilization: number,
  fetchedAtMs: number
): SessionLimitsSnapshot {
  return {
    fiveHour: { utilization, resetsAt: null },
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    extraUsage: null,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
}

function stored(
  source: SessionLimitSnapshotSource,
  utilization: number,
  fetchedAtMs: number
): StoredSessionLimitSnapshot {
  return { source, fetchedAtMs, limits: snapshot(utilization, fetchedAtMs) };
}

test("resolveSessionLimits: null when there are no snapshots", () => {
  assert.equal(resolveSessionLimits([], NOW), null);
});

test("resolveSessionLimits: prefers the fresh RICH statusline sample", () => {
  const resolved = resolveSessionLimits(
    [
      stored(SessionLimitSnapshotSource.RateLimitEvent, 100, NOW - 1000),
      stored(SessionLimitSnapshotSource.Statusline, 42, NOW - 2000),
    ],
    NOW
  );
  // RICH wins on richness even though the COARSE sample is fresher.
  assert.equal(resolved?.fiveHour?.utilization, 42);
  // The winning sample's provenance is stamped onto the rendered snapshot.
  assert.equal(resolved?.source, SessionLimitSnapshotSource.Statusline);
});

test("resolveSessionLimits: stamps the COARSE source when RICH is stale", () => {
  const resolved = resolveSessionLimits(
    [
      stored(
        SessionLimitSnapshotSource.Statusline,
        42,
        NOW - SESSION_LIMIT_STALE_AFTER_MS - 1
      ),
      stored(SessionLimitSnapshotSource.RateLimitEvent, 100, NOW - 1000),
    ],
    NOW
  );
  assert.equal(resolved?.fiveHour?.utilization, 100);
  assert.equal(resolved?.source, SessionLimitSnapshotSource.RateLimitEvent);
});

test("resolveSessionLimits: uses freshest RICH sample among several", () => {
  const resolved = resolveSessionLimits(
    [
      stored(SessionLimitSnapshotSource.Statusline, 30, NOW - 5000),
      stored(SessionLimitSnapshotSource.Statusline, 55, NOW - 1000),
    ],
    NOW
  );
  assert.equal(resolved?.fiveHour?.utilization, 55);
});

test("resolveSessionLimits: falls back to COARSE when RICH is stale", () => {
  const resolved = resolveSessionLimits(
    [
      stored(
        SessionLimitSnapshotSource.Statusline,
        42,
        NOW - SESSION_LIMIT_STALE_AFTER_MS - 1
      ),
      stored(SessionLimitSnapshotSource.RateLimitEvent, 100, NOW - 1000),
    ],
    NOW
  );
  assert.equal(resolved?.fiveHour?.utilization, 100);
});

test("resolveSessionLimits: returns null when every sample is stale", () => {
  const staleOld = NOW - SESSION_LIMIT_STALE_AFTER_MS - 10_000;
  const staleNew = NOW - SESSION_LIMIT_STALE_AFTER_MS - 1000;
  const resolved = resolveSessionLimits(
    [
      stored(SessionLimitSnapshotSource.Statusline, 42, staleOld),
      stored(SessionLimitSnapshotSource.RateLimitEvent, 100, staleNew),
    ],
    NOW
  );
  // Nothing fresh, and the renderer can't yet display staleness → hide the UI
  // rather than surfacing an old snapshot as if it were current.
  assert.equal(resolved, null);
});

test("SessionLimitsSnapshotStore: keeps only the freshest per source", () => {
  const store = new SessionLimitsSnapshotStore();
  store.record(stored(SessionLimitSnapshotSource.Statusline, 30, NOW - 5000));
  store.record(stored(SessionLimitSnapshotSource.Statusline, 55, NOW - 1000));
  // Out-of-order older sample must not clobber the fresher one.
  store.record(stored(SessionLimitSnapshotSource.Statusline, 10, NOW - 9000));
  assert.equal(store.resolve(NOW)?.fiveHour?.utilization, 55);
});

test("SessionLimitsSnapshotStore: resolve is null before any record; clear resets", () => {
  const store = new SessionLimitsSnapshotStore();
  assert.equal(store.resolve(NOW), null);
  store.record(stored(SessionLimitSnapshotSource.RateLimitEvent, 100, NOW));
  assert.equal(store.resolve(NOW)?.fiveHour?.utilization, 100);
  store.clear();
  assert.equal(store.resolve(NOW), null);
});

type IpcHandler = (event: { sender?: unknown }) => unknown;

function registerHandler(deps: SessionLimitsIpcDeps): IpcHandler {
  const handlers = new Map<string, IpcHandler>();
  registerSessionLimitsIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    deps
  );
  const handler = handlers.get("desktop:get-session-limits");
  if (!handler) {
    throw new Error("session-limits Get handler was not registered");
  }
  return handler;
}

test("IPC: exposes the reconciled store snapshot to trusted senders", async () => {
  const store = new SessionLimitsSnapshotStore();
  store.record(stored(SessionLimitSnapshotSource.Statusline, 42, NOW - 1000));
  const handler = registerHandler({
    isTrustedSender: () => true,
    isGoldenMode: () => false,
    snapshotStore: store,
    now: () => NOW,
  });
  const result = (await handler({
    sender: {},
  })) as SessionLimitsSnapshot | null;
  assert.equal(result?.fiveHour?.utilization, 42);
  // The reconciled snapshot reaches the renderer stamped with its source.
  assert.equal(result?.source, SessionLimitSnapshotSource.Statusline);
});

test("IPC: untrusted sender gets null without reading the store", async () => {
  const store = new SessionLimitsSnapshotStore();
  store.record(stored(SessionLimitSnapshotSource.Statusline, 42, NOW));
  const handler = registerHandler({
    isTrustedSender: () => false,
    isGoldenMode: () => false,
    snapshotStore: store,
    now: () => NOW,
  });
  assert.equal(await handler({ sender: "evil" }), null);
});

test("IPC: empty store falls back to the CLI path (null today)", async () => {
  const handler = registerHandler({
    isTrustedSender: () => true,
    isGoldenMode: () => false,
    snapshotStore: new SessionLimitsSnapshotStore(),
    now: () => NOW,
  });
  assert.equal(await handler({ sender: {} }), null);
});
