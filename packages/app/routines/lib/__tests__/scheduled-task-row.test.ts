import {
  runRecordSchema,
  scheduledTaskSchema,
  TaskRoute,
} from "@repo/crewd/model";
import { describe, expect, it } from "vitest";
import {
  humanizeCron,
  runStatusChip,
  taskLastStatusChip,
  taskRouteBadge,
} from "../scheduled-task-row";

function makeTask(overrides: Record<string, unknown>) {
  return scheduledTaskSchema.parse({
    id: "t",
    name: "t",
    cron: "0 9 * * *",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("humanizeCron", () => {
  it("renders daily / weekday / weekly / hourly / minutes in plain English", () => {
    expect(humanizeCron("0 9 * * *")).toBe("Every day at 9:00");
    expect(humanizeCron("0 9 * * 1-5")).toBe("Every weekday at 9:00");
    expect(humanizeCron("30 14 * * 1")).toBe("Every Monday at 14:30");
    expect(humanizeCron("0 * * * *")).toBe("Every hour at :00");
    expect(humanizeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(humanizeCron("0 9 1 * *")).toBe("Monthly on day 1 at 9:00");
  });

  it("appends a non-empty timezone", () => {
    expect(humanizeCron("0 9 * * *", "America/Chicago")).toBe(
      "Every day at 9:00 (America/Chicago)"
    );
  });

  it("falls back to the raw cron for an unrecognized shape", () => {
    // A complex expression it does not model degrades to the raw cron, never a
    // wrong human label.
    expect(humanizeCron("5,10 9 * * *")).toBe("5,10 9 * * *");
    expect(humanizeCron("not a cron")).toBe("not a cron");
  });
});

describe("status chips", () => {
  it("maps a task's last status, and 'never run' when it has none", () => {
    expect(taskLastStatusChip(makeTask({ lastStatus: "success" }))).toEqual({
      label: "Success",
      variant: "success",
    });
    expect(taskLastStatusChip(makeTask({ lastStatus: null })).label).toBe(
      "Never run"
    );
  });

  it("maps a run's status to a chip treatment", () => {
    const run = runRecordSchema.parse({
      id: "r",
      taskId: "t",
      status: "failed",
      startedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(runStatusChip(run)).toEqual({
      label: "Failed",
      variant: "destructive",
    });
  });
});

describe("taskRouteBadge (FEA-3816 M4)", () => {
  it("shows the Claude-routine badge for a claude-routine task", () => {
    expect(
      taskRouteBadge(makeTask({ route: TaskRoute.ClaudeRoutine }))
    ).toEqual({ label: "Claude routine", variant: "info" });
  });

  it("shows the Claude-scheduled-tasks badge for a native local-scheduler task (FEA-3958)", () => {
    expect(
      taskRouteBadge(makeTask({ route: TaskRoute.ClaudeScheduledTasks }))
    ).toEqual({ label: "Claude scheduled tasks", variant: "info" });
  });

  it("shows no badge for the neutral local-cascade default", () => {
    // The pre-M4 default renders no badge — only the notable "handed to Claude"
    // route surfaces one.
    expect(taskRouteBadge(makeTask({ route: TaskRoute.LocalCascade }))).toBe(
      null
    );
    // A store row with no route column parses to local-cascade (schema default),
    // so it also renders no badge — backward compatible.
    expect(taskRouteBadge(makeTask({}))).toBe(null);
  });
});
