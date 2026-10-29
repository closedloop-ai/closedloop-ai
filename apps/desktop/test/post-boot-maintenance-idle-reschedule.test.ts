/**
 * @file post-boot-maintenance-idle-reschedule.test.ts
 * @description ISS-8601 — the bounded wait that re-arms post-boot maintenance
 * after a timed-out boot import.
 *
 * Timers and the clock are INJECTED rather than faked globally: the fake below
 * is created per case, so there is no shared mutable clock to leak into a
 * neighbour and no `afterEach` to forget. Nothing here sleeps, and nothing
 * asserts on elapsed real time.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { scheduleWhenRendererIdle } from "../src/main/dashboard/post-boot-maintenance-idle-reschedule.js";

type Scheduled = { fn: () => void; ms: number; handle: number };

const IDLE_REASON = /renderer idle/;
const CEILING_REASON = /still active/;

/**
 * A timer bag the test drives by hand, plus the clock the ceiling reads. `tick`
 * advances the clock and fires whatever was due, which is exactly the ordering
 * the production `setTimeout` gives without the waiting.
 */
function fakeSchedule(startMs = 0) {
  let nowMs = startMs;
  let nextHandle = 1;
  let pending: Scheduled | null = null;
  return {
    now: () => nowMs,
    timers: {
      set: (fn: () => void, ms: number) => {
        const handle = nextHandle++;
        pending = { fn, ms, handle };
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (handle: ReturnType<typeof setTimeout>) => {
        if (pending && pending.handle === (handle as unknown as number)) {
          pending = null;
        }
      },
    },
    /** Advance to the pending timer's deadline and fire it. */
    tick: () => {
      const due = pending;
      if (!due) {
        // Thrown rather than asserted: this is helper plumbing, not the contract
        // under test, and an assertion outside a `test()` reports against the
        // wrong case.
        throw new Error("expected a pending poll");
      }
      nowMs += due.ms;
      pending = null;
      due.fn();
    },
    hasPending: () => pending !== null,
  };
}

describe("ISS-8601: scheduleWhenRendererIdle", () => {
  test("fires once at the first poll when the renderer is already idle", () => {
    const clock = fakeSchedule();
    let runs = 0;
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => false,
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });

    assert.equal(runs, 0, "nothing runs synchronously — it waits a poll first");
    clock.tick();
    assert.equal(runs, 1);
    assert.equal(clock.hasPending(), false, "settled, so nothing is re-armed");
  });

  test("defers while the renderer is busy, then fires on the first idle poll", () => {
    const clock = fakeSchedule();
    let busy = true;
    let runs = 0;
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => busy,
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });

    clock.tick();
    assert.equal(runs, 0, "busy: deferred");
    assert.equal(clock.hasPending(), true, "and re-armed");
    clock.tick();
    assert.equal(runs, 0, "still busy: still deferred");

    busy = false;
    clock.tick();
    assert.equal(runs, 1);
  });

  test("fires at the CEILING even though the renderer never goes idle", () => {
    // The bound PRD-699 requires: a continuously-used renderer must not defer the
    // owed rebuild forever. This is also the case that deliberately fires into a
    // possibly-still-wedged import host — see the module docblock.
    const clock = fakeSchedule();
    let runs = 0;
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => true,
      run: () => {
        runs++;
      },
      log: () => {},
      pollMs: 1000,
      ceilingMs: 3000,
      now: clock.now,
      timers: clock.timers,
    });

    clock.tick();
    clock.tick();
    assert.equal(runs, 0, "not yet at the ceiling");
    clock.tick();
    assert.equal(
      runs,
      1,
      "the ceiling fires it despite a permanently busy renderer"
    );
    assert.equal(clock.hasPending(), false);
  });

  test("the ceiling wins when a poll and the ceiling fall on the same tick", () => {
    // Ordering is pinned rather than left to whichever branch happens to run
    // first: at the deadline the answer is the same whatever the renderer is
    // doing, and checking idleness first would defer one more full interval PAST
    // the bound.
    const clock = fakeSchedule();
    let runs = 0;
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => true,
      run: () => {
        runs++;
      },
      pollMs: 1000,
      ceilingMs: 1000,
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });

    clock.tick();
    assert.equal(runs, 1);
  });

  test("an absent renderer signal reads as idle", () => {
    const clock = fakeSchedule();
    let runs = 0;
    scheduleWhenRendererIdle({
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });
    clock.tick();
    assert.equal(runs, 1);
  });

  test("cancel() before the first poll suppresses the run", () => {
    const clock = fakeSchedule();
    let runs = 0;
    const handle = scheduleWhenRendererIdle({
      hasRecentRendererRead: () => false,
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });

    handle.cancel();
    assert.equal(clock.hasPending(), false, "the armed timer is cleared");
    assert.equal(runs, 0);
  });

  test("cancel() AFTER busy polls still suppresses the run", () => {
    // The realistic shape: the renderer stays busy for a while and the collectors
    // are then restarted, which cancels. A latch-free implementation would fire
    // the already-scheduled poll.
    const clock = fakeSchedule();
    let runs = 0;
    const handle = scheduleWhenRendererIdle({
      hasRecentRendererRead: () => true,
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: clock.timers,
    });

    clock.tick();
    clock.tick();
    assert.equal(clock.hasPending(), true);
    handle.cancel();
    assert.equal(clock.hasPending(), false);
    assert.equal(runs, 0);
  });

  test("a poll that fires after cancel() is a no-op (the latch, not just the timer)", () => {
    // Clearing the handle is not enough on its own: a timer already handed to the
    // event loop cannot be un-queued, so cancellation has to latch.
    const clock = fakeSchedule();
    let runs = 0;
    let captured: (() => void) | null = null;
    const handle = scheduleWhenRendererIdle({
      hasRecentRendererRead: () => false,
      run: () => {
        runs++;
      },
      log: () => {},
      now: clock.now,
      timers: {
        set: (fn) => {
          captured = fn;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clear: () => {
          // Deliberately does NOT drop the callback — this models a timer the
          // event loop is already committed to running.
        },
      },
    });

    handle.cancel();
    assert.ok(captured, "a poll was scheduled");
    (captured as unknown as () => void)();
    assert.equal(runs, 0, "the latch refuses the late fire");
  });

  test("logs the reason it fired, so an operator can tell idle from ceiling", () => {
    const idleLogs: string[] = [];
    const idleClock = fakeSchedule();
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => false,
      run: () => {},
      log: (m) => idleLogs.push(m),
      now: idleClock.now,
      timers: idleClock.timers,
    });
    idleClock.tick();

    const ceilingLogs: string[] = [];
    const ceilingClock = fakeSchedule();
    scheduleWhenRendererIdle({
      hasRecentRendererRead: () => true,
      run: () => {},
      pollMs: 1000,
      ceilingMs: 1000,
      log: (m) => ceilingLogs.push(m),
      now: ceilingClock.now,
      timers: ceilingClock.timers,
    });
    ceilingClock.tick();

    assert.match(idleLogs.join("\n"), IDLE_REASON);
    assert.match(ceilingLogs.join("\n"), CEILING_REASON);
  });
});
