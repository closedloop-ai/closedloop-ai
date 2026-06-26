import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleUncaughtException,
  handleUnhandledRejection,
} from "../src/main/error-handlers.js";

function createStubDeps(): {
  log: (msg: string) => void;
  exit: (code: number) => void;
  emitException: (error: unknown) => void;
  calls: Record<string, unknown[][]>;
  order: string[];
} {
  const calls: Record<string, unknown[][]> = {};
  const order: string[] = [];
  const record = (name: string, ...args: unknown[]) => {
    order.push(name);
    calls[name] ??= [];
    calls[name].push(args);
  };

  return {
    calls,
    order,
    emitException: (error: unknown) => record("emitException", error),
    log: (msg: string) => record("log", msg),
    exit: (code: number) => record("exit", code),
  };
}

test("spawn ENOENT (code=ENOENT, syscall=spawn) -- log called, exit NOT called", () => {
  const deps = createStubDeps();
  const error = Object.assign(new Error("spawn enoent"), {
    code: "ENOENT",
    syscall: "spawn",
  });

  handleUncaughtException(error, deps);

  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.match(
    deps.calls.log[0][0] as string,
    /suppressed spawn ENOENT/,
    "log message should mention suppressed spawn ENOENT"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
  assert.ok(!deps.calls.emitException, "telemetry should NOT be called");
});

test("spawn ENOENT with syscall='spawn claude' (prefix match) -- suppressed, no exit", () => {
  const deps = createStubDeps();
  const error = Object.assign(new Error("spawn claude ENOENT"), {
    code: "ENOENT",
    syscall: "spawn claude",
  });

  handleUncaughtException(error, deps);

  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.match(deps.calls.log[0][0] as string, /suppressed spawn ENOENT/);
  assert.ok(!deps.calls.exit, "exit should NOT be called");
  assert.ok(!deps.calls.emitException, "telemetry should NOT be called");
});

test("generic Error with no code/syscall -- exit(1) called and log called", () => {
  const deps = createStubDeps();
  const error = new Error("something went wrong");

  handleUncaughtException(error, deps);

  assert.deepEqual(deps.order, ["emitException", "log", "exit"]);
  assert.deepEqual(deps.calls.emitException?.[0], [error]);
  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should be called"
  );
});

test("generic Error still exits when exception telemetry throws", () => {
  const deps = createStubDeps();
  const error = new Error("something went wrong");
  deps.emitException = () => {
    throw new Error("telemetry failed");
  };

  handleUncaughtException(error, deps);

  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should be called"
  );
});

test("ENOENT with syscall=open -- exit(1) IS called (not suppressed)", () => {
  const deps = createStubDeps();
  const error = Object.assign(new Error("open enoent"), {
    code: "ENOENT",
    syscall: "open",
  });

  handleUncaughtException(error, deps);

  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should be called"
  );
  assert.deepEqual(deps.calls.emitException?.[0], [error]);
});

test("handleUnhandledRejection with spawn ENOENT Error reason -- suppressed, no exit", () => {
  const deps = createStubDeps();
  const reason = Object.assign(new Error("spawn enoent rejection"), {
    code: "ENOENT",
    syscall: "spawn",
  });

  handleUnhandledRejection(reason, deps);

  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.match(
    deps.calls.log[0][0] as string,
    /suppressed spawn ENOENT/,
    "log message should mention suppressed spawn ENOENT"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
  assert.ok(!deps.calls.emitException, "telemetry should NOT be called");
});

test("handleUnhandledRejection with non-Error reason (plain string) -- does NOT throw", () => {
  const deps = createStubDeps();
  const reason = "some plain string reason";

  assert.doesNotThrow(() => {
    handleUnhandledRejection(reason, deps);
  });

  assert.deepEqual(deps.order, ["emitException", "log"]);
  assert.deepEqual(deps.calls.emitException?.[0], [reason]);
  assert.ok(
    deps.calls.log?.length > 0,
    "log should be called for non-Error reason"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
});

test("handleUnhandledRejection with non-Error object preserves non-exit behavior and attempts telemetry", () => {
  const deps = createStubDeps();
  const reason = { kind: "plain-object-rejection" };

  handleUnhandledRejection(reason, deps);

  assert.deepEqual(deps.order, ["emitException", "log"]);
  assert.deepEqual(deps.calls.emitException?.[0], [reason]);
  assert.ok(
    deps.calls.log?.length > 0,
    "log should be called for non-Error object reason"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
});

test("handleUnhandledRejection with non-ENOENT Error reason -- deps.exit(1) IS called (programming error preserved)", () => {
  const deps = createStubDeps();
  const reason = new Error("database connection failed");

  handleUnhandledRejection(reason, deps);

  assert.deepEqual(deps.order, ["emitException", "log", "exit"]);
  assert.deepEqual(deps.calls.emitException?.[0], [reason]);
  assert.ok(deps.calls.log?.length > 0, "log should be called");
  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should be called for non-ENOENT Error rejection"
  );
});
