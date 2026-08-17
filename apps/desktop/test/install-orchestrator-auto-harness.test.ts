/**
 * @file install-orchestrator-auto-harness.test.ts
 * @description ISS-5027 regression coverage for the `"auto"` harness sentinel.
 *
 * Before the fix, `"auto"` was interpreted ONLY for `single_install` packs.
 * Everything else fell through to a command-map lookup keyed by the sentinel —
 * a key that by construction never exists — so the distribution auto-installer
 * and the renderer's Install action reported
 * `no install command for harness 'auto' on pack '<id>'` and the install never
 * started. That made the whole class of non-`single_install` pack unreachable.
 *
 * These tests drive the real resolution path and, for the end-to-end case, the
 * real `streamRun` (which spawns an actual `sh -c` child), so a regression that
 * re-breaks sentinel resolution fails here rather than in production.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import type { PackInstallRunEndInput } from "../src/main/packs/catalog-store.js";
import {
  joinIndependentCommands,
  resolveAutoCommand,
} from "../src/main/packs/install-command-resolver.js";
import { streamRun } from "../src/main/packs/install-orchestrator.js";
import {
  resetShellPathCache,
  setShellPathForTest,
  withShellPathEnvForTest,
} from "../src/server/shell-path.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import {
  HARNESS_AUTO,
  StreamRunErrorCode,
} from "../src/shared/install-run-contract.js";
import { makeCatalogEntry } from "./support/catalog-entry-fixture.js";

const tempDirs: string[] = [];

const CLAUDE_SKILLS_PATH_RE = /~\/\.claude\/skills\/pack/;
const CODEX_SKILLS_PATH_RE = /~\/\.codex\/skills\/pack/;
const NO_CLI_ON_PATH_RE = /none of those CLIs/;
/** The pre-fix failure text: the sentinel leaking into a command-map lookup. */
const AUTO_SENTINEL_RE = /'auto'/;
const CLAUDE_UNINSTALL_RE = /rm -rf claude-pack/;
const OK_RE = /ok/;
const CODEX_UNINSTALL_RE = /rm -rf codex-pack/;
/** The `joinIndependentCommands` wrapper — never a runnable paste on its own. */
const STEP_FAILED_WRAPPER_RE = /__closedloop_step_failed/;
/**
 * Explicit bound for the tests that await a `createDeferred` signal. These wait
 * on a real child process's `close` handler, so they own a stated timeout
 * rather than leaning on the runner's default to notice a hang.
 */
const DEFERRED_WAIT_TIMEOUT_MS = 30_000;

afterEach(() => {
  resetShellPathCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveAutoCommand — ISS-5027 sentinel resolution", () => {
  test("resolves a NON-single_install pack to its real harness command", () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry();

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.equal(resolved.command, "claude plugin install code-review");
    assert.deepEqual(resolved.registerHarnesses, ["claude"]);
  });

  test("installs onto EVERY harness CLI present, not one arbitrary harness", () => {
    // The operator-visible half of ISS-5027: a user with both CLIs must get the
    // pack in ~/.claude AND the codex location, not whichever harness won.
    const binDir = makeBinDir(["claude", "codex"]);
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      installCommands: {
        claude: "git clone repo ~/.claude/skills/pack",
        codex: "git clone repo ~/.codex/skills/pack",
      },
      packId: "multi-harness-pack",
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.deepEqual(resolved.registerHarnesses, ["claude", "codex"]);
    assert.match(String(resolved.command), CLAUDE_SKILLS_PATH_RE);
    assert.match(String(resolved.command), CODEX_SKILLS_PATH_RE);
  });

  test("runs an identical per-harness command ONCE, not once per harness", () => {
    // Most multi-harness catalog entries (rtk, bmad-method) repeat one command
    // across harnesses. Running it twice is wasteful at best and fatal at worst
    // — a `git clone` into a path the first pass created fails, flipping a
    // working install to `failed`.
    const binDir = makeBinDir(["claude", "codex"]);
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      installCommands: {
        claude: "brew install rtk",
        codex: "brew install rtk",
      },
      packId: "rtk",
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.command, "brew install rtk");
    assert.deepEqual(resolved.commands, ["brew install rtk"]);
    // Both harnesses are still registered — one command covered both.
    assert.deepEqual(resolved.registerHarnesses, ["claude", "codex"]);
  });

  test("a joined multi-step command survives a trailing shell comment", () => {
    // A `; `-joined single line lets a `#` swallow the `); then ...` closing its
    // own `if`, which is a syntax error that runs NOTHING.
    const joined = joinIndependentCommands([
      "echo first # trailing note",
      "echo second",
    ]);
    const result = spawnSync("sh", ["-c", joined], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["first", "second"]);
  });

  test("a joined multi-step command reports a failing step", () => {
    const joined = joinIndependentCommands(["echo ok", "exit 3"]);
    const result = spawnSync("sh", ["-c", joined], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, OK_RE);
  });

  test("skips a listed harness whose CLI is absent from PATH", () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      installCommands: { claude: "claude install", codex: "codex install" },
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.deepEqual(resolved.registerHarnesses, ["claude"]);
    assert.equal(resolved.command, "claude install");
  });

  test("reports ENOCLI (not a sentinel lookup miss) when no listed CLI is installed", () => {
    const emptyDir = makeTempDir("auto-harness-empty-");
    const entry = makeCatalogEntry();

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: emptyDir,
    });

    assert.equal(resolved.command, null);
    assert.equal(resolved.unavailable?.code, StreamRunErrorCode.NoCli);
    assert.match(String(resolved.unavailable?.message), NO_CLI_ON_PATH_RE);
    // The pre-fix failure text must never come back.
    assert.doesNotMatch(
      String(resolved.unavailable?.message),
      AUTO_SENTINEL_RE
    );
  });

  test("reports ENOCOMMAND when the entry carries no command for any listed harness", () => {
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: null });

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.command, null);
    assert.equal(resolved.unavailable?.code, StreamRunErrorCode.NoCommand);
  });

  test("uninstall covers every listed harness even when its CLI is gone", () => {
    // On-disk artifacts outlive a CLI removal, so uninstall must not be gated
    // on PATH the way install is.
    const emptyDir = makeTempDir("auto-harness-uninstall-");
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      uninstallCommands: {
        claude: "rm -rf claude-pack",
        codex: "rm -rf codex-pack",
      },
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "uninstall", {
      PATH: emptyDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.deepEqual(resolved.registerHarnesses, ["claude", "codex"]);
    assert.match(String(resolved.command), CLAUDE_UNINSTALL_RE);
    assert.match(String(resolved.command), CODEX_UNINSTALL_RE);
  });

  test("resolves on a Cursor-only machine instead of reporting ENOCLI", () => {
    // The catalog already lists cursor/opencode install commands
    // (`closedloop-web-command-pack`), so a harness the CLI probe does not know
    // reads as "not installed" and takes the whole pack down to ENOCLI on a
    // machine that in fact has the harness.
    const binDir = makeBinDir(["cursor"]);
    const entry = makeFourHarnessEntry();

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.deepEqual(resolved.registerHarnesses, ["cursor"]);
    assert.equal(resolved.command, "install for cursor");
  });

  test("resolves on an OpenCode-only machine instead of reporting ENOCLI", () => {
    const binDir = makeBinDir(["opencode"]);
    const entry = makeFourHarnessEntry();

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.deepEqual(resolved.registerHarnesses, ["opencode"]);
    assert.equal(resolved.command, "install for opencode");
  });

  test("single_install packs keep their superset semantics", () => {
    const binDir = makeBinDir(["claude", "codex"]);
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      installCommands: { claude: "claude install", codex: "codex install" },
      packId: "gstack",
      singleInstall: true,
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "install", {
      PATH: binDir,
    });

    // ONE command (the codex superset), not a joined pair.
    assert.equal(resolved.command, "codex install");
    assert.deepEqual(resolved.commands, ["codex install"]);
    assert.deepEqual(resolved.registerHarnesses, ["claude", "codex"]);
  });

  test("a single_install multi-harness uninstall exposes the STEPS, not the joined aggregate", () => {
    // `commands` is what the project-scoped `copy_command` hand-off gives the
    // user to paste. `pickSingleInstallCommand` already joins a multi-harness
    // uninstall, so wrapping its result as `[picked.command]` would hand over
    // the `if ! ( … ); then …` script — exactly the unusable paste the field
    // exists to avoid.
    const emptyDir = makeTempDir("auto-harness-single-uninstall-");
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      packId: "gstack",
      singleInstall: true,
      uninstallCommands: {
        claude: "rm -rf claude-pack",
        codex: "rm -rf codex-pack",
      },
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "uninstall", {
      PATH: emptyDir,
    });

    assert.equal(resolved.unavailable, undefined);
    assert.deepEqual(resolved.commands, [
      "rm -rf claude-pack",
      "rm -rf codex-pack",
    ]);
    // The spawned script is still the joined aggregate...
    assert.match(String(resolved.command), STEP_FAILED_WRAPPER_RE);
    // ...and no individual step carries that wrapper.
    for (const command of resolved.commands ?? []) {
      assert.doesNotMatch(command, STEP_FAILED_WRAPPER_RE);
    }
  });

  test("a single_install uninstall repeated across harnesses runs and pastes ONCE", () => {
    const emptyDir = makeTempDir("auto-harness-single-uninstall-dedupe-");
    const entry = makeCatalogEntry({
      harnesses: ["claude", "codex"],
      packId: "gstack",
      singleInstall: true,
      uninstallCommands: {
        claude: "brew uninstall gstack",
        codex: "brew uninstall gstack",
      },
    });

    const resolved = resolveAutoCommand(entry, entry.packId, "uninstall", {
      PATH: emptyDir,
    });

    assert.equal(resolved.command, "brew uninstall gstack");
    assert.deepEqual(resolved.commands, ["brew uninstall gstack"]);
    assert.deepEqual(resolved.registerHarnesses, ["claude", "codex"]);
  });
});

describe("streamRun — ISS-5027 end-to-end start for a non-single_install pack", () => {
  test("actually starts the install instead of failing on the sentinel", async () => {
    const marker = path.join(makeTempDir("auto-harness-run-"), "installed");
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({
      installCommands: { claude: `touch ${marker}` },
    });
    const db = makeFakeDb(entry);

    const result = await withPath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    assert.equal(
      result.error,
      undefined,
      `expected a started run, got ${result.error?.code}: ${result.error?.message}`
    );
    assert.equal(result.started, true);
    assert.equal(result.runId, FAKE_RUN_ID);
    assert.equal(db.startedCommands.length, 1);
    assert.equal(db.startedCommands[0], `touch ${marker}`);
  });
});

describe("streamRun — ISS-6164 db-host bounce during the run-end write", () => {
  test("a db-host exit under recordPackInstallRunEnd is dropped, not left unhandled", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    // The WIRING, not the primitive. `db-host-fire-and-forget.test.ts` proves
    // the guard in isolation, but deleting the wrapper at
    // `install-orchestrator.ts`'s `child.on("close")` write leaves that suite
    // green while restoring the ISS-6164 crash: the rejection reaches
    // `handleUnhandledRejection`, which shows the crash dialog and exits the
    // app. Only driving the real `streamRun` can catch that.
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: { claude: "true" } });
    const db = makeFakeDb(entry);
    // Exactly what the db-host proxy mints when the child dies under an op.
    db.recordPackInstallRunEnd = () =>
      Promise.reject(new DbHostExitError(0, true, "db-host exited (code: 0)"));

    const warnings: string[] = [];
    // The patched callback IS the seam the effect lands on, so it settles the
    // wait directly (@wongk) rather than a poller re-reading `warnings` on a
    // wall-clock interval.
    const dropped = createDeferred();
    const originalWarn = gatewayLog.warn.bind(gatewayLog);
    gatewayLog.warn = (_tag: string, message: string): void => {
      warnings.push(message);
      if (DROPPED_WRITE_LINE.test(message)) {
        dropped.resolve();
      }
    };

    try {
      const result = await withPath(binDir, () =>
        streamRun(db, {
          action: "install",
          getWindow: () => null,
          harness: HARNESS_AUTO,
          pack_id: entry.packId,
        })
      );
      assert.equal(result.started, true);
      // The close handler fires on a later loop turn, so wait for the real
      // signal. If the guard is removed this never settles and the test's
      // explicit timeout fails it.
      await dropped.settled;
      assert.equal(
        warnings.some((m) => DROPPED_WRITE_LINE.test(m)),
        true
      );
    } finally {
      gatewayLog.warn = originalWarn;
    }
  });

  test("a recoverable db-host exit re-drives the run-end write instead of losing it", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    // The completion is the ONLY write that ever closes a run out, and it is an
    // idempotent `updateMany` on one row. Dropping it outright leaves
    // `ended_at` null for good, which is what wedged the pack.
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: { claude: "true" } });
    const db = makeFakeDb(entry);
    const endCalls: PackInstallRunEndInput[] = [];
    const redriven = createDeferred();
    db.recordPackInstallRunEnd = (
      _id: number,
      input: PackInstallRunEndInput
    ) => {
      endCalls.push(input);
      // The first attempt dies under a host the supervisor is already
      // replacing — exactly the exit `redriveOnDbHostExit` exists to ride out.
      if (endCalls.length === 1) {
        return Promise.reject(
          new DbHostExitError(0, true, "db-host exited (code: 0)")
        );
      }
      redriven.resolve();
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
    // Settled by the second call itself. Without the re-drive there is no
    // second call, so this never settles and the explicit timeout fails it.
    await redriven.settled;
    assert.equal(endCalls.length, 2);
    // The re-drive carried the real completion, so the row is genuinely closed
    // rather than merely reported closed.
    assert.equal(endCalls[1]?.exit_code, 0);
  });

  test("an open run this process is not holding no longer wedges the pack", async () => {
    // The row a lost completion leaves behind: open forever, from a run no
    // process is running. Before the fix `inFlightInstallRun` reported it as
    // in-flight and every later install/uninstall of the pack was rejected.
    const binDir = makeBinDir(["claude"]);
    const entry = makeCatalogEntry({ installCommands: { claude: "true" } });
    const db = makeFakeDb(entry);
    db.openRun = {
      command: "true",
      harness: "claude",
      id: ORPHAN_RUN_ID,
      startedAt: "2026-08-12T00:00:00.000Z",
    };

    const result = await withPath(binDir, () =>
      streamRun(db, {
        action: "install",
        getWindow: () => null,
        harness: HARNESS_AUTO,
        pack_id: entry.packId,
      })
    );

    assert.equal(
      result.error?.code,
      undefined,
      `expected a started run, got ${result.error?.code}: ${result.error?.message}`
    );
    assert.equal(result.started, true);
  });

  test("a run this process is still holding is still rejected as in-flight", {
    timeout: DEFERRED_WAIT_TIMEOUT_MS,
  }, async () => {
    // The other half of the same branch: relaxing the guard must not disable
    // it. This run is genuinely live, so the second request must be refused.
    const binDir = makeBinDir(["claude"]);
    const gate = path.join(makeTempDir("install-gate-"), "release");
    const entry = makeCatalogEntry({
      installCommands: {
        claude: `while [ ! -f ${gate} ]; do sleep 0.05; done`,
      },
    });
    const db = makeFakeDb(entry);
    const ended = createDeferred();
    db.recordPackInstallRunEnd = () => {
      ended.resolve();
      return Promise.resolve();
    };

    const opts = {
      action: "install" as const,
      getWindow: () => null,
      harness: HARNESS_AUTO,
      pack_id: entry.packId,
    };
    const first = await withRunnablePath(binDir, () => streamRun(db, opts));
    assert.equal(first.started, true);
    db.openRun = {
      command: entry.installCommands?.claude ?? null,
      harness: "claude",
      id: FAKE_RUN_ID,
      startedAt: "2026-08-13T00:00:00.000Z",
    };

    const second = await withRunnablePath(binDir, () => streamRun(db, opts));
    assert.equal(second.started, false);
    assert.equal(second.error?.code, StreamRunErrorCode.InFlight);

    // Release the child and wait for its close handler, so the run does not
    // outlive the test.
    fs.writeFileSync(gate, "");
    await ended.settled;
  });
});

/** The log line `dropOnDbHostLifecycleError` emits when it drops a write. */
const DROPPED_WRITE_LINE = /dropped by a db-host lifecycle event/;

/**
 * A one-shot promise plus the callback that settles it.
 *
 * Each wait below already patches the exact seam its effect lands on — the
 * gateway logger, the run-end write — so the effect RESOLVES the wait (@wongk)
 * instead of a poller re-reading a variable on a wall-clock interval. Nothing
 * here bounds the wait: the test's own `timeout` option does, so a signal that
 * never arrives fails as a timeout naming the test rather than as a generic
 * poller message.
 */
function createDeferred(): { resolve: () => void; settled: Promise<void> } {
  let resolve = (): void => undefined;
  const settled = new Promise<void>((res) => {
    resolve = () => res();
  });
  return { resolve, settled };
}

const FAKE_RUN_ID = 7;
/** A run id this process never spawned — the orphan a lost completion leaves. */
const ORPHAN_RUN_ID = 4242;

/** The newest open `pack_install_runs` row, as `inFlightInstallRun` reads it. */
type FakeOpenRun = {
  command: string | null;
  harness: string | null;
  id: number;
  startedAt: string;
};

type FakeDb = Parameters<typeof streamRun>[0] & {
  /** What the concurrency guard's lookup returns; `null` means no open run. */
  openRun: FakeOpenRun | null;
  startedCommands: string[];
};

/**
 * Minimal `streamRun` database double. `getCatalog` reads the catalog through
 * `$queryRawUnsafe` and maps a snake_case row, so the double returns that row
 * shape rather than a `CatalogEntry`.
 */
function makeFakeDb(entry: ReturnType<typeof makeCatalogEntry>): FakeDb {
  const startedCommands: string[] = [];
  const row = {
    category: entry.category,
    contents: null,
    contents_cache: null,
    description: entry.description,
    description_live: entry.descriptionLive,
    detection_patterns: null,
    display_name: entry.displayName,
    forks: null,
    github_url: entry.githubUrl,
    harness_agnostic: 0,
    harnesses: JSON.stringify(entry.harnesses),
    install_commands: JSON.stringify(entry.installCommands),
    install_notes: null,
    installed_harnesses: null,
    installed_skill_count: 0,
    last_release: null,
    marketplace_url: null,
    pack_id: entry.packId,
    pin_order: null,
    placeholder_reason: null,
    post_install: null,
    project_scoped: 0,
    readme_excerpt: null,
    seed_version: 1,
    single_install: entry.singleInstall ? 1 : 0,
    stars: null,
    uninstall_commands: JSON.stringify(entry.uninstallCommands),
    verified: 1,
  };

  const db = {
    openRun: null,
    prisma: {
      client: {
        $queryRawUnsafe: () => Promise.resolve([row]),
        packCatalogHistory: { findMany: () => Promise.resolve([]) },
        packInstallRun: { findFirst: () => Promise.resolve(db.openRun) },
      },
    },
    recordPackInstallRunEnd: () => Promise.resolve(),
    recordPackInstallRunStart: (input: { command: string }) => {
      startedCommands.push(input.command);
      return Promise.resolve(FAKE_RUN_ID);
    },
    startedCommands,
  } as unknown as FakeDb;
  return db;
}

/**
 * Pin the resolved shell PATH to `binDir` for the duration of `fn`. `streamRun`
 * resolves the child PATH through `getShellPathSync()`, not `process.env.PATH`,
 * so the shell-path test context is what has to be controlled.
 */
function withPath<T>(binDir: string, fn: () => T): T {
  return withShellPathEnvForTest({ ...process.env, PATH: binDir }, () => {
    setShellPathForTest();
    return fn();
  });
}

/**
 * `withPath`, but with the real system bin directories still on PATH.
 *
 * `withPath` pins PATH to the harness stubs alone, which leaves `sh` itself
 * unresolvable: the child never spawns and `close` fires immediately with
 * `-2` (ENOENT). That is fine for a test that only needs the close handler to
 * run, and wrong for one that needs the command to actually execute.
 */
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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A directory holding executable stubs for the named harness CLIs. */
function makeBinDir(binaries: string[]): string {
  const dir = makeTempDir("auto-harness-bin-");
  for (const name of binaries) {
    fs.writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  }
  return dir;
}

/**
 * A pack listing all four catalog harnesses with a DISTINCT command each, so a
 * resolution can be attributed to exactly one of them.
 */
function makeFourHarnessEntry(): ReturnType<typeof makeCatalogEntry> {
  return makeCatalogEntry({
    harnesses: ["claude", "codex", "cursor", "opencode"],
    installCommands: {
      claude: "install for claude",
      codex: "install for codex",
      cursor: "install for cursor",
      opencode: "install for opencode",
    },
    packId: "closedloop-web-command-pack",
  });
}
