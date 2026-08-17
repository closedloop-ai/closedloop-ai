/**
 * @file wal-checkpoint-cadence.test.ts
 * @description ISS-4723 / ISS-4819: the TRUNCATE-checkpoint cadence in
 * createDesktopPrisma. Proves the corrected gate fires `wal_checkpoint(TRUNCATE)`
 * at most once per WAL_TRUNCATE_INTERVAL_MS (the primary TIME floor — never MORE
 * than the base 5s-throttle rate), with the write-count as an AND term that can
 * only SUPPRESS a timer-eligible fire (a quiet interval holds its low-value
 * reclaim), and a WAL-frame ceiling that force-fires a runaway WAL only on a held
 * interval. Deterministic: an injected clock drives the time floor and an injected
 * probe drives the ceiling branch, so nothing here asserts on wall-clock timing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WAL_TRUNCATE_FRAME_CEILING,
  WAL_TRUNCATE_INTERVAL_MS,
  WAL_TRUNCATE_WRITE_COUNT,
} from "../src/main/database/connection-pragmas.js";
import type { CreateDesktopPrismaOptions } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// A no-op write that only settles the queue so the cadence advances — no row is
// needed, the time/count/ceiling gate is what is under test.
const noopWrite = () => Promise.resolve();

/** What a cadence test drives: one write at a time, plus teardown. */
type CadenceHarness = {
  /**
   * Issue one write and resolve only once the maintenance pass that write
   * triggered has fully SETTLED — gate decision, any awaited WAL-size probe, and
   * any TRUNCATE dispatch. Synchronizing on the cadence's own
   * `onWalMaintenanceSettled` signal (rather than flushing a fixed number of
   * microtasks) is what makes these assertions deterministic: the maintenance
   * continuation is chained off the write's promise and awaits the probe, so a
   * fixed tick count is a bounded poll that can land short and flake.
   */
  writeAndSettle: () => Promise<void>;
  close: () => Promise<void>;
};

/** Open the cadence under an injected clock/probe with the settle signal wired. */
async function openCadence(
  options: Omit<CreateDesktopPrismaOptions, "onWalMaintenanceSettled">
): Promise<CadenceHarness> {
  let settle: (() => void) | null = null;
  const opened = await openTestPrisma(undefined, {
    ...options,
    onWalMaintenanceSettled: () => {
      const resolve = settle;
      settle = null;
      resolve?.();
    },
  });
  return {
    writeAndSettle: async () => {
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      await opened.prisma.write(noopWrite);
      await settled;
    },
    close: opened.close,
  };
}

test("a burst of writes inside one interval fires AT MOST once (never per write, never per count-batch)", async () => {
  let truncates = 0;
  // Clock frozen at 0 so the time floor NEVER elapses within the burst. Under the
  // corrected gate the time floor is primary: with no elapsed time, NOTHING fires,
  // no matter how many writes land — even well past WAL_TRUNCATE_WRITE_COUNT. This
  // is the core ISS-4819 correction: the old `||` count term fired
  // floor(N / WAL_TRUNCATE_WRITE_COUNT) times here (MORE than the base 5s throttle
  // on a busy store); the AND gate fires ZERO.
  const { writeAndSettle, close } = await openCadence({
    now: () => 0,
    probeWalFrames: () => 0,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    const writeCount = WAL_TRUNCATE_WRITE_COUNT * 3;
    for (let i = 0; i < writeCount; i++) {
      await writeAndSettle();
    }
    // Time floor never elapsed → no reclaim at all. The base 5s throttle would also
    // fire 0 here; the corrected gate can never exceed it.
    assert.equal(truncates, 0);
  } finally {
    await close();
  }
});

test("once the interval elapses AND the write floor is met, exactly one TRUNCATE fires", async () => {
  let truncates = 0;
  let clock = 0;
  const { writeAndSettle, close } = await openCadence({
    now: () => clock,
    probeWalFrames: () => 0,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    // Accumulate the full write floor at t=0: no fire yet (time floor not elapsed).
    for (let i = 0; i < WAL_TRUNCATE_WRITE_COUNT; i++) {
      await writeAndSettle();
    }
    assert.equal(truncates, 0);
    // Advance past the interval, then one more write: both floors are now met, so
    // the TRUNCATE fires exactly once and the write counter resets.
    clock = WAL_TRUNCATE_INTERVAL_MS;
    await writeAndSettle();
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});

test("an elapsed interval with FEWER than the write floor HOLDS the reclaim (no TRUNCATE)", async () => {
  let truncates = 0;
  // Clock already past the interval so the TIME floor is satisfied on the first
  // write; the WAL is well under the ceiling. The corrected gate must HOLD — the
  // write floor is short, so this low-value reclaim is dropped. A pure 5s timer
  // (the base, and the pre-ISS-4819 `||` term) would have fired here; suppressing
  // it is exactly how the corrected gate reduces tax below the base rate.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => 0,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    // A handful of writes, far below WAL_TRUNCATE_WRITE_COUNT.
    for (let i = 0; i < 3; i++) {
      await writeAndSettle();
    }
    assert.equal(truncates, 0);
  } finally {
    await close();
  }
});

test("on a HELD interval, a WAL over the ceiling force-fires a TRUNCATE (memory backstop)", async () => {
  let truncates = 0;
  // Time floor satisfied (clock past the interval) but only a few writes, so the
  // gate would HOLD — except the probe reports OVER the ceiling, so the safety
  // backstop forces the reclaim. This is the ONLY off-floor trigger.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => WAL_TRUNCATE_FRAME_CEILING + 1,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    await writeAndSettle();
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});

test("an interval that HOLDS and then meets the write floor still fires exactly ONE TRUNCATE", async () => {
  let truncates = 0;
  let sizeReads = 0;
  // The codex-review case, and the reason the WAL-depth signal must not be a
  // checkpoint. The clock is pinned one interval in the future so the TIME floor is
  // satisfied on EVERY write, but the write floor stays short until the 64th — so
  // the gate HOLDS 63 times (consulting the size signal each time) and then fires on
  // the 64th, all inside ONE interval. When the signal was a
  // `wal_checkpoint(PASSIVE)` that window cost N passive checkpoints PLUS the
  // TRUNCATE; the base 5s throttle would have done exactly one checkpoint
  // operation. Because the signal is now a `-wal` file stat (zero SQLite work), the
  // held reads are free and the window's checkpoint count is exactly ONE — the
  // fewer-or-equal bound the cadence claims.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => {
      sizeReads += 1;
      return 0;
    },
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    for (let i = 0; i < WAL_TRUNCATE_WRITE_COUNT; i++) {
      await writeAndSettle();
    }
    // Exactly one checkpoint operation in the whole 5s window — not one per held
    // write, and not a probe/TRUNCATE pair.
    assert.equal(truncates, 1);
    // The free size signal WAS consulted on the held writes (it is what kept the
    // ceiling backstop live); it is simply not a checkpoint.
    assert.ok(sizeReads > 1);
  } finally {
    await close();
  }
});

test("a WAL probe UNDER the ceiling on a held interval does NOT force a TRUNCATE", async () => {
  let truncates = 0;
  // Held interval (few writes), probe reports AT the ceiling (not over) — the
  // strict `>` means this must NOT fire. Guards that the ceiling test above fires
  // for the ceiling reason, not because any probe result forces.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => WAL_TRUNCATE_FRAME_CEILING,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    await writeAndSettle();
    assert.equal(truncates, 0);
  } finally {
    await close();
  }
});

test("a THROWN WAL-depth read also falls back to the base timer TRUNCATE", async () => {
  let truncates = 0;
  // Same contract as a malformed read, via the other failure mode: the read itself
  // throws (a stat error that is not "file absent"). An error is not evidence that
  // the WAL is small, so the cadence must not silently drop the reclaim. This is
  // the case that stranded a large FINAL transaction: it would get no timer
  // TRUNCATE and no retry, because no further write was coming to trigger one.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => {
      throw new Error("stat failed");
    },
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    await writeAndSettle();
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});

test("a WAL that crosses the ceiling later in the SAME interval force-fires without waiting", async () => {
  let truncates = 0;
  let frames = 0;
  // The hold decision is RE-TAKEN on every write past the time floor, because the
  // depth read is free. Previously the first held write consumed the interval's
  // probe budget, so a WAL that ballooned immediately afterwards went unnoticed for
  // a whole further interval — the backstop was blind exactly when it mattered, and
  // if no further write arrived it never retried at all. Here the first write holds
  // (WAL empty) and the second, still inside the same frozen interval, must
  // force-fire once the WAL is over the ceiling.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => frames,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    await writeAndSettle();
    assert.equal(truncates, 0);
    frames = WAL_TRUNCATE_FRAME_CEILING + 1;
    await writeAndSettle();
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});

test("an UNKNOWN WAL depth on a held interval falls back to the base timer TRUNCATE", async () => {
  let truncates = 0;
  // Held interval, and the depth read yields a non-numeric value → UNKNOWN. A
  // failed read is NOT evidence that the WAL is under the ceiling, so the hold is
  // not justified: the cadence falls back to exactly what the base 5s throttle did
  // at this point and fires the timer TRUNCATE. Suppressing it instead would leave
  // a large FINAL transaction with no reclaim at all and no retry unless another
  // write happened to arrive. Firing here can never exceed the base rate — the base
  // fired unconditionally on every elapsed interval.
  const { writeAndSettle, close } = await openCadence({
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames: () => Number.NaN,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    await writeAndSettle();
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});

test("a BACKWARD clock step does not wedge the cadence: the count floor still fires", async () => {
  let truncates = 0;
  let clock = 0;
  const { writeAndSettle, close } = await openCadence({
    now: () => clock,
    probeWalFrames: () => 0,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    // Fire once at an elapsed interval so a stamp exists in the cadence.
    for (let i = 0; i < WAL_TRUNCATE_WRITE_COUNT; i++) {
      await writeAndSettle();
    }
    clock = WAL_TRUNCATE_INTERVAL_MS;
    await writeAndSettle();
    assert.equal(truncates, 1);
    // Now the clock steps BACKWARD by far more than the interval (an NTP
    // correction / system-clock change under a wall clock). Without explicit
    // recovery every subsequent `now() - lastWalTruncateAt` is negative, so the
    // primary time floor never opens and the cadence goes dark — the count floor
    // and the WAL-size backstop are both behind that floor, so a full backfill
    // burst would reclaim NOTHING until wall time caught back up. With recovery
    // the stale future stamp is re-anchored and the count floor fires normally.
    clock = -(WAL_TRUNCATE_INTERVAL_MS * 10);
    for (let i = 0; i < WAL_TRUNCATE_WRITE_COUNT; i++) {
      await writeAndSettle();
    }
    assert.equal(truncates, 2);
  } finally {
    await close();
  }
});

test("a BACKWARD clock step does not wedge the WAL-size backstop", async () => {
  let truncates = 0;
  let clock = 0;
  // The WAL is over the ceiling the whole time, so the size backstop is the only
  // thing that can fire (writes stay far below the count floor). It must survive a
  // clock regression — this is the runaway-WAL memory bound, and it must never be
  // suppressed by a clock the cadence does not control.
  const { writeAndSettle, close } = await openCadence({
    now: () => clock,
    probeWalFrames: () => WAL_TRUNCATE_FRAME_CEILING + 1,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    clock = WAL_TRUNCATE_INTERVAL_MS;
    await writeAndSettle();
    assert.equal(truncates, 1);
    clock = -(WAL_TRUNCATE_INTERVAL_MS * 10);
    await writeAndSettle();
    assert.equal(truncates, 2);
  } finally {
    await close();
  }
});

test("after a fire the write counter resets, so the next interval must re-accumulate the floor", async () => {
  let truncates = 0;
  let clock = 0;
  const { writeAndSettle, close } = await openCadence({
    now: () => clock,
    probeWalFrames: () => 0,
    onWalTruncate: () => {
      truncates += 1;
    },
  });
  try {
    // Fill the floor at t=0 (no fire), advance the clock, one more write → fire once.
    for (let i = 0; i < WAL_TRUNCATE_WRITE_COUNT; i++) {
      await writeAndSettle();
    }
    clock = WAL_TRUNCATE_INTERVAL_MS;
    await writeAndSettle();
    assert.equal(truncates, 1);
    // Advance the clock again but issue only a few writes: the counter reset at the
    // fire, so the write floor is short → the second interval HOLDS. Proves the
    // count floor genuinely gates the timer (it is an AND, not a no-op).
    clock = WAL_TRUNCATE_INTERVAL_MS * 2;
    for (let i = 0; i < 3; i++) {
      await writeAndSettle();
    }
    assert.equal(truncates, 1);
  } finally {
    await close();
  }
});
