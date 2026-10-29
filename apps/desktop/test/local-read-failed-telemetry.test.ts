/**
 * ISS-11351: a local durable read that fails reaches the monitored telemetry
 * path as `desktop.local_read.failed`, naming the read, and a cancellation, a
 * db-host lifecycle failure or a store-op deadline does not.
 *
 * Driven through the production entry points — the SQLite sync source's two
 * aggregates, the component lane's tick through `AgentSessionSyncService`, and
 * main's `DbHostClient` for what the db-host child relays — with the test's own
 * sink as the transport, so deleting a call site reddens its case rather than a
 * mocked reporter's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { AgentSessionSyncServiceOptions } from "../src/main/agent-sync/agent-session-sync-service-options.js";
import { buildAgentComponentSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  DbHostResponseKind,
  type DbHostTelemetryResponse,
} from "../src/main/database/db-host/db-host-protocol.js";
import { createDbHostTelemetryRelaySink } from "../src/main/database/db-host/db-host-telemetry-relay.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  getDesktopClientVersion,
  setDesktopClientVersion,
} from "../src/main/telemetry/desktop-client-version.js";
import { LocalReadFailedRead } from "../src/main/telemetry/local-read-failed-diagnostics.js";
import {
  LOCAL_READ_FAILED_CATEGORY,
  resetLocalReadFailedReports,
} from "../src/main/telemetry/local-read-failed-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { setTelemetryDeliverable } from "../src/main/telemetry/telemetry-delivery-readiness.js";
import { setTelemetryRelaySink } from "../src/main/telemetry/telemetry-relay-sink.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import { DbStoreOpDeadlineError } from "../src/shared/db-store-op-deadline-error.js";
import {
  READ_CANCELLED_ERROR_MESSAGE,
  READ_CANCELLED_ERROR_NAME,
} from "../src/shared/read-cancellation-contract.js";
import { DB_HOST_EXITED_SIGNATURE } from "../src/shared/transient-db-host-error.js";
import { acceptedResult } from "./agent-session-sync-component-test-utils.js";
import { deliverChildMessages } from "./db-host-fake-child-support.js";
import { FakeSyncSource } from "./fake-sync-source.js";

const TARGET = "target-iss11351";
const CURSOR_ROW = { id: "comp-a", last_seen_at: "2026-09-28T00:00:00.000Z" };
const DRIVER_ERROR_MESSAGE = "SQLITE_CORRUPT: database disk image is malformed";

const MAIN_VERSION = "0.0.0-iss11351";

const events: EnrichedTelemetryEvent[] = [];
/** The lane's send gate. Closed by default so the latch never sets between cases. */
let deliverable = false;
let previousVersion = "";

beforeEach(() => {
  events.length = 0;
  deliverable = false;
  previousVersion = getDesktopClientVersion();
  resetLocalReadFailedReports();
  Observability.init({ telemetrySend: (event) => events.push(event) });
  setTelemetryDeliverable(() => deliverable);
});

afterEach(() => {
  setTelemetryRelaySink(null);
  setDesktopClientVersion(previousVersion);
  setTelemetryDeliverable(null);
  Observability.initNoOp();
  resetLocalReadFailedReports();
});

/** The `read` of every `desktop.local_read.failed` event, in emit order. */
function reportedReads(): unknown[] {
  return events
    .filter((event) => event.category === LOCAL_READ_FAILED_CATEGORY)
    .map((event) => event.diagnostics?.localReadFailed?.read);
}

function failingSource(failure: unknown) {
  const prisma = {
    read: () => Promise.reject(failure),
    write: () => Promise.reject(failure),
  };
  return createSqliteSessionSyncSource(
    prisma as unknown as DesktopPrisma,
    () => undefined
  );
}

const AGGREGATE_READS = {
  [LocalReadFailedRead.UsageAggregate]: (failure: unknown) =>
    failingSource(failure).aggregateUsage?.({}),
  [LocalReadFailedRead.AnalyticsAggregate]: (failure: unknown) =>
    failingSource(failure).aggregateAnalytics?.(
      {},
      createSessionAttributionResolverCache()
    ),
};

async function settle(run: () => unknown): Promise<void> {
  try {
    await run();
  } catch {
    // Every aggregate here rejects by construction; the telemetry is the subject.
  }
}

/** One component-lane tick through the real service, with `overrides` failing a read. */
async function runComponentTick(
  overrides: Partial<AgentSessionSyncServiceOptions>
): Promise<void> {
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => null,
    getSyncComputeTargetId: () => TARGET,
    sendBatch: () => Promise.resolve({ accepted: true }),
    listComponentCursorRows: () => Promise.resolve([CURSOR_ROW]),
    loadComponentRows: () => Promise.resolve([]),
    sendComponents: () => Promise.resolve(acceptedResult()),
    ...overrides,
  });
  service.start();
  await service.whenComponentSyncSettled();
  service.stop();
}

/** A source whose component durable-cursor read rejects with `failure`. */
function sourceFailingCursorHydrate(failure: unknown) {
  const componentKey = buildAgentComponentSyncSourceKey(TARGET);
  const source = new FakeSyncSource([]);
  const loadSyncState = source.loadSyncState.bind(source);
  return Object.assign(source, {
    loadSyncState: (key: string) =>
      key === componentKey ? Promise.reject(failure) : loadSyncState(key),
  });
}

const COMPONENT_READS = {
  [LocalReadFailedRead.ComponentCursorHydrate]: (failure: unknown) => {
    const source = sourceFailingCursorHydrate(failure);
    return runComponentTick({ getSource: () => source });
  },
  [LocalReadFailedRead.ComponentCursorRead]: (failure: unknown) =>
    runComponentTick({
      listComponentCursorRows: () => Promise.reject(failure),
    }),
  [LocalReadFailedRead.ComponentRowsLoad]: (failure: unknown) =>
    runComponentTick({ loadComponentRows: () => Promise.reject(failure) }),
};

describe("desktop.local_read.failed (ISS-11351)", () => {
  it.each(Object.keys(AGGREGATE_READS) as (keyof typeof AGGREGATE_READS)[])(
    "a failed %s reports once, at error severity, naming the read",
    async (read) => {
      await settle(() =>
        AGGREGATE_READS[read](new Error(DRIVER_ERROR_MESSAGE))
      );

      expect(reportedReads()).toEqual([read]);
      expect(events[0]?.severity).toBe("error");
      expect(events[0]?.message).not.toContain(DRIVER_ERROR_MESSAGE);
    }
  );

  it.each(Object.keys(COMPONENT_READS) as (keyof typeof COMPONENT_READS)[])(
    "a failed component-lane %s reports, naming the read",
    async (read) => {
      await COMPONENT_READS[read](new Error(DRIVER_ERROR_MESSAGE));

      expect(reportedReads()).toEqual([read]);
    }
  );

  // Through a read with no classification of its own, so the reporter's guard
  // is the only thing standing between each failure and an alert.
  it.each([
    ["a cancellation", cancellationError()],
    ["a db-host restart", new Error(`${DB_HOST_EXITED_SIGNATURE} (code: 0)`)],
    [
      "an app shutdown",
      new DbHostShutdownError(
        DbHostShutdownReason.Closing,
        "db-host is closing (op: syncSource.listComponentCursorRows)"
      ),
    ],
  ])("%s on a component-lane read reports nothing", async (_label, failure) => {
    await COMPONENT_READS[LocalReadFailedRead.ComponentCursorRead](failure);

    expect(events).toEqual([]);
  });

  // ISS-8773: a deadline is load-dependent, so it must not spend the latch a
  // real failure on the same read needs later in the process.
  it("a store-op deadline reports nothing and leaves the read's report unspent", async () => {
    deliverable = true;
    const cursorRead = COMPONENT_READS[LocalReadFailedRead.ComponentCursorRead];

    await cursorRead(new DbStoreOpDeadlineError("syncSource.read", 1000, 1001));
    expect(events).toEqual([]);

    await cursorRead(new Error(DRIVER_ERROR_MESSAGE));
    expect(reportedReads()).toEqual([LocalReadFailedRead.ComponentCursorRead]);
  });

  it("latches a read only once main's send gate accepts it", async () => {
    const failure = new Error(DRIVER_ERROR_MESSAGE);
    const cursorRead = COMPONENT_READS[LocalReadFailedRead.ComponentCursorRead];

    await cursorRead(failure);
    deliverable = true;
    await cursorRead(failure);
    await cursorRead(failure);
    await COMPONENT_READS[LocalReadFailedRead.ComponentRowsLoad](failure);

    expect(reportedReads()).toEqual([
      LocalReadFailedRead.ComponentCursorRead,
      LocalReadFailedRead.ComponentCursorRead,
      LocalReadFailedRead.ComponentRowsLoad,
    ]);
  });

  // The aggregates run in the db-host child, whose relay always accepts while
  // main's lane may still drop the event, so main is where the latch belongs.
  it("a db-host child forwards every failure, and main latches it once accepted", async () => {
    const posted: DbHostTelemetryResponse[] = [];
    setTelemetryRelaySink(
      createDbHostTelemetryRelaySink({
        post: (message) => posted.push(message),
        log: () => undefined,
      })
    );
    const usage = AGGREGATE_READS[LocalReadFailedRead.UsageAggregate];
    const failure = new Error(DRIVER_ERROR_MESSAGE);
    await settle(() => usage(failure));
    await settle(() => usage(failure));
    await settle(() => usage(failure));
    setTelemetryRelaySink(null);
    expect(
      posted.map((message) => message.event.diagnostics?.localReadFailed?.read)
    ).toEqual([
      LocalReadFailedRead.UsageAggregate,
      LocalReadFailedRead.UsageAggregate,
      LocalReadFailedRead.UsageAggregate,
    ]);

    setDesktopClientVersion(MAIN_VERSION);
    deliverChildMessages(posted.slice(0, 1));
    deliverable = true;
    deliverChildMessages(posted.slice(1));

    expect(reportedReads()).toEqual([
      LocalReadFailedRead.UsageAggregate,
      LocalReadFailedRead.UsageAggregate,
    ]);
    expect(events.map((event) => event.trace?.desktopClientVersion)).toEqual([
      MAIN_VERSION,
      MAIN_VERSION,
    ]);
  });

  it("main forwards a relayed report that names no read instead of dropping it", () => {
    deliverable = true;
    const event = {
      severity: "error",
      category: LOCAL_READ_FAILED_CATEGORY,
      message: DRIVER_ERROR_MESSAGE,
    };

    deliverChildMessages([
      { kind: DbHostResponseKind.Telemetry, event },
      { kind: DbHostResponseKind.Telemetry, event },
    ]);

    expect(events.map((relayed) => relayed.category)).toEqual([
      LOCAL_READ_FAILED_CATEGORY,
      LOCAL_READ_FAILED_CATEGORY,
    ]);
  });
});

function cancellationError(): Error {
  return Object.assign(new Error(READ_CANCELLED_ERROR_MESSAGE), {
    name: READ_CANCELLED_ERROR_NAME,
  });
}
