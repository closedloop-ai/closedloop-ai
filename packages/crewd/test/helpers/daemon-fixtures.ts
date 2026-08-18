/**
 * @file daemon-fixtures.ts
 * @description Shared harness for the crewd scheduler daemon suites. Extracted
 * when the one-time-fire (ISS-4736 / ISS-4814) coverage grew past the 1,000-line
 * file ceiling and moved to its own spec — both specs stub the harness the same
 * way and run the daemon with the same cascade, so the fixture lives here rather
 * than being copied into each.
 */
import {
  PassKind,
  type RunRecord,
  RunStatus,
  type ScheduledTask,
  type StoreFile,
} from "../../src/model.js";
import type { Dispatch, DispatchOutcome } from "../../src/scheduler/daemon.js";
import type { StorePort } from "../../src/scheduler/store-port.js";

/** The outcome a stubbed harness reports on the happy path. */
export const ok: DispatchOutcome = {
  status: "success",
  harnessUsed: "codex",
  attempts: [],
  summary: "ok",
  error: null,
};

/** The daemon config every suite runs with; `lockPath` is filled in per test. */
export const config = {
  defaultCascade: [{ harness: "codex" }, { harness: "claude" }] as const,
  lockPath: "",
};

/**
 * A dispatch stub that records the tasks it was handed, so a suite can assert
 * how many times (and with what) the harness was actually launched.
 */
export function countingDispatch(): {
  dispatch: Dispatch;
  calls: () => ScheduledTask[];
} {
  const seen: ScheduledTask[] = [];
  const dispatch: Dispatch = (task) => {
    seen.push(task);
    return Promise.resolve(ok);
  };
  return { dispatch, calls: () => seen };
}

/**
 * Pinned "now" for every case here. Deliberately 30 minutes past the `0 3 * * *`
 * slot: `computeDue` defers a fire by a deterministic per-task jitter capped at
 * `min(period * 0.1, 15min)`, which for a daily cron is 15 minutes. Sitting just
 * seconds after the slot would leave most task ids `jitter-pending`, making
 * due-ness depend on the hash of whatever id a case happened to pick.
 */
export const NOW = new Date("2026-08-11T03:30:00.000Z");

export function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "nightly",
    cron: "0 3 * * *",
    kind: PassKind.Custom,
    prompt: "p",
    harnessCascade: [],
    enabled: true,
    recurring: true,
    durable: true,
    catchUp: true,
    timezone: "",
    meta: {},
    firedAt: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    nextRunAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as ScheduledTask;
}

type StubOverrides = Partial<StorePort>;

/**
 * An in-memory `StorePort`. Unlike the real `TaskStore`, `startRun` does NOT
 * advance `lastRunAt` unless asked to — which is what lets a task stay DUE across
 * ticks so the in-flight guard is actually reachable.
 */
export function stubStore(
  tasks: ScheduledTask[],
  over: StubOverrides = {}
): StorePort {
  const runs: RunRecord[] = [];
  const base: StorePort = {
    listTasks: () => tasks,
    getTask: (id) => tasks.find((t) => t.id === id),
    upsertTask: (input) => makeTask(input as Partial<ScheduledTask>),
    removeTask: () => true,
    setEnabled: (id) => tasks.find((t) => t.id === id),
    refreshNextRuns: () => {
      // no-op: nextRunAt is not the contract under test here
    },
    advanceLastRun: (id, iso) => {
      const t = tasks.find((x) => x.id === id);
      if (t) {
        t.lastRunAt = iso;
      }
    },
    startRun: (t) => {
      const rec = {
        id: `run-${runs.length + 1}`,
        taskId: t.id,
        taskName: t.name,
        status: RunStatus.Running,
        startedAt: NOW.toISOString(),
      } as RunRecord;
      runs.push(rec);
      return rec;
    },
    finishRun: (runId, patch) => {
      const rec = runs.find((r) => r.id === runId);
      if (rec) {
        Object.assign(rec, patch);
      }
      return rec;
    },
    listRuns: () => runs,
    reload: () => {
      // in-memory: nothing to re-read
    },
    snapshot: () => ({ tasks, runs }) as StoreFile,
  };
  return { ...base, ...over };
}
