/**
 * @file dispatch.test.ts
 * @description `createDispatch` — the router that turns a due task into a run
 * (ISS-5296). Its job is to pick between an injected orchestration runner, the
 * built-in custom-prompt cascade, and an honest failure, and to report a cascade's
 * outcome without ever dressing a failure up as a success.
 */
import { describe, expect, it } from "vitest";
import { createDispatch } from "../src/dispatch.js";
import { PassKind, RunStatus, type ScheduledTask } from "../src/model.js";
import type {
  DispatchContext,
  DispatchOutcome,
} from "../src/scheduler/daemon.js";
import { mockHarness, registry, res } from "./helpers/harness-fixtures.js";

const ctx: DispatchContext = {
  defaultCascade: [{ harness: "codex" }],
  log: () => {
    // The router's logging is not the contract under test.
  },
};

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "nightly",
    cron: "0 3 * * *",
    kind: PassKind.Custom,
    prompt: "do the thing",
    harnessCascade: [],
    enabled: true,
    recurring: true,
    durable: true,
    catchUp: true,
    timezone: "",
    meta: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as ScheduledTask;
}

describe("createDispatch routing", () => {
  it("prefers an orchestration runner registered for the task's kind", async () => {
    const outcome: DispatchOutcome = {
      status: RunStatus.Success,
      harnessUsed: null,
      attempts: [],
      summary: "review pass ran",
      error: null,
    };
    let seen: ScheduledTask | undefined;
    const dispatch = createDispatch({
      orchestration: {
        [PassKind.Review]: (t) => {
          seen = t;
          return Promise.resolve(outcome);
        },
      },
    });

    const result = await dispatch(task({ kind: PassKind.Review }), ctx);

    expect(result).toBe(outcome);
    expect(seen?.id).toBe("t1");
  });

  it("fails a non-custom kind with NO registered runner instead of silently succeeding", async () => {
    // A review task on a daemon whose orchestration was never wired must record a
    // failed run naming the gap — reporting success would hide a scheduler that
    // executes nothing.
    const dispatch = createDispatch({ orchestration: {} });

    const result = await dispatch(task({ kind: PassKind.Review }), ctx);

    expect(result.status).toBe(RunStatus.Failed);
    expect(result.harnessUsed).toBeNull();
    expect(result.summary).toContain("orchestration not wired");
    expect(result.error).toContain(PassKind.Review);
  });

  it("routes a custom task through the cascade when no runner is registered", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex }) });

    const result = await dispatch(task(), ctx);

    expect(result.status).toBe(RunStatus.Success);
    expect(codex.calls()).toBe(1);
  });

  it("a runner registered for a DIFFERENT kind does not capture a custom task", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({
      orchestration: {
        [PassKind.Review]: () =>
          Promise.reject(new Error("review runner must not be called")),
      },
      registry: registry({ codex }),
    });

    const result = await dispatch(task({ kind: PassKind.Custom }), ctx);

    expect(result.status).toBe(RunStatus.Success);
    expect(codex.calls()).toBe(1);
  });

  it("dispatches with no deps at all", async () => {
    // `createDispatch()` with an empty deps object must still route; an
    // unwired kind is the honest failure, not a crash.
    const dispatch = createDispatch();

    const result = await dispatch(task({ kind: PassKind.Review }), ctx);

    expect(result.status).toBe(RunStatus.Failed);
  });
});

describe("createDispatch custom-task cascade outcome", () => {
  it("reports a success with the harness that ran and a NULL error", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex }) });

    const result = await dispatch(task(), ctx);

    expect(result.status).toBe(RunStatus.Success);
    expect(result.harnessUsed).toBe("codex");
    expect(result.summary).toBe("ran via codex");
    expect(result.error).toBeNull();
  });

  it("reports an exhausted cascade with a non-null error, not a bare failure", async () => {
    // `summary` and `error` carry DIFFERENT strings; asserting only one would let
    // the other drift.
    const dispatch = createDispatch({ registry: registry() });

    const result = await dispatch(task(), ctx);

    expect(result.status).toBe(RunStatus.Failed);
    expect(result.harnessUsed).toBeNull();
    expect(result.summary).toBe("all harnesses in cascade failed");
    expect(result.error).toBe("cascade exhausted");
  });

  it("prefers the task's own cascade over the daemon default", async () => {
    // A per-task cascade may pin a model; the daemon default must not override it.
    const codex = mockHarness("codex", [res({ ok: false })]);
    const claude = mockHarness("claude", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex, claude }) });

    const result = await dispatch(
      task({ harnessCascade: [{ harness: "claude", model: "opus" }] }),
      ctx
    );

    expect(result.harnessUsed).toBe("claude");
    expect(claude.runOpts()[0]?.model).toBe("opus");
    expect(codex.calls()).toBe(0);
  });

  it("falls back to the daemon default cascade when the task carries none", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const claude = mockHarness("claude", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex, claude }) });

    const result = await dispatch(task({ harnessCascade: [] }), {
      ...ctx,
      defaultCascade: [{ harness: "claude" }],
    });

    expect(result.harnessUsed).toBe("claude");
    expect(codex.calls()).toBe(0);
  });

  it("runs in the task's meta.cwd when it is a string", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex }) });

    await dispatch(task({ meta: { cwd: "/some/repo" } }), ctx);

    expect(codex.runOpts()[0]?.cwd).toBe("/some/repo");
  });

  it("ignores a non-string meta.cwd and runs in the process cwd", async () => {
    // `meta` is free-form persisted JSON, so a number/object can reach here from a
    // hand-edited store. Passing it through would spawn the harness against a
    // garbage path.
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({ registry: registry({ codex }) });

    await dispatch(task({ meta: { cwd: 42 } }), ctx);

    expect(codex.runOpts()[0]?.cwd).toBe(process.cwd());
  });

  it("threads the per-attempt timeout into the harness", async () => {
    const codex = mockHarness("codex", [res({ ok: true, exitCode: 0 })]);
    const dispatch = createDispatch({
      registry: registry({ codex }),
      perAttemptTimeoutMs: 1234,
    });

    await dispatch(task(), ctx);

    expect(codex.runOpts()[0]?.timeoutMs).toBe(1234);
  });
});
