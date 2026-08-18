import { describe, expect, it } from "vitest";
import {
  CLOUD_ROUTINE_ID_META_KEY,
  hasConfirmedCloudRoutine,
  hasConfirmedNativeOwner,
  isNativeRoute,
  NATIVE_OWNER_META_KEY,
  type ScheduledTask,
  scheduledTaskSchema,
  TaskRoute,
} from "../src/model.js";

/** A minimal, schema-valid task with overridable route/meta. */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return scheduledTaskSchema.parse({
    id: "t1",
    name: "sweep",
    cron: "0 9 * * *",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  });
}

describe("isNativeRoute (FEA-3958)", () => {
  it("is true for the native routes and false for the daemon route", () => {
    expect(isNativeRoute(TaskRoute.ClaudeScheduledTasks)).toBe(true);
    expect(isNativeRoute(TaskRoute.ClaudeRoutine)).toBe(true);
    expect(isNativeRoute(TaskRoute.LocalCascade)).toBe(false);
  });
});

describe("hasConfirmedNativeOwner (FEA-3958)", () => {
  it("is true for a claude-scheduled-tasks route with a stamped native owner", () => {
    const task = makeTask({
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(true);
  });

  it("is false for a native route with NO owner marker (unconfirmed opt-in)", () => {
    const task = makeTask({ route: TaskRoute.ClaudeScheduledTasks });
    expect(hasConfirmedNativeOwner(task)).toBe(false);
  });

  it("is false for a native route with an empty-string owner marker", () => {
    const task = makeTask({
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(false);
  });

  it("is false for a local-cascade task even if a stray marker is present", () => {
    const task = makeTask({
      route: TaskRoute.LocalCascade,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(false);
  });

  it("also recognizes a confirmed claude-routine via the legacy cloud key", () => {
    const task = makeTask({
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(true);
  });

  it("does NOT confirm a claude-routine carrying only the other route's stale marker", () => {
    // Route-matched markers: a `claude-routine` task holding only a leftover
    // `nativeOwnerId` (the scheduled-tasks key, e.g. a route flip whose async
    // cleanup did not land) must NOT read as cloud-confirmed, or the daemon would
    // suppress it indefinitely against a non-owning cloud stub.
    const task = makeTask({
      route: TaskRoute.ClaudeRoutine,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(false);
  });

  it("does NOT confirm a claude-scheduled-tasks carrying only the cloud marker", () => {
    // The mirror case: a native local task holding only a leftover
    // `cloudRoutineId` is not confirmed by the scheduled-tasks route.
    const task = makeTask({
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    expect(hasConfirmedNativeOwner(task)).toBe(false);
  });
});

describe("hasConfirmedCloudRoutine delegation (FEA-3958)", () => {
  it("stays true for a confirmed claude-routine task", () => {
    const task = makeTask({
      route: TaskRoute.ClaudeRoutine,
      meta: { [CLOUD_ROUTINE_ID_META_KEY]: "routine-cloud" },
    });
    expect(hasConfirmedCloudRoutine(task)).toBe(true);
  });

  it("stays false for an unconfirmed claude-routine task", () => {
    const task = makeTask({ route: TaskRoute.ClaudeRoutine });
    expect(hasConfirmedCloudRoutine(task)).toBe(false);
  });

  it("does NOT report a confirmed claude-scheduled-tasks task as a cloud routine", () => {
    // A native local-scheduler task, even when confirmed, is not a cloud routine
    // — the cloud facade must stay narrowed to the claude-routine route so the
    // daemon's existing cloud guard is unchanged.
    const task = makeTask({
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "entry-abc" },
    });
    expect(hasConfirmedCloudRoutine(task)).toBe(false);
    expect(hasConfirmedNativeOwner(task)).toBe(true);
  });
});
