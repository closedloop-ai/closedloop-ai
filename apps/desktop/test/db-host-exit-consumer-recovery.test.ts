/**
 * @file db-host-exit-consumer-recovery.test.ts
 * @description ISS-5808 — the CONSUMER half of an unexpected db-host exit.
 *
 * `db-host-exit-work-recovery.test.ts` pins the supervisor and the shared
 * re-drive. This suite pins what each victim from the two live captures does
 * with the classifiable error: the collector import pass, the read IPC
 * boundary, and the Branches translation that laundered one root cause into a
 * second, unrelated-looking one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { rethrowAsBranchSourceError } from "../src/main/branch/branch-read-boundaries.js";
import {
  CollectorImportScope,
  describeCollectorImportFailure,
} from "../src/main/collectors/engine/collector-import-failure-log.js";
import {
  createDbIpcHandlerWrappers,
  DB_HOST_EXIT_REDRIVE_READ,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import type { TranscriptRowIdentity } from "../src/main/database/transcript-sync-store.js";
import type { TranscriptFingerprint } from "../src/main/transcript-sync/transcript-sync-types.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
} from "../src/shared/db-host-shutdown-error.js";
import {
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
  SHARED_BRANCHES_TRANSIENT_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import {
  fakeExecutor,
  fakeScheduler,
  fakeStore,
  fingerprint,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

const EXIT_MESSAGE = "db-host exited (code: 0)";
/** The unchanged wire message every db-host exit still carries. */
const EXIT_MESSAGE_RE = /db-host exited/;
/** The historical-pass line the manager logs for a codex import. */
const CODEX_IMPORT_FAILED_RE = /collector codex import failed: db-host exited/;
/** The live-batch line, in its shutdown-abandonment wording. */
const CLAUDE_LIVE_ABANDONED_RE = /collector claude live import abandoned:/;

function recoverableExit(): DbHostExitError {
  return new DbHostExitError(0, true, EXIT_MESSAGE);
}

function wedgedExit(): DbHostExitError {
  return new DbHostExitError(0, false, EXIT_MESSAGE);
}

/** Run the Branches sanitizer and hand back whatever it threw. */
function captureBranchSourceError(error: unknown): unknown {
  try {
    rethrowAsBranchSourceError("getSharedBranchesPageData", error);
  } catch (thrown) {
    return thrown;
  }
  return null;
}

test("an import pass abandoned by a recoverable host exit is reported INCOMPLETE", () => {
  const report = describeCollectorImportFailure("codex", recoverableExit());
  assert.equal(
    report.passCompleted,
    false,
    "a backfill that stopped at 5/6 source files must never read as a completed pass"
  );
  assert.match(report.line, CODEX_IMPORT_FAILED_RE);
  assert.equal(report.reason, EXIT_MESSAGE);
});

test("an import pass abandoned with no replacement host coming stays complete", () => {
  assert.equal(
    describeCollectorImportFailure("codex", wedgedExit()).passCompleted,
    true,
    "re-arming against a host nobody is restarting would spin the watcher"
  );
});

test("a shutdown abandonment and a genuine failure keep their existing completion verdict", () => {
  const shutdown = describeCollectorImportFailure(
    "claude",
    new DbHostShutdownError(DbHostShutdownReason.Exited, EXIT_MESSAGE),
    CollectorImportScope.Live
  );
  assert.equal(shutdown.passCompleted, true);
  assert.match(shutdown.line, CLAUDE_LIVE_ABANDONED_RE);

  const failure = describeCollectorImportFailure(
    "claude",
    new Error("no such column: nope")
  );
  assert.equal(failure.passCompleted, true);
});

test("the Branches boundary preserves the db-host cause instead of discarding it", () => {
  const exit = recoverableExit();
  const thrown = captureBranchSourceError(exit);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, SHARED_BRANCHES_TRANSIENT_ERROR_CODE);
  assert.equal(
    thrown.cause,
    exit,
    "one root cause presented as two unrelated errors because this link was dropped"
  );
});

test("the Branches boundary does not claim TRANSIENT when no host is coming back", () => {
  const thrown = captureBranchSourceError(wedgedExit());
  assert.ok(thrown instanceof Error);
  assert.equal(
    thrown.message,
    SHARED_BRANCHES_SOURCE_ERROR_CODE,
    "a `transient` label that outlives its own truth is a lie about state"
  );
});

test("a shutdown still passes through the Branches boundary untouched", () => {
  const shutdown = new DbHostShutdownError(
    DbHostShutdownReason.Exited,
    EXIT_MESSAGE
  );
  assert.equal(captureBranchSourceError(shutdown), shutdown);
});

function makeWrappers(): ReturnType<typeof createDbIpcHandlerWrappers> {
  const options = {
    isTrustedSender: () => true,
    log: () => {
      // no-op
    },
  } as unknown as AgentDashboardDesignSystemRuntimeOptions;
  return createDbIpcHandlerWrappers({
    getAgentDatabase: () =>
      Promise.resolve({} as unknown as DbHostAgentDatabase),
    options,
  });
}

const TRUSTED_EVENT = { sender: {} } as unknown as IpcMainInvokeEvent;

test("an opted-in read handler is re-driven after a host exit and resolves", async () => {
  const { withDb } = makeWrappers();
  let calls = 0;
  const handler = withDb(() => {
    calls++;
    if (calls === 1) {
      return Promise.reject(recoverableExit());
    }
    return Promise.resolve("insights");
  }, DB_HOST_EXIT_REDRIVE_READ);

  assert.equal(await handler(TRUSTED_EVENT), "insights");
  assert.equal(calls, 2);
});

test("a handler that did NOT opt in is never re-driven", async () => {
  const { withDb } = makeWrappers();
  let calls = 0;
  const handler = withDb(() => {
    calls++;
    return Promise.reject(recoverableExit());
  });

  await assert.rejects(handler(TRUSTED_EVENT), EXIT_MESSAGE_RE);
  assert.equal(
    calls,
    1,
    "a write handler must never acquire replay by default — the child may have committed"
  );
});

test("withPrisma threads the opt-in through to the same re-drive", async () => {
  const { withPrisma } = makeWrappers();
  let calls = 0;
  const handler = withPrisma(() => {
    calls++;
    if (calls === 1) {
      return Promise.reject(recoverableExit());
    }
    return Promise.resolve("catalog");
  }, DB_HOST_EXIT_REDRIVE_READ);

  assert.equal(await handler(TRUSTED_EVENT), "catalog");
  assert.equal(
    calls,
    2,
    "every withPrisma handler is a read by construction, so dropping the option here would silently exclude ~25 of them"
  );
});

test("an opted-in read still rejects once its re-drive bound is exhausted", async () => {
  const { withDb } = makeWrappers();
  let calls = 0;
  const handler = withDb(() => {
    calls++;
    return Promise.reject(recoverableExit());
  }, DB_HOST_EXIT_REDRIVE_READ);

  await assert.rejects(handler(TRUSTED_EVENT), EXIT_MESSAGE_RE);
  assert.equal(calls, 3);
});

/** One queued row, so a drain actually claims and uploads something. */
function readyRow(): TranscriptFingerprint {
  return fingerprint({ externalSessionId: "sess-a", fileKey: "main" });
}

const STRANDED_IDENTITY = "sess-a:main";

test("a db-host exit mid-upload leaves the file's retry budget untouched", async () => {
  const store = fakeStore([readyRow()]);
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => Promise.reject(recoverableExit()),
    }),
  });

  await assert.rejects(service.drainOnce(), EXIT_MESSAGE_RE);

  assert.deepEqual(
    store.failures,
    [],
    "a host exit is not this file's failure — advancing the ladder here climbs a healthy transcript to a `retries_exhausted` dead-letter the cloud then believes"
  );
  assert.deepEqual(
    store.settledBatches,
    [],
    "and no terminal settle may be recorded for an upload nothing actually rejected"
  );
});

test("a genuine upload failure still advances the ladder", async () => {
  const store = fakeStore([readyRow()]);
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => Promise.reject(new Error("S3 503")),
    }),
  });

  await service.drainOnce();

  assert.equal(
    store.failures.length,
    1,
    "the host-exit exemption must not widen into a blanket swallow"
  );
  assert.equal(store.failures[0].retryCount, 1);
});

test("an exit with no replacement coming is NOT exempted", async () => {
  const store = fakeStore([readyRow()]);
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => Promise.reject(wedgedExit()),
    }),
  });

  await service.drainOnce();

  assert.equal(
    store.failures.length,
    1,
    "holding a row for a re-arm that nothing will ever perform is a strand, not a recovery"
  );
  assert.deepEqual(store.unsettledRequeues, []);
});

test("the stranded row is re-armed BY IDENTITY, never by the boot-only global reset", async () => {
  const store = fakeStore([readyRow()]);
  let uploadFails = true;
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => {
        if (uploadFails) {
          return Promise.reject(recoverableExit());
        }
        return Promise.resolve({ kind: "noop" as const });
      },
    }),
  });

  await assert.rejects(service.drainOnce(), EXIT_MESSAGE_RE);
  // The replacement host is serving; the next ordinary drain re-arms what the
  // exit stranded. Nothing is queued for it to upload, so this drain does only
  // the recovery.
  uploadFails = false;
  store.ready = [];
  await service.drainOnce();

  assert.deepEqual(
    store.unsettledRequeues,
    [[STRANDED_IDENTITY]],
    "recovery must name the rows THIS task abandoned"
  );
  assert.equal(
    store.requeueCalls,
    0,
    "`requeueStale` resets EVERY uploading row and its own contract says that is safe only in a fresh process; a live service with overlapping drains would reset a sibling's active claim"
  );
});

test("a re-arm that fails against a still-dead host is retried, not dropped", async () => {
  const store = fakeStore([readyRow()]);
  let requeueFails = true;
  const attempted: string[][] = [];
  store.requeueUnsettledBatch = (
    identities: readonly TranscriptRowIdentity[]
  ) => {
    attempted.push(
      identities.map((id) => `${id.externalSessionId}:${id.fileKey}`)
    );
    if (requeueFails) {
      return Promise.reject(recoverableExit());
    }
    return Promise.resolve(identities.length);
  };
  const { service } = makeService({
    store,
    scheduler: fakeScheduler().scheduler,
    executor: fakeExecutor({
      syncFile: () => Promise.reject(recoverableExit()),
    }),
  });

  await assert.rejects(service.drainOnce(), EXIT_MESSAGE_RE);
  store.ready = [];
  // The replacement child is not serving yet.
  await service.drainOnce();
  assert.deepEqual(attempted, [[STRANDED_IDENTITY]]);

  // It comes up; the very next ordinary tick lands the re-arm.
  requeueFails = false;
  await service.drainOnce();
  assert.deepEqual(
    attempted,
    [[STRANDED_IDENTITY], [STRANDED_IDENTITY]],
    "a failed re-arm must stay pending — dropping it strands the row until the next launch"
  );

  // And once it lands the identity is retired, so the lane does not re-queue a
  // healthy row on every tick forever.
  await service.drainOnce();
  assert.equal(attempted.length, 2);
});
