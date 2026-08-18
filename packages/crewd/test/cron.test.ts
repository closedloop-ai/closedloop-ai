import { describe, expect, it } from "vitest";
import {
  computeDue,
  jitterMs,
  nextRun,
  prevRun,
  validateCron,
} from "../src/scheduler/cron.js";

describe("cron validation + basic evaluation", () => {
  it("validates good and bad expressions", () => {
    expect(validateCron("0 * * * *").ok).toBe(true);
    expect(validateCron("not a cron").ok).toBe(false);
  });

  it("computes next/prev fires in UTC", () => {
    const from = new Date("2026-07-22T10:02:00Z");
    expect(nextRun("0 * * * *", from, { timezone: "UTC" }).toISOString()).toBe(
      "2026-07-22T11:00:00.000Z"
    );
    expect(prevRun("0 * * * *", from, { timezone: "UTC" })?.toISOString()).toBe(
      "2026-07-22T10:00:00.000Z"
    );
  });
});

describe("jitter", () => {
  it("stays within the min(10% period, 15min) cap and is deterministic", () => {
    const slot = new Date("2026-07-22T10:00:00Z");
    const hourlyCapMs = 360_000; // 10% of 3600s
    const a = jitterMs("cutter-carl", slot, "0 * * * *", { timezone: "UTC" });
    const b = jitterMs("cutter-carl", slot, "0 * * * *", { timezone: "UTC" });
    expect(a).toBe(b); // deterministic
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(hourlyCapMs);
  });
});

describe("computeDue", () => {
  const cron = "0 * * * *";
  const tz = "UTC";

  it("fires a stale slot when never run and catchUp on", () => {
    const now = new Date("2026-07-22T10:30:00Z");
    const r = computeDue({
      taskId: "t",
      cron,
      now,
      lastRunAt: null,
      catchUp: true,
      timezone: tz,
    });
    expect(r.reason).toBe("due");
    expect(r.due).toBe(true);
    expect(r.slot?.toISOString()).toBe("2026-07-22T10:00:00.000Z");
  });

  it("does not fire a slot already run", () => {
    const now = new Date("2026-07-22T10:30:00Z");
    const r = computeDue({
      taskId: "t",
      cron,
      now,
      lastRunAt: new Date("2026-07-22T10:00:00Z"),
      catchUp: true,
      timezone: tz,
    });
    expect(r.reason).toBe("already-ran");
    expect(r.due).toBe(false);
  });

  it("skips a stale missed slot when catchUp is off", () => {
    const now = new Date("2026-07-22T10:30:00Z");
    const r = computeDue({
      taskId: "t",
      cron,
      now,
      lastRunAt: null,
      catchUp: false,
      timezone: tz,
    });
    expect(r.reason).toBe("stale-missed");
    expect(r.due).toBe(false);
  });

  it("fires a non-catchUp task at its jittered fireAt even when jitter exceeds the grace window", () => {
    // Regression (PR #3460 thread 3): the stale-age check anchored on the raw
    // cron slot, so a non-catchUp task whose deterministic jitter exceeds the
    // 90s grace was `jitter-pending` until fireAt, then instantly `stale-missed`
    // and never ran. Pick a taskId whose slot jitter is > 90s and assert it
    // fires exactly at fireAt.
    const slot = new Date("2026-07-22T10:00:00Z");
    let taskId = "";
    let j = 0;
    for (let i = 0; i < 500; i++) {
      const candidate = `jittery-${i}`;
      const jm = jitterMs(candidate, slot, cron, { timezone: tz });
      if (jm > 90_000) {
        taskId = candidate;
        j = jm;
        break;
      }
    }
    expect(taskId).not.toBe(""); // a > 90s jitter slot exists in an hourly cap
    const r = computeDue({
      taskId,
      cron,
      now: new Date(slot.getTime() + j),
      lastRunAt: null,
      catchUp: false,
      timezone: tz,
    });
    expect(r.reason).toBe("due");
    expect(r.due).toBe(true);
  });

  it("respects the jitter window at the slot boundary", () => {
    const slot = new Date("2026-07-22T10:00:00Z");
    const j = jitterMs("boundary", slot, cron, { timezone: tz });
    if (j > 0) {
      const pending = computeDue({
        taskId: "boundary",
        cron,
        now: new Date(slot.getTime() + j - 1),
        lastRunAt: null,
        catchUp: true,
        timezone: tz,
      });
      expect(pending.reason).toBe("jitter-pending");
      expect(pending.due).toBe(false);
    }
    const ready = computeDue({
      taskId: "boundary",
      cron,
      now: new Date(slot.getTime() + j),
      lastRunAt: null,
      catchUp: true,
      timezone: tz,
    });
    expect(ready.due).toBe(true);
  });
});
