import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CRASH_DIALOG_TITLE,
  formatCrashDialogBody,
  handleUncaughtException,
  handleUnhandledRejection,
  showStartupCrashDialog,
} from "../src/main/error-handlers.js";

function createRecorder(
  calls: Record<string, unknown[][]>,
  order: string[]
): (name: string, ...args: unknown[]) => void {
  return (name: string, ...args: unknown[]) => {
    order.push(name);
    calls[name] ??= [];
    calls[name].push(args);
  };
}

function createStubDeps(): {
  log: (msg: string) => void;
  exit: (code: number) => void;
  emitException: (error: unknown) => void;
  calls: Record<string, unknown[][]>;
  order: string[];
} {
  const calls: Record<string, unknown[][]> = {};
  const order: string[] = [];
  const record = createRecorder(calls, order);

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

function createStubDepsWithDialog(): ReturnType<typeof createStubDeps> & {
  showDialog: (title: string, body: string) => void;
  getLogFilePath: () => string;
} {
  const base = createStubDeps();
  const record = createRecorder(base.calls, base.order);
  return {
    ...base,
    showDialog: (title: string, body: string) =>
      record("showDialog", title, body),
    getLogFilePath: () => "/tmp/test-main.log",
  };
}

test("showDialog is called before exit(1) for generic uncaught Error", () => {
  const deps = createStubDepsWithDialog();
  const error = new Error("constructor blew up");

  handleUncaughtException(error, deps);

  assert.deepEqual(deps.order, ["emitException", "log", "showDialog", "exit"]);
  assert.equal(deps.calls.showDialog?.[0]?.[0], CRASH_DIALOG_TITLE);
  const dialogBody = deps.calls.showDialog?.[0]?.[1] as string;
  assert.ok(
    dialogBody.includes("constructor blew up"),
    "dialog body should include error message"
  );
  assert.ok(
    dialogBody.includes("/tmp/test-main.log"),
    "dialog body should include log file path"
  );
});

test("showDialog is NOT called for suppressed spawn ENOENT", () => {
  const deps = createStubDepsWithDialog();
  const error = Object.assign(new Error("spawn enoent"), {
    code: "ENOENT",
    syscall: "spawn",
  });

  handleUncaughtException(error, deps);

  assert.ok(!deps.calls.showDialog, "showDialog should NOT be called");
  assert.ok(!deps.calls.exit, "exit should NOT be called");
});

test("showDialog throwing does NOT prevent exit(1)", () => {
  const deps = createStubDepsWithDialog();
  deps.showDialog = () => {
    throw new Error("dialog.showErrorBox failed");
  };
  const error = new Error("boot crash");

  handleUncaughtException(error, deps);

  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should still be called when showDialog throws"
  );
});

test("showDialog is called for unhandled Error rejection (non-ENOENT)", () => {
  const deps = createStubDepsWithDialog();
  const reason = new Error("database connection failed");

  handleUnhandledRejection(reason, deps);

  assert.deepEqual(deps.order, ["emitException", "log", "showDialog", "exit"]);
  assert.equal(deps.calls.showDialog?.[0]?.[0], CRASH_DIALOG_TITLE);
  const dialogBody = deps.calls.showDialog?.[0]?.[1] as string;
  assert.ok(
    dialogBody.includes("database connection failed"),
    "dialog body should include error message"
  );
});

test("showDialog is NOT called for non-Error unhandled rejection", () => {
  const deps = createStubDepsWithDialog();

  handleUnhandledRejection("some string reason", deps);

  assert.ok(
    !deps.calls.showDialog,
    "showDialog should NOT be called for non-Error rejection"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
});

test("showDialog is NOT called for spawn ENOENT unhandled rejection", () => {
  const deps = createStubDepsWithDialog();
  const reason = Object.assign(new Error("spawn enoent"), {
    code: "ENOENT",
    syscall: "spawn",
  });

  handleUnhandledRejection(reason, deps);

  assert.ok(
    !deps.calls.showDialog,
    "showDialog should NOT be called for ENOENT rejection"
  );
  assert.ok(!deps.calls.exit, "exit should NOT be called");
});

test("getLogFilePath throwing does NOT prevent exit(1)", () => {
  const deps = createStubDepsWithDialog();
  deps.getLogFilePath = () => {
    throw new Error("electron-log not initialized");
  };
  const error = new Error("early crash");

  handleUncaughtException(error, deps);

  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should still be called when getLogFilePath throws"
  );
  assert.ok(
    deps.calls.showDialog?.length > 0,
    "showDialog should still be called"
  );
  const dialogBody = deps.calls.showDialog?.[0]?.[1] as string;
  assert.ok(
    dialogBody.includes("early crash"),
    "body should contain error message"
  );
  assert.ok(
    !dialogBody.includes("Details have been written to"),
    "body should omit log path section when getLogFilePath throws"
  );
});

test("showDialog present but getLogFilePath absent — dialog shown without log path", () => {
  const base = createStubDeps();
  const record = createRecorder(base.calls, base.order);
  const deps = {
    ...base,
    showDialog: (title: string, body: string) =>
      record("showDialog", title, body),
  };
  const error = new Error("no log path configured");

  handleUncaughtException(error, deps);

  assert.ok(deps.calls.showDialog?.length > 0, "showDialog should be called");
  const dialogBody = deps.calls.showDialog?.[0]?.[1] as string;
  assert.ok(
    dialogBody.includes("no log path configured"),
    "body should include error message"
  );
  assert.ok(
    !dialogBody.includes("Details have been written to"),
    "body should omit log path section when getLogFilePath is undefined"
  );
  assert.ok(
    deps.calls.exit?.some(([code]) => code === 1),
    "exit(1) should be called"
  );
});

test("formatCrashDialogBody includes error message", () => {
  const body = formatCrashDialogBody("something broke");
  assert.ok(body.includes("something broke"));
  assert.ok(body.includes("An unexpected error"));
});

test("formatCrashDialogBody includes log path when provided", () => {
  const body = formatCrashDialogBody("error", "/path/to/main.log");
  assert.ok(body.includes("/path/to/main.log"));
  assert.ok(body.includes("Details have been written to"));
});

test("formatCrashDialogBody omits log path section when not provided", () => {
  const body = formatCrashDialogBody("error");
  assert.ok(!body.includes("Details have been written to"));
});

test("showStartupCrashDialog calls showDialog with formatted body", () => {
  const calls: Record<string, unknown[][]> = {};
  const deps = {
    showDialog: (title: string, body: string) => {
      calls.showDialog ??= [];
      calls.showDialog.push([title, body]);
    },
    getLogFilePath: () => "/tmp/startup.log",
  };

  showStartupCrashDialog("Closedloop failed to start", "boot exploded", deps);

  assert.ok(calls.showDialog?.length === 1, "showDialog should be called once");
  assert.equal(calls.showDialog[0][0], "Closedloop failed to start");
  assert.ok(
    (calls.showDialog[0][1] as string).includes("boot exploded"),
    "body should include error message"
  );
  assert.ok(
    (calls.showDialog[0][1] as string).includes("/tmp/startup.log"),
    "body should include log path"
  );
});

test("showStartupCrashDialog survives showDialog throwing", () => {
  const deps = {
    showDialog: () => {
      throw new Error("dialog unavailable");
    },
    getLogFilePath: () => "/tmp/startup.log",
  };

  assert.doesNotThrow(() => {
    showStartupCrashDialog("title", "message", deps);
  });
});

test("showStartupCrashDialog survives getLogFilePath throwing", () => {
  const calls: Record<string, unknown[][]> = {};
  const deps = {
    showDialog: (title: string, body: string) => {
      calls.showDialog ??= [];
      calls.showDialog.push([title, body]);
    },
    getLogFilePath: () => {
      throw new Error("log transport unavailable");
    },
  };

  assert.doesNotThrow(() => {
    showStartupCrashDialog("title", "crash msg", deps);
  });
  assert.ok(
    calls.showDialog?.length === 1,
    "showDialog should still be called"
  );
  assert.ok(
    !(calls.showDialog[0][1] as string).includes(
      "Details have been written to"
    ),
    "body should omit log path when getLogFilePath throws"
  );
});

test("showStartupCrashDialog works without getLogFilePath", () => {
  const calls: Record<string, unknown[][]> = {};
  const deps = {
    showDialog: (title: string, body: string) => {
      calls.showDialog ??= [];
      calls.showDialog.push([title, body]);
    },
  };

  showStartupCrashDialog("title", "crash msg", deps);

  assert.ok(calls.showDialog?.length === 1, "showDialog should be called");
  assert.ok(
    !(calls.showDialog[0][1] as string).includes(
      "Details have been written to"
    ),
    "body should omit log path when getLogFilePath absent"
  );
});
