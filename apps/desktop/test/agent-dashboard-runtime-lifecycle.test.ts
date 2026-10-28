/**
 * @file agent-dashboard-runtime-lifecycle.test.ts
 * @description ISS-6713 — the Agent Dashboard runtime's start/stop/beginClosing/
 * close state machine, executed directly.
 *
 * Every assertion here drives a TRANSITION and observes what the next call is
 * allowed to do, because the contract is ordering and absence, not "each method
 * ran". A suite that calls `beginClosing()` then `close()` and checks both
 * completed passes with the order inverted and passes with `close()` draining
 * twice; those are exactly the shutdown defects that matter, so each one has an
 * assertion that goes red on it specifically.
 *
 * The db-host side of shutdown — whether a child `exit` inside or outside the
 * intentional-shutdown window classifies as expected, and whether it restarts —
 * belongs to `DbHostClient` and is already driven through a real fake child by
 * `db-host-shutdown-cascade.test.ts` and `db-host-unexpected-exit-telemetry.test.ts`.
 * What was untested is the layer above: that the runtime opens that window and
 * drains the child at the right moments, and exactly once.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createAgentDashboardRuntimeLifecycle } from "../src/main/dashboard/agent-dashboard-runtime-lifecycle.js";

const Step = {
  BeginClosing: "db-host:beginClosing",
  Teardown: "runtime:teardown",
  DbHostClose: "db-host:close",
} as const;
type Step = (typeof Step)[keyof typeof Step];

function createHarness(
  options: { teardownError?: Error; drainError?: Error } = {}
) {
  const calls: Step[] = [];
  const lifecycle = createAgentDashboardRuntimeLifecycle({
    beginClosing: () => {
      calls.push(Step.BeginClosing);
    },
    close: () => {
      calls.push(Step.DbHostClose);
      return options.drainError
        ? Promise.reject(options.drainError)
        : Promise.resolve();
    },
  });
  const teardown = () => {
    calls.push(Step.Teardown);
    return options.teardownError
      ? Promise.reject(options.teardownError)
      : Promise.resolve();
  };
  return { calls, lifecycle, teardown };
}

describe("agent dashboard runtime lifecycle — shutdown", () => {
  test("close() drains the db host AFTER the runtime teardown, not before", async () => {
    const { calls, lifecycle, teardown } = createHarness();

    lifecycle.beginClosing();
    await lifecycle.close(teardown);

    // The whole sequence, not membership: every step is present under any
    // ordering, and the ordering is the entire subject. beginClosing behind the
    // teardown would let the capture services' own db-host writes die as an
    // "exited unexpectedly"; the drain ahead of the teardown would kill the
    // child while those writes were still in flight.
    assert.deepEqual(calls, [
      Step.BeginClosing,
      Step.Teardown,
      Step.DbHostClose,
    ]);
  });

  test("close() without a preceding beginClosing() still tears down and drains", async () => {
    const { calls, lifecycle, teardown } = createHarness();

    // The path that actually breaks: a crash quit, an update handoff, or a
    // teardown step that threw before the app reached beginClosing(). The
    // runtime must not make the drain conditional on a signal that never came.
    await lifecycle.close(teardown);

    assert.deepEqual(calls, [Step.Teardown, Step.DbHostClose]);
  });

  test("a second close() runs neither the teardown nor the drain again", async () => {
    const { calls, lifecycle, teardown } = createHarness();

    await lifecycle.close(teardown);
    await lifecycle.close(teardown);

    assert.deepEqual(
      calls,
      [Step.Teardown, Step.DbHostClose],
      "a re-entrant close must not double-drain the db host"
    );
    assert.equal(
      lifecycle.isClosed(),
      true,
      "and the runtime reports itself closed — the one gate every background task, scheduler start and collector restart in the runtime re-checks"
    );
  });

  test("a close() racing an in-flight close() does not start a second teardown", async () => {
    const calls: Step[] = [];
    let releaseTeardown = (): void => {
      throw new Error("the teardown was never entered");
    };
    const lifecycle = createAgentDashboardRuntimeLifecycle({
      beginClosing: () => calls.push(Step.BeginClosing),
      close: () => {
        calls.push(Step.DbHostClose);
        return Promise.resolve();
      },
    });
    const teardown = () =>
      new Promise<void>((resolve) => {
        calls.push(Step.Teardown);
        releaseTeardown = resolve;
      });

    // `closed` is set synchronously, before the first await — a second quit
    // arriving while the drain is still in flight must be refused there, not by
    // a flag that only flips once the first close finishes.
    const first = lifecycle.close(teardown);
    const second = lifecycle.close(teardown);
    assert.deepEqual(calls, [Step.Teardown]);
    releaseTeardown();
    await Promise.all([first, second]);

    assert.deepEqual(calls, [Step.Teardown, Step.DbHostClose]);
  });

  test("a rejecting teardown still drains the db host, and still reaches the caller", async () => {
    const teardownError = new Error("collector teardown exploded");
    const { calls, lifecycle, teardown } = createHarness({ teardownError });

    await assert.rejects(lifecycle.close(teardown), {
      message: teardownError.message,
    });

    // ISS-7009: the drain sat behind an unguarded `await teardown()`, so one
    // rejecting step left the db-host child running — permanently, because
    // `closed` is set before that await and every later close() therefore
    // no-ops. The rejection still has to reach the caller: the before-quit
    // handler is what reports it (`shutdown-rejected`), and swallowing it here
    // would trade an undrained child for a quit that claims it went clean.
    assert.deepEqual(calls, [Step.Teardown, Step.DbHostClose]);
  });

  test("a close() behind that rejection stays a no-op — the drain already ran", async () => {
    const { calls, lifecycle, teardown } = createHarness({
      teardownError: new Error("collector teardown exploded"),
    });
    await assert.rejects(lifecycle.close(teardown));

    await lifecycle.close(teardown);

    // The other half of the fix: the drain is reached WITHOUT reopening the
    // runtime. Clearing `closed` on a failed teardown would drain here too, and
    // would also let a second quit start a second teardown mid-flight — the
    // race the close-guard exists to refuse.
    assert.deepEqual(calls, [Step.Teardown, Step.DbHostClose]);
    assert.equal(lifecycle.isClosed(), true);
  });

  test("when the drain fails too, BOTH causes reach the caller", async () => {
    const teardownError = new Error("collector teardown exploded");
    const drainError = new Error("db host would not drain");
    const { lifecycle, teardown } = createHarness({
      teardownError,
      drainError,
    });

    const raised = await lifecycle.close(teardown).then(
      () => null,
      (error: unknown) => error
    );

    // A bare `finally` around the drain passes every other case in this file
    // and still fails here: the drain's rejection replaces the teardown's, and
    // shutdown reports ONE message, so the likelier root cause is the one that
    // disappears from the report.
    assert.ok(raised instanceof AggregateError);
    assert.deepEqual(raised.errors, [teardownError, drainError]);
    // The message, not just `errors`: shutdown telemetry reports `err.message`,
    // so a cause that only survives in the array never reaches the monitor.
    assert.ok(raised.message.includes(teardownError.message));
    assert.ok(raised.message.includes(drainError.message));
  });

  test("a drain that fails on its own propagates unwrapped", async () => {
    const drainError = new Error("db host would not drain");
    const { calls, lifecycle, teardown } = createHarness({ drainError });

    // Positive sibling for the case above: the AggregateError is reserved for a
    // genuine double failure, so a lone drain error is not rewrapped and the
    // caller's existing `err.message` read still names it.
    await assert.rejects(lifecycle.close(teardown), {
      message: drainError.message,
    });

    assert.deepEqual(calls, [Step.Teardown, Step.DbHostClose]);
  });

  test("beginClosing() twice opens the window twice and closes nothing", () => {
    const { calls, lifecycle } = createHarness();

    lifecycle.beginClosing();
    lifecycle.beginClosing();

    // Idempotency is DbHostClient's (`closing = true` twice is one window), so
    // what this pins is that the runtime forwards and does nothing else — a
    // beginClosing that also drained would kill the child before the capture
    // teardown that still writes to it.
    assert.deepEqual(calls, [Step.BeginClosing, Step.BeginClosing]);
    assert.equal(
      lifecycle.isClosed(),
      false,
      "beginClosing only opens the shutdown window; the runtime is still live"
    );
  });

  test("beginClosing() after close() still only forwards", async () => {
    const { calls, lifecycle, teardown } = createHarness();

    await lifecycle.close(teardown);
    lifecycle.beginClosing();

    assert.deepEqual(calls, [
      Step.Teardown,
      Step.DbHostClose,
      Step.BeginClosing,
    ]);
  });
});

describe("agent dashboard runtime lifecycle — start/stop", () => {
  test("start installs one attempt and every later caller joins it", () => {
    const { lifecycle } = createHarness();
    let begins = 0;
    const begin = () => {
      begins += 1;
      return Promise.resolve();
    };

    const first = lifecycle.ensureStarted(begin);
    const second = lifecycle.ensureStarted(begin);

    assert.equal(begins, 1, "a second start must not bind a second listener");
    assert.equal(second, first, "and must hand back the in-flight attempt");
    assert.equal(lifecycle.isCurrentStart(first), true);
  });

  test("stop() discards the in-flight start so its continuation goes stale", () => {
    const { lifecycle } = createHarness();
    const started = lifecycle.ensureStarted(() => Promise.resolve());

    assert.equal(lifecycle.beginStop(), true);

    // The load-bearing branch. `isClosed()` is still false after a stop, so a
    // continuation gated only on "am I closed?" would start the collectors under
    // a runtime whose listeners were just torn down. Identity is what sees it.
    assert.equal(lifecycle.isClosed(), false);
    assert.equal(
      lifecycle.isCurrentStart(started),
      false,
      "the start a stop() discarded must not be recognised as current"
    );
  });

  test("a start after a stop is a NEW attempt, and the old one stays stale", () => {
    const { lifecycle } = createHarness();
    const first = lifecycle.ensureStarted(() => Promise.resolve());
    lifecycle.beginStop();

    const second = lifecycle.ensureStarted(() => Promise.resolve());

    assert.notEqual(second, first);
    assert.equal(lifecycle.isCurrentStart(second), true);
    assert.equal(
      lifecycle.isCurrentStart(first),
      false,
      "a superseded start must never re-arm the collectors"
    );
  });

  test("stop() before any start is allowed and starts nothing", () => {
    const { calls, lifecycle } = createHarness();

    assert.equal(lifecycle.beginStop(), true);

    assert.deepEqual(calls, []);
    assert.equal(lifecycle.isClosed(), false);
  });

  test("stop() after close() is refused, so its teardown never runs", async () => {
    const { lifecycle, teardown } = createHarness();
    await lifecycle.close(teardown);

    assert.equal(
      lifecycle.beginStop(),
      false,
      "a stop arriving behind a completed close must no-op, not re-run the teardown"
    );
  });

  test("start after close() never invokes begin", async () => {
    const { lifecycle, teardown } = createHarness();
    await lifecycle.close(teardown);
    let begins = 0;

    const started = lifecycle.ensureStarted(() => {
      begins += 1;
      return Promise.resolve();
    });
    await started;

    assert.equal(
      begins,
      0,
      "no listener may be bound behind a completed teardown"
    );
    assert.equal(
      lifecycle.isCurrentStart(started),
      false,
      "and the resolved stand-in must not read as a live start"
    );
  });
});
