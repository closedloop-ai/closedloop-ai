import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { type RetrySpawnDeps, retrySpawn } from "../src/main/spawn-retry.js";

function makeEnoentError(cmd: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${cmd} ENOENT`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function makeStubDeps(overrides?: Partial<RetrySpawnDeps>): RetrySpawnDeps & {
  calls: Record<string, unknown[][]>;
  shuttingDown: boolean;
} {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] ??= [];
    calls[name].push(args);
  };

  const state = {
    calls,
    shuttingDown: false,
    log: (level: string, msg: string) => record("log", level, msg),
    refreshTray: (msg?: string) => record("refreshTray", msg),
    isShuttingDown: () => state.shuttingDown,
    delay: async (ms: number) => {
      record("delay", ms);
    },
    ...overrides,
  };
  return state;
}

describe("retrySpawn", () => {
  test("fn succeeds on first attempt -- delay never called, refreshTray never called, result returned", async () => {
    const deps = makeStubDeps();
    const result = await retrySpawn(async () => "ok", deps);

    assert.equal(result, "ok");
    assert.ok(
      !deps.calls.delay,
      "delay should never be called on first-attempt success"
    );
    assert.ok(
      !deps.calls.refreshTray,
      "refreshTray should never be called on first-attempt success"
    );
  });

  test("fn fails on attempt 0, succeeds on attempt 1 -- delay called once with 200, refreshTray() called with no args", async () => {
    const deps = makeStubDeps();
    let attempt = 0;
    const result = await retrySpawn(async () => {
      if (attempt++ === 0) {
        throw makeEnoentError("myprog");
      }
      return "recovered";
    }, deps);

    assert.equal(result, "recovered");

    // delay called exactly once with 200
    assert.ok(deps.calls.delay, "delay should be called");
    assert.equal(
      deps.calls.delay.length,
      1,
      "delay should be called exactly once"
    );
    assert.equal(
      deps.calls.delay[0][0],
      200,
      "delay should be called with 200ms"
    );

    // refreshTray called with no args (undefined) to clear
    assert.ok(deps.calls.refreshTray, "refreshTray should be called");
    assert.equal(
      deps.calls.refreshTray.length,
      1,
      "refreshTray should be called exactly once"
    );
    assert.equal(
      deps.calls.refreshTray[0][0],
      undefined,
      "refreshTray should be called with no args to clear"
    );
  });

  test("fn fails all 3 attempts -- delay called twice (200 then 500), refreshTray called with error msg, original error rethrown", async () => {
    const deps = makeStubDeps();
    const originalError = makeEnoentError("myprog");

    await assert.rejects(
      () =>
        retrySpawn(async () => {
          throw originalError;
        }, deps),
      (err: unknown) => {
        assert.equal(err, originalError, "original error should be rethrown");
        return true;
      }
    );

    // delay called twice: 200 then 500
    assert.ok(deps.calls.delay, "delay should be called");
    assert.equal(
      deps.calls.delay.length,
      2,
      "delay should be called exactly twice"
    );
    assert.equal(deps.calls.delay[0][0], 200, "first delay should be 200ms");
    assert.equal(deps.calls.delay[1][0], 500, "second delay should be 500ms");

    // refreshTray called with error message
    assert.ok(deps.calls.refreshTray, "refreshTray should be called");
    assert.equal(
      deps.calls.refreshTray.length,
      1,
      "refreshTray should be called exactly once"
    );
    assert.equal(
      deps.calls.refreshTray[0][0],
      "Spawn failed -- please disconnect and reconnect",
      "refreshTray should be called with the failure message"
    );
  });

  test("non-ENOENT error is rethrown immediately without retry, without refreshTray", async () => {
    const deps = makeStubDeps();
    const nonEnoentError = new Error("EPERM: operation not permitted");
    let callCount = 0;

    await assert.rejects(
      () =>
        retrySpawn(async () => {
          callCount++;
          throw nonEnoentError;
        }, deps),
      (err: unknown) => {
        assert.equal(
          err,
          nonEnoentError,
          "original non-ENOENT error should be rethrown"
        );
        return true;
      }
    );

    // fn was called exactly once -- no retries for non-ENOENT errors
    assert.equal(
      callCount,
      1,
      "fn should only be called once for non-ENOENT errors"
    );

    // delay should never be called -- non-ENOENT errors are not retried
    assert.ok(
      !deps.calls.delay,
      "delay should not be called for non-ENOENT errors"
    );

    // refreshTray should never be called -- non-ENOENT errors skip tray update
    assert.ok(
      !deps.calls.refreshTray,
      "refreshTray should not be called for non-ENOENT errors"
    );
  });

  test("isShuttingDown() returns true before first retry -- delay not called, error rethrown immediately", async () => {
    const deps = makeStubDeps();
    // Set shuttingDown to true so the check before retry 1 fires
    deps.shuttingDown = true;

    const originalError = makeEnoentError("myprog");
    let attempt = 0;

    await assert.rejects(
      () =>
        retrySpawn(async () => {
          attempt++;
          throw originalError;
        }, deps),
      (err: unknown) => {
        assert.equal(err, originalError, "original error should be rethrown");
        return true;
      }
    );

    // fn was called exactly once (attempt 0), then isShuttingDown check short-circuits
    assert.equal(
      attempt,
      1,
      "fn should only be called once before shutting down aborts retries"
    );

    // delay should never be called because isShuttingDown() returns true before the delay
    assert.ok(
      !deps.calls.delay,
      "delay should not be called when shutting down"
    );
  });

  test("shutdown transitions from false to true between attempt 0 failure and attempt 1 -- fn called exactly once, delay never called", async () => {
    // Unlike test case 5 (shuttingDown=true from start), here isShuttingDown()
    // starts as false so attempt 0 runs normally, then transitions to true after
    // the first ENOENT failure.  The isShuttingDown() check fires before the
    // delay for attempt 1, so delay is never called and fn is called exactly once.
    const originalError = makeEnoentError("myprog");
    let callCount = 0;

    const deps = makeStubDeps({
      isShuttingDown: () => {
        // Return true only after the first fn call has already failed, simulating
        // shutdown being initiated during the ENOENT handling window.
        return callCount >= 1;
      },
    });

    await assert.rejects(
      () =>
        retrySpawn(async () => {
          callCount++;
          throw originalError;
        }, deps),
      (err: unknown) => {
        assert.equal(
          err,
          originalError,
          "original error should be rethrown when shutdown aborts retry"
        );
        return true;
      }
    );

    // fn was called exactly once -- attempt 0 ran, shutdown check before attempt 1 fired
    assert.equal(
      callCount,
      1,
      "fn should be called exactly once when shutdown transitions after attempt 0"
    );

    // delay should never be called -- isShuttingDown() short-circuits before deps.delay()
    assert.ok(
      !deps.calls.delay,
      "delay should never be called when shutdown transitions between attempt 0 and attempt 1"
    );
  });
});

// ---------------------------------------------------------------------------
// Structural wiring guard: retrySpawn must be imported in symphony-interactive.ts
// ---------------------------------------------------------------------------

test("retrySpawn is imported in symphony-interactive.ts -- guards against wiring drift", () => {
  const symphonyInteractivePath = path.resolve(
    import.meta.dirname ??
      path.join(path.dirname(new URL(import.meta.url).pathname)),
    "../src/server/operations/symphony-interactive.ts"
  );
  const source = readFileSync(symphonyInteractivePath, "utf-8");

  assert.ok(
    source.includes("retrySpawn"),
    "symphony-interactive.ts must import retrySpawn from spawn-retry (wiring drift detected)"
  );
  assert.ok(
    source.includes("spawn-retry"),
    "symphony-interactive.ts must reference spawn-retry module (wiring drift detected)"
  );
});
