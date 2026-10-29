/**
 * @file install-orchestrator-cov-iss11283-streamrun-branches.test.ts
 * @description ISS-11283 lane D branch-coverage addendum for
 * `packs/install-orchestrator.ts`. The existing suites drive
 * `resolveAutoCommand` directly and `streamRun` only for the sentinel
 * happy-path and the db-host-bounce wiring; this file drives `streamRun`
 * itself through the branches those suites never reach: the project-scoped
 * guard's non-`projectScoped` reason, the `"auto"` harness's NoCli/NoCommand
 * failures surfacing THROUGH `streamRun` (not the resolver alone), an
 * explicit `cwd`, a real spawned child's tail truncation (short and
 * over-`TAIL_BYTES` output), the timeout-kill and bare-signal completion
 * paths, the `post_install` IPC event, and the `onComplete` hook's own
 * Error/non-Error catch. Every case drives the real `sh -c` child process
 * (a real child-process boundary, per the module's own design) and asserts
 * against a fake `BrowserWindow` double that captures the exact IPC channel
 * and payload sent to it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
} from "../src/shared/install-run-contract.js";
import { deferred } from "./deferred.js";
import { fakeWindow, type SendCall } from "./helpers/fake-window.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";
import { makeStreamRunFakeDb } from "./support/stream-run-db-fixture.js";

const tempDirs: string[] = [];

const DEFERRED_WAIT_TIMEOUT_MS = 30_000;
const ON_COMPLETE_FAILED_LOG_PREFIX =
  "[install-orchestrator] onComplete callback failed:";

afterEach(() => {
  resetShellPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeBinDir(binaries: string[]): string {
  const dir = makeTempDir("install-orch-cov-bin-");
  for (const name of binaries) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return dir;
}

/** Pins the resolved shell PATH to `binDir` alone — no real `sh` on PATH, so a spawn attempt fails to resolve. Used for pre-flight rejections that never spawn a child. */
function withPath<T>(binDir: string, fn: () => T): T {
  return withShellPathEnvForTest({ ...process.env, PATH: binDir }, () => {
    setShellPathForTest();
    return fn();
  });
}

/** `withPath` but with the real system bin directories still on PATH, so `sh` itself resolves and the child actually runs. */
function withRunnablePath<T>(binDir: string, fn: () => T): T {
  const systemPath = process.env.PATH ?? "";
  return withShellPathEnvForTest(
    { ...process.env, PATH: systemPath ? `${binDir}:${systemPath}` : binDir },
    () => {
      setShellPathForTest();
      return fn();
    }
  );
}

describe("streamRun — project-scoped guard reason for a command that merely LOOKS project-relative", () => {
  it("reports looks_project_relative (not project_scoped) when the pack itself is not marked project-scoped", async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      projectScoped: false,
      installCommands: { claude: "some-tool --directory ." },
    });
    const db = makeStreamRunFakeDb(entry);
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: "claude",
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, false);
    assert.equal(result.error?.code, StreamRunErrorCode.CwdRequired);
    const copyCommand = calls.find(
      (c) =>
        c.args[0] && (c.args[0] as { type?: string }).type === "copy_command"
    );
    const copyData = copyCommand?.args[0] as
      | { data?: { reason?: string } }
      | undefined;
    assert.equal(copyData?.data?.reason, "looks_project_relative");
  });
});

describe("streamRun — the 'auto' harness's failures surface through streamRun itself", () => {
  it("fails with NoCli (not NoCommand) when no listed harness CLI is on PATH", async () => {
    const emptyDir = makeTempDir("install-orch-cov-empty-");
    const entry = makeCatalogEntry();
    const db = makeStreamRunFakeDb(entry);
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });

    const result = await withPath(emptyDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, false);
    assert.equal(result.error?.code, StreamRunErrorCode.NoCli);
    // The `code === NoCli ? "no_cli_detected" : "no_command"` reason is a
    // SEPARATE field from `.error.code` above — assert it directly so a
    // mutant that flips or drops that ternary is caught here.
    const complete = calls.find(
      (c) => (c.args[0] as { type?: string } | undefined)?.type === "complete"
    );
    const completeData = complete?.args[0] as
      | { data?: { reason?: string } }
      | undefined;
    assert.equal(completeData?.data?.reason, "no_cli_detected");
  });

  it("fails with NoCommand (not NoCli) when the CLI is present but the entry carries no install command", async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: null });
    const db = makeStreamRunFakeDb(entry);
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, false);
    assert.equal(result.error?.code, StreamRunErrorCode.NoCommand);
    const complete = calls.find(
      (c) => (c.args[0] as { type?: string } | undefined)?.type === "complete"
    );
    const completeData = complete?.args[0] as
      | { data?: { reason?: string } }
      | undefined;
    assert.equal(completeData?.data?.reason, "no_command");
  });

  it("actually starts the run when the auto harness resolves successfully (the sibling of the two failure cases above)", async () => {
    // Both failure tests above give `picked.unavailable` a truthy value —
    // this is the case where it is falsy, so `if (picked.unavailable)`
    // taking its TRUE branch unconditionally is what this test would catch.
    const binDir = makeBinDir(["claude"]);
    const marker = path.join(makeTempDir("install-orch-cov-auto-ok-"), "ran");
    const entry = makeCatalogEntry({
      installCommands: { claude: `touch ${marker}` },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    db.recordPackInstallRunEnd = () => {
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, true);
    await ended.promise;
    assert.equal(fs.existsSync(marker), true);
  });
});

describe("streamRun — an explicit cwd is passed through to the spawned child", () => {
  it("runs the child inside the requested cwd", async () => {
    const binDir = makeBinDir(["claude"]);
    const workDir = makeTempDir("install-orch-cov-cwd-");
    const marker = path.join(workDir, "here");
    const entry = makeCatalogEntry({
      projectScoped: false,
      installCommands: { claude: "pwd > here" },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    let endInput: { stdout_tail: string | null } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { stdout_tail: string | null };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        cwd: workDir,
        getWindow: () => null,
        harness: "claude",
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, true);
    await ended.promise;
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.readFileSync(marker, "utf8").trim(), workDir);
    // `pwd > here` writes nothing to stdout itself (redirected to a file),
    // so the captured tail must be exactly null — not an empty string —
    // pinning `tailBytes`'s `if (!buffer) { return null; }` early return.
    assert.equal(endInput?.stdout_tail, null);
  });

  it("defaults to the app's own working directory when no cwd is given", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    // NOTE (mutation equivalence): a mutant that makes `if (cwd)` always
    // true still passes this test — verified empirically that Node's
    // `child_process.spawn` treats an explicit `cwd: null` identically to
    // omitting the option entirely (both default to `process.cwd()`, no
    // validation error). Since `cwd` here is exactly `null` (not
    // `undefined`) when no `opts.cwd` is supplied, setting
    // `spawnOpts.cwd = null` unconditionally produces no observable
    // difference through the real spawn boundary.
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      projectScoped: false,
      installCommands: { claude: "pwd" },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    let endInput: { stdout_tail: string | null } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { stdout_tail: string | null };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: "claude",
        pack_id: entry.packId,
      })
    );

    assert.equal(result.started, true);
    await ended.promise;
    // No cwd means the child runs in process.cwd().
    assert.equal(endInput?.stdout_tail, `${process.cwd()}\n`);
  });
});

describe("streamRun — tail capture for a real spawned child's output", () => {
  it("records the exact short output verbatim (no truncation)", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      installCommands: { claude: "echo hi" },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    let endInput: { stdout_tail: string | null } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { stdout_tail: string | null };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: "claude",
        pack_id: entry.packId,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    assert.equal(endInput?.stdout_tail, "hi\n");
  });

  it("returns output exactly AT the TAIL_BYTES boundary verbatim, with no ellipsis", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    // 4096 bytes is `<= TAIL_BYTES`, so this must take the SAME early-return
    // branch as the short-output case — proving `<=` and not the off-by-one
    // `<` a mutation could substitute, which would only diverge exactly at
    // this boundary.
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      installCommands: {
        claude: `node -e "process.stdout.write('b'.repeat(4096))"`,
      },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    let endInput: { stdout_tail: string | null } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { stdout_tail: string | null };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: "claude",
        pack_id: entry.packId,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    assert.equal(endInput?.stdout_tail, "b".repeat(4096));
  });

  it("truncates output over TAIL_BYTES with a leading ellipsis, keeping only the tail", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      installCommands: {
        claude: `node -e "process.stdout.write('a'.repeat(5000))"`,
      },
    });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    let endInput: { stdout_tail: string | null } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { stdout_tail: string | null };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: "claude",
        pack_id: entry.packId,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    assert.ok(endInput?.stdout_tail?.startsWith("…"));
    // TAIL_BYTES = 4096, plus the leading ellipsis character.
    assert.equal(endInput?.stdout_tail?.length, 4097);
    assert.equal(endInput?.stdout_tail?.slice(1), "a".repeat(4096));
  });
});

describe("streamRun — post_install is surfaced only on a genuinely successful install", () => {
  it("sends the pack's post_install block after a zero-exit install", async () => {
    const binDir = makeBinDir(["claude"]);
    const postInstall = { message: "Run `closedloop configure` next." };
    const entry = makeCatalogEntry({
      installCommands: { claude: "true" },
      postInstall,
    });
    const db = makeStreamRunFakeDb(entry);
    // `makeStreamRunFakeDb`'s fixed catalog row hardcodes `post_install:
    // null` (it is shared across every suite and never carries this field
    // through), so thread the real value here by patching the row this ONE
    // test's raw catalog read resolves to.
    const originalQueryRawUnsafe = db.prisma.client.$queryRawUnsafe.bind(
      db.prisma.client
    );
    db.prisma.client.$queryRawUnsafe = (async (...args: unknown[]) => {
      const rows = (await originalQueryRawUnsafe(
        ...(args as [string, ...unknown[]])
      )) as Record<string, unknown>[];
      return rows.map((row) => ({ ...row, post_install: postInstall }));
    }) as typeof db.prisma.client.$queryRawUnsafe;
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });
    const ended = deferred();
    db.recordPackInstallRunEnd = () => {
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: "claude",
        pack_id: entry.packId,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    const postInstallCall = calls.find(
      (c) =>
        (c.args[0] as { type?: string } | undefined)?.type === "post_install"
    );
    assert.deepEqual(
      (postInstallCall?.args[0] as { data?: unknown } | undefined)?.data,
      postInstall
    );
    // A clean `true` exit carries no signal and was never killed, so
    // `completionReason` must fall through both guards to its plain "exit"
    // return — pinning `if (signal)` taking its FALSE arm here.
    const complete = calls.find(
      (c) => (c.args[0] as { type?: string } | undefined)?.type === "complete"
    );
    const completeData = complete?.args[0] as
      | { data?: { reason?: string } }
      | undefined;
    assert.equal(completeData?.data?.reason, "exit");
  });
});

describe("streamRun — a run that overruns its timeout is killed and reports exit_code -1", () => {
  it("kills the child, records exit_code -1, and reports reason timeout", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      // `exec` replaces the shell with `sleep` directly (no lingering
      // grandchild holding the stdio pipes open): a bare `sh -c "sleep
      // 60"` leaves `sleep` as an orphaned grandchild after the shell is
      // killed, and `close` never fires because the pipe stays open.
      installCommands: { claude: "exec sleep 60" },
    });
    const db = makeStreamRunFakeDb(entry);
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });
    const ended = deferred();
    let endInput: { exit_code: number } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { exit_code: number };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: "claude",
        pack_id: entry.packId,
        timeoutMs: 100,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    assert.equal(endInput?.exit_code, -1);
    const complete = calls.find(
      (c) => (c.args[0] as { type?: string } | undefined)?.type === "complete"
    );
    const completeData = complete?.args[0] as
      | { data?: { exit_code?: number; reason?: string } }
      | undefined;
    assert.equal(completeData?.data?.exit_code, -1);
    assert.equal(completeData?.data?.reason, "timeout");
  });
});

describe("streamRun — a child that dies from a bare signal (not our own timeout) reports signal:<name>", () => {
  it("reports reason signal:SIGTERM when the child terminates itself, with no timeout involved", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      // The shell sends SIGTERM to itself — a signal death that our own
      // timeout timer never triggers, so `killed` stays false and
      // `completionReason` must read the signal argument instead.
      installCommands: { claude: "kill -TERM $$" },
    });
    const db = makeStreamRunFakeDb(entry);
    const calls: SendCall[] = [];
    const window = fakeWindow({ calls });
    const ended = deferred();
    let endInput: { exit_code: number } | undefined;
    db.recordPackInstallRunEnd = (_id, input) => {
      endInput = input as { exit_code: number };
      ended.resolve();
      return Promise.resolve();
    };

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => window,
        harness: "claude",
        pack_id: entry.packId,
        timeoutMs: DEFERRED_WAIT_TIMEOUT_MS,
      })
    );
    assert.equal(result.started, true);
    await ended.promise;

    // Unlike the timeout case, `killed` is false here, so the write's
    // `exit_code` flows straight from `const exitCode = code ?? -1` with no
    // outer `killed ? -1 : exitCode` masking it — this is the one scenario
    // that can actually catch a mutation to that specific fallback value.
    assert.equal(endInput?.exit_code, -1);
    const complete = calls.find(
      (c) => (c.args[0] as { type?: string } | undefined)?.type === "complete"
    );
    const completeData = complete?.args[0] as
      | { data?: { reason?: string } }
      | undefined;
    assert.equal(completeData?.data?.reason, "signal:SIGTERM");
  });
});

describe("streamRun — the onComplete hook's own failure is caught, never escaping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drives a real `true` install to completion with `onComplete` throwing
   * `thrown`, and returns what onComplete received plus every warn logged.
   * `recordPackInstallRunEnd` runs earlier in the same synchronous close
   * handler as `runOnComplete`, so by the time its deferred settles the hook
   * has run and its catch has logged.
   */
  async function runWithThrowingOnComplete(thrown: unknown) {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: { claude: "true" } });
    const db = makeStreamRunFakeDb(entry);
    const ended = deferred();
    db.recordPackInstallRunEnd = () => {
      ended.resolve();
      return Promise.resolve();
    };
    const warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => {
      // silenced: the assertions below read the calls
    });
    const onCompleteCalls: unknown[][] = [];

    const result = await withRunnablePath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: "claude",
        onComplete: (...args: unknown[]) => {
          onCompleteCalls.push(args);
          throw thrown;
        },
        pack_id: entry.packId,
      })
    );
    await ended.promise;

    return {
      onCompleteCalls,
      started: result.started,
      warnCalls: warnSpy.mock.calls,
    };
  }

  it("logs an Error's message when onComplete throws an Error", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const { onCompleteCalls, started, warnCalls } =
      await runWithThrowingOnComplete(new Error("rescan blew up"));

    assert.equal(started, true);
    assert.deepEqual(onCompleteCalls, [[{ exit_code: 0, killed: false }]]);
    assert.deepEqual(warnCalls, [
      [ON_COMPLETE_FAILED_LOG_PREFIX, "rescan blew up"],
    ]);
  });

  it("stringifies a non-Error throw from onComplete without escaping", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    const { onCompleteCalls, started, warnCalls } =
      await runWithThrowingOnComplete("plain string failure");

    assert.equal(started, true);
    assert.deepEqual(onCompleteCalls, [[{ exit_code: 0, killed: false }]]);
    assert.deepEqual(warnCalls, [
      [ON_COMPLETE_FAILED_LOG_PREFIX, "plain string failure"],
    ]);
  });
});
