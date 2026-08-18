/**
 * @file db-host-shutdown-preload-unwrap.test.ts
 * @description ISS-5262 — the preload half of the shutdown-sentinel contract.
 *
 * `withDb` now RESOLVES a payload-free sentinel instead of rejecting when the
 * db-host went away mid-read, which is what stops `ipcMain.handle` printing
 * `Error occurred in handler for '<channel>'` after the shutdown sequence
 * reported clean. That only stays safe if EVERY preload bridge over a
 * `withDb`-registered channel unwraps it: the bridges cast the IPC result
 * (`invoke(...) as Promise<T>`), so a sentinel that slips past typechecks as the
 * declared type and reaches the renderer AS DATA — a truthy object read as a
 * successful `delete`, or a non-array handed to a table's `.map`.
 *
 * The review of this change caught exactly that: the eight
 * `desktop:scheduled-tasks:*` bridges in `preload-common.ts` invoke directly and
 * never went through `invokeLiveDb`. These tests pin the unwrap, plus the
 * message classification the renderer depends on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopApi } from "../src/main/preload-common.js";
import {
  DB_HOST_SHUTTING_DOWN_MESSAGE,
  DB_HOST_SHUTTING_DOWN_RESULT,
  isDbHostShuttingDownResult,
  rejectIfDbHostShuttingDown,
} from "../src/shared/db-host-shutdown-contract.js";
import { ScheduledTasksIpcChannel } from "../src/shared/scheduled-tasks-channel.js";
import { isTransientDbHostErrorMessage } from "../src/shared/transient-db-host-error.js";

const SHUTDOWN_MESSAGE_PATTERN = /shutting down; read abandoned/;

/** The db-backed Scheduled Tasks bridges — every one is registered via `withDb`. */
const SCHEDULED_TASKS_DB_CHANNELS = [
  ScheduledTasksIpcChannel.List,
  ScheduledTasksIpcChannel.Runs,
  ScheduledTasksIpcChannel.Create,
  ScheduledTasksIpcChannel.Update,
  ScheduledTasksIpcChannel.Delete,
  ScheduledTasksIpcChannel.Toggle,
  ScheduledTasksIpcChannel.RunNow,
  ScheduledTasksIpcChannel.PreviewSchedule,
] as const;

/** An `IpcRendererLike` whose every `invoke` resolves the shutdown sentinel. */
function shuttingDownIpcRenderer() {
  const invoked: string[] = [];
  return {
    invoked,
    ipcRendererLike: {
      invoke: (channel: string) => {
        invoked.push(channel);
        // A structured clone, not the frozen singleton — exactly what crosses IPC.
        return Promise.resolve({ ...DB_HOST_SHUTTING_DOWN_RESULT });
      },
      send: () => {
        // unused
      },
      on: () => {
        // unused
      },
      removeListener: () => {
        // unused
      },
    },
  };
}

test("rejectIfDbHostShuttingDown passes a real result through", () => {
  const usage = { totalCostUsd: 12.5, sessions: 3 };
  assert.equal(
    rejectIfDbHostShuttingDown(usage),
    usage,
    "a genuine payload is returned untouched, by identity"
  );
  assert.equal(rejectIfDbHostShuttingDown(null), null);
  assert.equal(rejectIfDbHostShuttingDown(0), 0, "a real zero is still a zero");
});

test("rejectIfDbHostShuttingDown converts the sentinel to a rejection", () => {
  assert.throws(
    () => rejectIfDbHostShuttingDown({ ...DB_HOST_SHUTTING_DOWN_RESULT }),
    SHUTDOWN_MESSAGE_PATTERN,
    "the sentinel must never be handed to a caller as a value"
  );
});

test("the rejection stays TRANSIENT for the renderer's classifier", () => {
  // Before ISS-5262 a read racing the teardown rejected with the raw
  // `db-host exited (code: 0)`, which the renderer classified as a lifecycle
  // blip (quiet reconnecting state, retry). A message the classifier does not
  // recognize would silently promote that to the hard error card — trading a
  // lying log for a lying UI.
  assert.equal(
    isTransientDbHostErrorMessage("db-host exited (code: 0)"),
    true,
    "baseline: the pre-change message was transient"
  );
  assert.equal(
    isTransientDbHostErrorMessage(DB_HOST_SHUTTING_DOWN_MESSAGE),
    true,
    "so the replacement must be transient too"
  );
});

test("every Scheduled Tasks bridge rejects rather than returning the sentinel", async () => {
  const { ipcRendererLike, invoked } = shuttingDownIpcRenderer();
  const api = createDesktopApi(ipcRendererLike);
  const { scheduledTasks } = api;
  const payload = {
    name: "n",
    cron: "* * * * *",
    timezone: "UTC",
    prompt: "p",
  };
  const calls: [string, () => Promise<unknown>][] = [
    [ScheduledTasksIpcChannel.List, () => scheduledTasks.list()],
    [ScheduledTasksIpcChannel.Runs, () => scheduledTasks.runs()],
    [
      ScheduledTasksIpcChannel.Create,
      () =>
        scheduledTasks.create(
          payload as Parameters<typeof scheduledTasks.create>[0]
        ),
    ],
    [
      ScheduledTasksIpcChannel.Update,
      () =>
        scheduledTasks.update(
          payload as Parameters<typeof scheduledTasks.update>[0]
        ),
    ],
    [ScheduledTasksIpcChannel.Delete, () => scheduledTasks.delete("id")],
    [ScheduledTasksIpcChannel.Toggle, () => scheduledTasks.toggle("id", true)],
    [ScheduledTasksIpcChannel.RunNow, () => scheduledTasks.runNow("id")],
    [
      ScheduledTasksIpcChannel.PreviewSchedule,
      () =>
        scheduledTasks.previewSchedule({
          cron: "* * * * *",
          timezone: "UTC",
          count: 1,
        }),
    ],
  ];

  for (const [channel, call] of calls) {
    const settled = await call().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, value: error })
    );
    assert.equal(
      settled.ok,
      false,
      `${channel} resolved the sentinel; a truthy object here reads as a ` +
        "successful write, and a non-array crashes the routines table"
    );
    assert.match(
      String((settled.value as Error).message),
      SHUTDOWN_MESSAGE_PATTERN
    );
    assert.equal(
      isDbHostShuttingDownResult(settled.value),
      false,
      `${channel} must not hand the sentinel out in any form`
    );
  }

  // Every db-backed channel was actually exercised — a bridge silently renamed
  // or dropped would leave this short.
  assert.deepEqual(
    [...invoked].sort(),
    [...SCHEDULED_TASKS_DB_CHANNELS].sort(),
    "all eight withDb-registered Scheduled Tasks channels were covered"
  );
});
