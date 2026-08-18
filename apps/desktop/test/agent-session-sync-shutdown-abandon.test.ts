/**
 * @file agent-session-sync-shutdown-abandon.test.ts
 * @description ISS-5262 — the agent-session sync lane must not call an
 * intentional shutdown a failure, and the outbox-clear failure must STAY loud.
 *
 * `sync failed: db-host exited (code: 0)` landed immediately after
 * `shutdown sequence end: clean`. The lane did not fail — the user quit while a
 * hydration read was in flight — so the warn line made the shutdown verdict a
 * lie. This pins both halves of that distinction at the real call site:
 *
 *  - a graceful db-host teardown is reported as abandonment, at debug;
 *  - a genuine failure still warns, with its message;
 *  - and the durable outbox-clear failure (`failed to clear N acked outbox
 *    row(s)`) stays a warning even when the cause is a shutdown, because an
 *    acked-but-uncleared row is the corruption risk this whole area exists to
 *    surface. Quieting that one would trade a log that lies for a log that
 *    hides. (Goal stage 2 made the clear awaited and success-reporting — the
 *    ack path aborts on `false` — but the loud warning contract is unchanged.)
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearOutboxOnAck } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import {
  flushAgentSessionSync,
  makeService,
  ResettingSyncSource,
} from "./agent-session-sync-service-fixtures.js";
import { makeSyncedSession } from "./fake-sync-source.js";

const SYNC_TAG = "agent-session-sync";

afterEach(() => {
  gatewayLog.clear();
  gatewayLog.setVerbose(false);
});

/** Every log line the sync lane emitted while a tick failed with `error`. */
async function runSyncTickFailingWith(error: Error): Promise<string[]> {
  const source = new ResettingSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:00:00.000Z"),
  ]);
  // Hydration is a db-host read; when the host is gone it is where the tick
  // dies. Throwing from the load seam reproduces that exactly.
  source.onLoad = () => {
    throw error;
  };
  const service = makeService(source, () =>
    Promise.resolve({ accepted: true })
  );

  gatewayLog.clear();
  service.start();
  await flushAgentSessionSync();
  service.stop();

  return gatewayLog
    .getEntries()
    .filter((entry) => entry.tag === SYNC_TAG)
    .map((entry) => `${entry.level}: ${entry.message}`);
}

test("a graceful db-host exit is not logged as a sync failure", async () => {
  const lines = await runSyncTickFailingWith(
    new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    )
  );

  assert.deepEqual(
    lines.filter((line) => line.includes("sync failed")),
    [],
    `a quit must not read as a sync failure; saw ${JSON.stringify(lines)}`
  );
});

test("a real sync failure is still warned, with its message", async () => {
  const lines = await runSyncTickFailingWith(
    new Error("SQLITE_BUSY: database is locked")
  );

  assert.ok(
    lines.some(
      (line) =>
        line.startsWith("warn:") &&
        line.includes("sync failed: SQLITE_BUSY: database is locked")
    ),
    `a genuine failure must stay loud; saw ${JSON.stringify(lines)}`
  );
});

test("the abandonment is still traceable when verbose logging is on", async () => {
  gatewayLog.setVerbose(true);
  const lines = await runSyncTickFailingWith(
    new DbHostShutdownError(
      DbHostShutdownReason.Exited,
      "db-host exited (code: 0)"
    )
  );

  assert.ok(
    lines.some((line) =>
      line.includes("sync abandoned: db-host shutting down")
    ),
    `quiet is not silent — the reason is still recorded; saw ${JSON.stringify(lines)}`
  );
});

test("an outbox-clear failure still warns, even during a shutdown", async () => {
  gatewayLog.clear();
  const source = {
    clearOutboxEntries: () =>
      Promise.reject(
        new DbHostShutdownError(
          DbHostShutdownReason.Exited,
          "db-host exited (code: 0)"
        )
      ),
  } as unknown as AgentSessionSyncSource;

  // Goal stage 2: the clear is now AWAITED and success-reporting — a failed
  // write resolves `false` (the ack path aborts on it) instead of throwing.
  const cleared = await clearOutboxOnAck({ sourceKey: "target-1", source }, [
    "a",
    "b",
  ]);

  assert.equal(
    cleared,
    false,
    "a failed durable clear must report failure so ack processing aborts"
  );
  const warnings = gatewayLog
    .getEntries()
    .filter((entry) => entry.level === "warn")
    .map((entry) => entry.message);
  assert.ok(
    warnings.some((message) =>
      message.startsWith("failed to clear 2 acked outbox row(s)")
    ),
    "acked-but-uncleared rows are durable-data risk — this must never go quiet; " +
      `saw ${JSON.stringify(warnings)}`
  );
});
