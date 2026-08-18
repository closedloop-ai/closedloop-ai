/**
 * ISS-6079: the bounded read lane holds a permit back for interactive work, so a
 * corpus-scale cloud-sync hydration can never occupy the whole lane while a
 * Sessions page read waits behind it.
 *
 * Two mechanisms, and both are needed — the tests below fail if either is
 * removed:
 *   - a CAP: background ops may hold at most `limit - 1` permits;
 *   - a PRIORITY RELEASE: a freed permit goes to a waiting interactive op ahead
 *     of an earlier-queued background one. Without this the original single FIFO
 *     would still hand the permit to whoever queued first, which is how a sync
 *     batch took a permit a page read was already waiting on.
 *
 * Everything here is driven by explicit deferreds rather than the clock: the
 * repo bans real-clock timing assertions, and "did this op start" is a fact
 * about admission, not about elapsed time.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBoundedOpLane } from "../src/main/database/db-host/heavy-op-gate.js";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => {
    // replaced synchronously by the executor below
  };
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every already-queued microtask/timer callback run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BACKGROUND = { background: true };

describe("bounded read lane — interactive permit reservation (ISS-6079)", () => {
  it("counts queued BACKGROUND waiters in the lane occupancy row", async () => {
    // The occupancy row is what separates "this op was slow" from "this op
    // waited". ISS-6079 split the single FIFO in two, so a row counting only the
    // interactive queue reports ZERO waiters on a lane whose background queue is
    // backed up — inverting the signal the planned soak depends on.
    const lane = createBoundedOpLane({ limit: 2 });
    const held = deferred();
    const secondHeld = deferred();

    // Width 2, so the cap admits ONE background op; the next two queue on
    // `waitingBackground` and nothing reaches the interactive queue at all.
    const running = lane.runBounded(() => held.promise, undefined, BACKGROUND);
    await drain();
    const queuedA = lane.runBounded(
      () => secondHeld.promise,
      undefined,
      BACKGROUND
    );
    const queuedB = lane.runBounded(
      async () => undefined,
      undefined,
      BACKGROUND
    );
    await drain();

    // A probe arriving now must SEE those two queued background ops.
    let probeWaitingOnArrival = -1;
    const probe = lane.runBounded(
      async () => undefined,
      (timing) => {
        probeWaitingOnArrival = timing.waitingOnArrival;
      },
      BACKGROUND
    );
    await drain();

    held.resolve();
    secondHeld.resolve();
    await Promise.all([running, queuedA, queuedB, probe]);

    assert.equal(
      probeWaitingOnArrival,
      2,
      `expected both queued background waiters counted, saw ${probeWaitingOnArrival}`
    );
  });

  it("holds a permit back: two background ops cannot both run at width 2", async () => {
    const lane = createBoundedOpLane({ limit: 2 });
    const first = deferred();
    const second = deferred();
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = lane.runBounded(
      async () => {
        firstStarted = true;
        await first.promise;
      },
      undefined,
      BACKGROUND
    );
    const secondRun = lane.runBounded(
      async () => {
        secondStarted = true;
        await second.promise;
      },
      undefined,
      BACKGROUND
    );

    await drain();
    assert.equal(firstStarted, true, "the first background op runs");
    assert.equal(
      secondStarted,
      false,
      "the second background op is held: one permit is reserved for interactive work"
    );

    first.resolve();
    await firstRun;
    await drain();
    assert.equal(
      secondStarted,
      true,
      "the held background op runs once the first releases — held, not starved"
    );
    second.resolve();
    await secondRun;
  });

  it("admits an interactive read immediately while background work is in flight", async () => {
    const lane = createBoundedOpLane({ limit: 2 });
    const background = deferred();
    const interactive = deferred();
    let interactiveStarted = false;

    const backgroundRun = lane.runBounded(
      () => background.promise,
      undefined,
      BACKGROUND
    );
    await drain();

    const interactiveRun = lane.runBounded(async () => {
      interactiveStarted = true;
      await interactive.promise;
    });
    await drain();

    assert.equal(
      interactiveStarted,
      true,
      "the interactive read starts without waiting for the background op"
    );

    interactive.resolve();
    background.resolve();
    await Promise.all([interactiveRun, backgroundRun]);
  });

  it("gives a freed permit to a waiting interactive op ahead of an earlier-queued background op", async () => {
    const lane = createBoundedOpLane({ limit: 2 });
    const holdA = deferred();
    const holdB = deferred();
    const started: string[] = [];

    // Fill both permits with interactive work.
    const runA = lane.runBounded(async () => {
      started.push("a");
      await holdA.promise;
    });
    const runB = lane.runBounded(async () => {
      started.push("b");
      await holdB.promise;
    });
    await drain();
    assert.deepEqual(started, ["a", "b"], "both permits are held");

    // Background queues FIRST, interactive SECOND. A single FIFO would run the
    // background op next; the priority release must not.
    const queuedBackground = deferred();
    const queuedInteractive = deferred();
    const backgroundRun = lane.runBounded(
      async () => {
        started.push("background");
        await queuedBackground.promise;
      },
      undefined,
      BACKGROUND
    );
    const interactiveRun = lane.runBounded(async () => {
      started.push("interactive");
      await queuedInteractive.promise;
    });
    await drain();
    assert.deepEqual(started, ["a", "b"], "both newcomers are queued");

    holdA.resolve();
    await runA;
    await drain();

    assert.deepEqual(
      started,
      ["a", "b", "interactive"],
      "the freed permit went to the interactive op, not the earlier-queued background one"
    );

    queuedInteractive.resolve();
    holdB.resolve();
    await Promise.all([runB, interactiveRun]);
    await drain();
    queuedBackground.resolve();
    await backgroundRun;
  });

  it("treats an absent flag as interactive, so the lane's full width is still usable", async () => {
    const lane = createBoundedOpLane({ limit: 2 });
    const first = deferred();
    const second = deferred();
    let secondStarted = false;

    // No options at all — the pre-ISS-6079 call shape.
    const firstRun = lane.runBounded(() => first.promise);
    const secondRun = lane.runBounded(async () => {
      secondStarted = true;
      await second.promise;
    });
    await drain();

    assert.equal(
      secondStarted,
      true,
      "two unflagged ops still occupy both permits — the default is interactive, not background"
    );

    first.resolve();
    second.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it("does not starve background work at the degenerate width 1", async () => {
    // `limit - 1` would be 0 here, which would mean background work could never
    // run at all. The cap falls back to the full width instead.
    const lane = createBoundedOpLane({ limit: 1 });
    let ran = false;

    await lane.runBounded(
      () => {
        ran = true;
        return Promise.resolve();
      },
      undefined,
      BACKGROUND
    );

    assert.equal(ran, true, "a background op still runs on a width-1 lane");
  });

  it("releases a queued background op even when the lane drains through interactive traffic", async () => {
    // Regression guard for the lost-wakeup this reservation can produce: the
    // release path TRANSFERS an outstanding permit, so a background waiter must
    // be resumed on the background op's own release rather than being stranded
    // until some unrelated release happens to run.
    const lane = createBoundedOpLane({ limit: 2 });
    const runningBackground = deferred();
    const queuedBackground = deferred();
    let queuedStarted = false;

    const firstRun = lane.runBounded(
      () => runningBackground.promise,
      undefined,
      BACKGROUND
    );
    await drain();

    const secondRun = lane.runBounded(
      async () => {
        queuedStarted = true;
        await queuedBackground.promise;
      },
      undefined,
      BACKGROUND
    );
    await drain();
    assert.equal(
      queuedStarted,
      false,
      "the second background op is capped out"
    );

    // Interactive traffic comes and goes without touching the background cap.
    await lane.runBounded(() => Promise.resolve());
    await drain();
    assert.equal(
      queuedStarted,
      false,
      "an interactive op's release must not hand a permit to a capped-out background waiter"
    );

    runningBackground.resolve();
    await firstRun;
    await drain();
    assert.equal(
      queuedStarted,
      true,
      "the background op's own release wakes the queued one"
    );

    queuedBackground.resolve();
    await secondRun;
  });
});
