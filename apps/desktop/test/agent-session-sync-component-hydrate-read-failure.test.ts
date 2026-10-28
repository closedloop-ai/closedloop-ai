/**
 * ISS-10910: a rejected `syncSource.loadSyncState` during the component lane's
 * cursor hydration had no catch between it and the service's `void` launch of
 * the lane, so it reached the fatal `unhandledRejection` dialog and ended the
 * app. Drives the REAL service tick over a real migrated store (the production
 * cursor query, row loader, and `sync_state` delegates); only the transport is
 * faked, and `loadSyncState` rejects with the db-host error the crash carried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  type AgentSessionSyncSource,
  buildAgentComponentSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  listAgentComponentCursorRows,
  loadSyncedComponentRows,
} from "../src/main/database/component-sync-source.js";
import { createSyncCursorStateDelegates } from "../src/main/database/sync-cursor-state-delegates.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import { DbStoreOpDeadlineError } from "../src/shared/db-store-op-deadline-error.js";
import { LANE_STALL_RETRY_FLOOR_MS } from "../src/shared/lane-stall-clock.js";
import { seedInventoryRow } from "./agent-session-sync-component-lane-cov-iss11283-harness.js";
import { acceptedResult } from "./agent-session-sync-component-test-utils.js";
import { FakeSyncSource } from "./fake-sync-source.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const TARGET = "target-iss10910";
const SOURCE_KEY = buildAgentComponentSyncSourceKey(TARGET);
const SYNCED_SEEN_AT = "2026-09-21T10:00:00.000Z";
const UNSYNCED_SEEN_AT = "2026-09-22T09:00:00.000Z";
const LATER_SEEN_AT = "2026-09-22T10:00:00.000Z";
const CLOSING_MESSAGE = "db-host is closing (op: syncSource.loadSyncState)";
const LOAD_OP = "syncSource.loadSyncState";
const HOUR_MS = 3_600_000;
const PERSIST_WAIT = { timeout: 5000, interval: 25 };

let opened: OpenTestPrisma;
const services: AgentSessionSyncService[] = [];

beforeEach(async () => {
  opened = await openTestPrisma();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) {
    service.stop();
  }
  await opened.close();
});

/**
 * A service whose component lane reads the real store. `sourceUp` is the db host
 * being reachable (`getSource()` null while it restarts); `cursorReadError`, when
 * set, is what the component lane's durable-cursor read rejects with. The
 * session lane's own `loadSyncState` key is never failed.
 */
async function makeService() {
  const delegates = createSyncCursorStateDelegates(opened.prisma);
  const control: { sourceUp: boolean; cursorReadError: Error | null } = {
    sourceUp: true,
    cursorReadError: null,
  };
  const source: AgentSessionSyncSource = Object.assign(
    new FakeSyncSource([]),
    delegates,
    {
      loadSyncState: (key: string) => {
        if (key === SOURCE_KEY && control.cursorReadError) {
          return Promise.reject(control.cursorReadError);
        }
        return delegates.loadSyncState(key);
      },
    }
  );
  await seedInventoryRow(opened, "c-synced", SYNCED_SEEN_AT);
  await seedInventoryRow(opened, "c-unsynced", UNSYNCED_SEEN_AT);
  // The install already delivered `c-synced` and recorded it durably.
  await delegates.advanceSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: SYNCED_SEEN_AT,
    observedIdsAtTopUpdatedAt: ["c-synced"],
    deadLetteredIds: [],
  });
  const sent: string[][] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => (control.sourceUp ? source : null),
    getSyncComputeTargetId: () => TARGET,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: (sinceTs, sinceId, limit) =>
      listAgentComponentCursorRows(opened.prisma, sinceTs, sinceId, limit),
    loadComponentRows: (ids) => loadSyncedComponentRows(opened.prisma, ids),
    sendComponents: (payload) => {
      sent.push(payload.components.map((c) => c.externalId));
      return Promise.resolve(acceptedResult());
    },
  });
  services.push(service);
  return {
    service,
    control,
    sent,
    durableCursor: () => delegates.loadSyncState(SOURCE_KEY),
  };
}

describe("component lane durable-cursor read failure (ISS-10910)", () => {
  it("settles the tick instead of rejecting, and leaves the durable cursor alone", async () => {
    gatewayLog.clear();
    const { service, control, sent, durableCursor } = await makeService();
    control.cursorReadError = closingError();

    service.start();
    // The promise the service launches with `void`; a rejection here is what
    // reached the fatal dialog.
    await expect(service.whenComponentSyncSettled()).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(await durableCursor()).toMatchObject({
      observedTopUpdatedAt: SYNCED_SEEN_AT,
      observedIdsAtTopUpdatedAt: ["c-synced"],
    });
    // A closing db host is not a lane failure (ISS-5262): logged, not warned.
    expect(hydrateFailureLevels(CLOSING_MESSAGE)).toEqual(["info"]);
  });

  it("warns when the read misses its store-op deadline, and still settles", async () => {
    gatewayLog.clear();
    const { service, control, sent } = await makeService();
    const deadline = new DbStoreOpDeadlineError(LOAD_OP, HOUR_MS, HOUR_MS + 1);
    control.cursorReadError = deadline;

    service.start();
    await expect(service.whenComponentSyncSettled()).resolves.toBeUndefined();

    expect(sent).toEqual([]);
    expect(hydrateFailureLevels(deadline.message)).toEqual(["warn"]);
  });

  it("warns when a closing-host failure turns into a missed deadline", async () => {
    // tamsinb review: the wedged-store case — the host was closing on the
    // first read, and every later read misses its deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    gatewayLog.clear();
    const { service, control } = await makeService();
    control.cursorReadError = closingError();
    service.start();
    await service.whenComponentSyncSettled();

    const deadline = new DbStoreOpDeadlineError(LOAD_OP, HOUR_MS, HOUR_MS + 1);
    control.cursorReadError = deadline;
    vi.setSystemTime(Date.now() + LANE_STALL_RETRY_FLOOR_MS);
    service.refresh();
    await service.whenComponentSyncSettled();

    expect(hydrateFailureLevels(CLOSING_MESSAGE)).toEqual(["info"]);
    expect(hydrateFailureLevels(deadline.message)).toEqual(["warn"]);
  });

  it("re-reads the durable cursor on the next paced attempt and resumes from it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, control, sent, durableCursor } = await makeService();
    control.cursorReadError = closingError();
    service.start();
    await service.whenComponentSyncSettled();

    control.cursorReadError = null;
    // ISS-10910 (whitlockk review): the failed read charged the environmental
    // clock, so a tick inside its first rung attempts nothing.
    service.refresh();
    await service.whenComponentSyncSettled();
    expect(sent).toEqual([]);

    vi.setSystemTime(Date.now() + LANE_STALL_RETRY_FLOOR_MS);
    service.refresh();
    await service.whenComponentSyncSettled();

    // Only the row past the durable cursor: an epoch walk would resend c-synced.
    expect(sent).toEqual([["c-unsynced"]]);
    // The cursor write is fire-and-forget behind the write queue.
    await vi.waitFor(async () => {
      expect(await durableCursor()).toMatchObject({
        observedTopUpdatedAt: UNSYNCED_SEEN_AT,
        observedIdsAtTopUpdatedAt: ["c-unsynced"],
      });
    }, PERSIST_WAIT);
  });

  it("keeps the in-memory position a failed read found, for the next source-less tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, control, sent } = await makeService();
    // Db host restarting: the lane sweeps from memory (ISS-5347) and reaches c-unsynced.
    control.sourceUp = false;
    service.start();
    await service.whenComponentSyncSettled();
    expect(sent).toEqual([["c-synced", "c-unsynced"]]);

    control.sourceUp = true;
    control.cursorReadError = closingError();
    service.refresh();
    await service.whenComponentSyncSettled();

    await seedInventoryRow(opened, "c-later", LATER_SEEN_AT);
    control.sourceUp = false;
    // Past the rung the failed read charged.
    vi.setSystemTime(Date.now() + LANE_STALL_RETRY_FLOOR_MS);
    service.refresh();
    await service.whenComponentSyncSettled();

    // A failed read that cleared the position would re-walk from epoch here.
    expect(sent).toEqual([["c-synced", "c-unsynced"], ["c-later"]]);
  });
});

function closingError(): DbHostShutdownError {
  return new DbHostShutdownError(DbHostShutdownReason.Closing, CLOSING_MESSAGE);
}

/** Levels of the component lane's hydrate-failure lines naming `reason`. */
function hydrateFailureLevels(reason: string): string[] {
  return gatewayLog
    .getEntries()
    .filter(
      (e) =>
        e.message ===
        `component sync lane: durable cursor read failed: ${reason}`
    )
    .map((e) => e.level);
}
