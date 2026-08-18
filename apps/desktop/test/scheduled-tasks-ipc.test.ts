/**
 * FEA-3814 (PRD-553 M2): read-only Scheduled Tasks IPC contract.
 *
 * Covers the three seams that cross a process boundary:
 *  - the preload bridge (`window.desktopApi.scheduledTasks.*`) invokes the shared
 *    channels with the right payloads and subscribes/unsubscribes `onChanged`;
 *  - the untrusted-arg sanitizer (`coerceScheduledTaskRunsRequest`) clamps a
 *    renderer-supplied `runs` request to the safe shape;
 *  - the db-host `SchedulerChanged` response round-trips the `isDbHostResponse`
 *    type guard so the change push reaches main.
 *
 * The live `list`/`runs` handlers themselves run inside the design-system runtime
 * behind the `withDb` trusted-sender gate (`isTrustedSender` — proven for every
 * `desktop:db:*` handler by the runtime's own gate and the ipc-trusted-sender
 * tests); this suite pins the contract shapes those handlers speak.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DbHostResponseKind,
  isDbHostResponse,
} from "../src/main/database/db-host/db-host-protocol.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import {
  coerceScheduledTaskId,
  coerceScheduledTaskRunsRequest,
  SCHEDULED_TASKS_CHANGED_CHANNEL,
  ScheduledTasksIpcChannel,
  scheduledTaskSaveSchema,
  schedulePreviewRequestSchema,
} from "../src/shared/scheduled-tasks-channel.js";

type Listener = (...args: never[]) => void;

function makeFakeIpc() {
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<Listener>>();
  return {
    invokes,
    listeners,
    ipc: {
      invoke: (channel: string, ...args: unknown[]) => {
        invokes.push({ channel, args });
        return Promise.resolve([]);
      },
      send: () => undefined,
      on: (channel: string, listener: Listener) => {
        const set = listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(channel, set);
      },
      removeListener: (channel: string, listener: Listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
  };
}

describe("scheduled-tasks preload bridge", () => {
  test("list invokes the list channel with no args", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createDesktopApi(ipc);

    await api.scheduledTasks.list();

    assert.deepEqual(invokes, [
      { channel: ScheduledTasksIpcChannel.List, args: [] },
    ]);
  });

  test("runs forwards the scoped request to the runs channel", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createDesktopApi(ipc);

    await api.scheduledTasks.runs({ taskId: "task-1", limit: 10 });

    assert.deepEqual(invokes, [
      {
        channel: ScheduledTasksIpcChannel.Runs,
        args: [{ taskId: "task-1", limit: 10 }],
      },
    ]);
  });

  test("onChanged subscribes on the change channel and the returned fn unsubscribes", () => {
    const { ipc, listeners } = makeFakeIpc();
    const api = createDesktopApi(ipc);
    let calls = 0;

    const unsubscribe = api.scheduledTasks.onChanged(() => {
      calls += 1;
    });
    const set = listeners.get(SCHEDULED_TASKS_CHANGED_CHANNEL);
    assert.equal(set?.size, 1);

    // A main → renderer push fires the callback.
    for (const listener of set ?? []) {
      (listener as () => void)();
    }
    assert.equal(calls, 1);

    // Unsubscribe removes the listener so later pushes are ignored.
    unsubscribe();
    assert.equal(listeners.get(SCHEDULED_TASKS_CHANGED_CHANNEL)?.size, 0);
  });

  test("the mutation + preview bridges forward to their channels (FEA-3853)", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createDesktopApi(ipc);
    const payload = {
      name: "Nightly review",
      cron: "0 9 * * *",
      prompt: "Review PRs",
      kind: "custom" as const,
      harnessCascade: [{ harness: "codex" as const }],
      timezone: "",
      enabled: true,
    };

    await api.scheduledTasks.create(payload);
    await api.scheduledTasks.update({ ...payload, id: "task-1" });
    await api.scheduledTasks.delete("task-1");
    await api.scheduledTasks.toggle("task-1", false);
    await api.scheduledTasks.runNow("task-1");
    await api.scheduledTasks.previewSchedule({ cron: "0 9 * * *" });

    assert.deepEqual(invokes, [
      { channel: ScheduledTasksIpcChannel.Create, args: [payload] },
      {
        channel: ScheduledTasksIpcChannel.Update,
        args: [{ ...payload, id: "task-1" }],
      },
      { channel: ScheduledTasksIpcChannel.Delete, args: ["task-1"] },
      { channel: ScheduledTasksIpcChannel.Toggle, args: ["task-1", false] },
      { channel: ScheduledTasksIpcChannel.RunNow, args: ["task-1"] },
      {
        channel: ScheduledTasksIpcChannel.PreviewSchedule,
        args: [{ cron: "0 9 * * *" }],
      },
    ]);
  });
});

describe("scheduledTaskSaveSchema (write boundary validation)", () => {
  test("accepts a well-formed payload and fills defaults", () => {
    const parsed = scheduledTaskSaveSchema.parse({
      name: "Nightly review",
      cron: "0 9 * * *",
      harnessCascade: ["codex", { harness: "claude", model: "opus" }],
    });
    assert.equal(parsed.kind, "custom");
    assert.equal(parsed.enabled, true);
    // FEA-3816 M4: the broker route defaults to local-cascade when a (possibly
    // older) renderer omits it, so the pre-M4 local behavior is preserved.
    assert.equal(parsed.route, "local-cascade");
    // A bare harness-name string normalizes to a step; the explicit step keeps
    // its model.
    assert.deepEqual(parsed.harnessCascade, [
      { harness: "codex" },
      { harness: "claude", model: "opus" },
    ]);
  });

  test("FEA-3816 M4: accepts an explicit claude-routine broker route and rejects an unknown one", () => {
    const parsed = scheduledTaskSaveSchema.parse({
      name: "Cloud sweep",
      cron: "0 9 * * *",
      route: "claude-routine",
    });
    assert.equal(parsed.route, "claude-routine");
    assert.throws(() =>
      scheduledTaskSaveSchema.parse({
        name: "x",
        cron: "0 9 * * *",
        route: "somewhere-else",
      })
    );
  });

  test("rejects an empty name and an unknown pass kind", () => {
    assert.throws(() =>
      scheduledTaskSaveSchema.parse({ name: "", cron: "0 9 * * *" })
    );
    assert.throws(() =>
      scheduledTaskSaveSchema.parse({
        name: "x",
        cron: "0 9 * * *",
        kind: "nope",
      })
    );
  });

  test("rejects a cascade step with an unknown harness", () => {
    assert.throws(() =>
      scheduledTaskSaveSchema.parse({
        name: "x",
        cron: "0 9 * * *",
        harnessCascade: [{ harness: "gemini" }],
      })
    );
  });
});

describe("schedulePreviewRequestSchema", () => {
  test("defaults timezone and leaves count optional", () => {
    const parsed = schedulePreviewRequestSchema.parse({ cron: "0 9 * * *" });
    assert.equal(parsed.timezone, "");
    assert.equal(parsed.count, undefined);
  });
});

describe("coerceScheduledTaskId", () => {
  test("keeps a non-empty string and rejects everything else", () => {
    assert.equal(coerceScheduledTaskId("task-1"), "task-1");
    assert.equal(coerceScheduledTaskId(""), null);
    assert.equal(coerceScheduledTaskId(42), null);
    assert.equal(coerceScheduledTaskId(null), null);
    assert.equal(coerceScheduledTaskId(undefined), null);
  });
});

describe("coerceScheduledTaskRunsRequest", () => {
  test("passes a valid scoped request through", () => {
    assert.deepEqual(
      coerceScheduledTaskRunsRequest({ taskId: "task-1", limit: 25 }),
      { taskId: "task-1", limit: 25 }
    );
  });

  test("drops an empty taskId and non-positive / non-integer limit", () => {
    assert.deepEqual(coerceScheduledTaskRunsRequest({ taskId: "", limit: 0 }), {
      taskId: undefined,
      limit: undefined,
    });
    assert.deepEqual(coerceScheduledTaskRunsRequest({ limit: -5 }), {
      taskId: undefined,
      limit: undefined,
    });
    assert.deepEqual(coerceScheduledTaskRunsRequest({ limit: 3.5 }), {
      taskId: undefined,
      limit: undefined,
    });
  });

  test("degrades a non-object arg to an unscoped default read", () => {
    assert.deepEqual(coerceScheduledTaskRunsRequest(undefined), {});
    assert.deepEqual(coerceScheduledTaskRunsRequest(null), {});
    assert.deepEqual(coerceScheduledTaskRunsRequest("nope"), {});
  });
});

describe("db-host SchedulerChanged response", () => {
  test("round-trips the isDbHostResponse type guard", () => {
    assert.equal(
      isDbHostResponse({ kind: DbHostResponseKind.SchedulerChanged }),
      true
    );
  });
});
