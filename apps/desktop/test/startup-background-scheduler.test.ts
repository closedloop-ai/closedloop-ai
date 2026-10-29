import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS } from "../src/main/dashboard/agent-dashboard-runtime-import-schedule.js";
import { createStartupBackgroundScheduler } from "../src/main/dashboard/startup-background-scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

test("session projection fails open once and wakes its consumers", () => {
  vi.useFakeTimers();
  let refreshes = 0;
  const scheduler = createStartupBackgroundScheduler({
    isClosed: () => false,
    log: () => undefined,
    onSessionProjectionReady: () => {
      refreshes++;
    },
  });

  vi.advanceTimersByTime(STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS - 1);
  assert.equal(scheduler.isSessionProjectionSettled(), false);
  assert.equal(refreshes, 0);

  vi.advanceTimersByTime(1);
  assert.equal(scheduler.isSessionProjectionSettled(), true);
  assert.equal(refreshes, 1);

  scheduler.notifySessionProjectionSettled();
  assert.equal(refreshes, 1, "the readiness transition must be idempotent");
});

test("a real projection settle clears the fail-open timer", () => {
  vi.useFakeTimers();
  let refreshes = 0;
  const scheduler = createStartupBackgroundScheduler({
    isClosed: () => false,
    log: () => undefined,
    onSessionProjectionReady: () => {
      refreshes++;
    },
  });

  assert.equal(vi.getTimerCount(), 1);
  scheduler.notifySessionProjectionSettled();
  assert.equal(scheduler.isSessionProjectionSettled(), true);
  assert.equal(refreshes, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("retries exhausted cannot bypass maintenance owed by an earlier timeout", () => {
  vi.useFakeTimers();
  let refreshes = 0;
  const scheduler = createStartupBackgroundScheduler({
    isClosed: () => false,
    log: () => undefined,
    onSessionProjectionReady: () => {
      refreshes++;
    },
  });

  scheduler.notifyCollectorImportTimedOut();
  scheduler.notifyCollectorImportRetriesExhausted();
  assert.equal(scheduler.isSessionProjectionSettled(), false);
  assert.equal(refreshes, 0);

  scheduler.notifySessionProjectionSettled();
  assert.equal(scheduler.isSessionProjectionSettled(), true);
  assert.equal(refreshes, 1);
});

test("retries exhausted opens projection when no maintenance is owed", () => {
  vi.useFakeTimers();
  const scheduler = createStartupBackgroundScheduler({
    isClosed: () => false,
    log: () => undefined,
  });

  scheduler.notifyCollectorImportRetriesExhausted();
  assert.equal(scheduler.isSessionProjectionSettled(), true);
});
