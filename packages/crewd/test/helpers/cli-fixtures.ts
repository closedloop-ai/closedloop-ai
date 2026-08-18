/**
 * @file cli-fixtures.ts
 * @description Shared harness for the crewd CLI suites (ISS-5296).
 *
 * `cli.test.ts` carried this block TWICE (a temp store dir, a `CLAUDE_HOME`
 * override so a default-native task never touches the operator's real Claude
 * config, stdout/stderr spies, and cleanup), plus a hand-rolled
 * `process.exitCode` save/reset in two more places. `cli-commands.test.ts` and
 * `cli-start.test.ts` need the same thing, so it lives here once.
 *
 * ── Why `process.exitCode` is part of this fixture ──────────────────────────
 * Several CLI paths set `process.exitCode = 2` (a missing id, an unknown
 * `--route`). A leaked value makes the vitest process exit 2 with every test
 * still passing, which turbo/CI reads as a FAILED task — a green suite that
 * fails the build. Saving and resetting it belongs with the rest of the
 * per-test state, not at four hand-rolled call sites.
 *
 * ── Why `cleanup`/`restoreMocks` are options, not constants ─────────────────
 * `cmdStart` keeps no daemon handle (`src/cli.ts` builds the `Daemon` in a
 * local and returns), so a started daemon outlives the test that started it,
 * still holding its `TaskStore` and a `log` bound to the stdout spy. For that
 * suite, restoring the spy or deleting the temp dir per-test means a later tick
 * writes real output into the run or reloads a deleted path. Every other CLI
 * suite wants the opposite — tight per-test cleanup. One knob, stated at the
 * call site, instead of a second copy of the fixture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

export type CliFixtureOptions = {
  /** Prefix for the temp directory (keeps parallel suites distinguishable). */
  prefix: string;
  /**
   * `afterEach` removes the temp dir after every test (the default, right for
   * any suite that does not start a daemon); `afterAll` defers removal to the
   * end of the file, which a suite calling `crewd start` must use.
   */
  cleanup?: "afterEach" | "afterAll";
  /**
   * Restore the stdout/stderr spies after each test. Must be `false` for a
   * suite that starts a daemon, or a later tick writes real output.
   */
  restoreMocks?: boolean;
};

export type CliFixture = {
  /** The temp directory for this test (fresh per test). */
  dir: () => string;
  /** `<dir>/scheduled_tasks.json` — pass as `--store`. */
  storePath: () => string;
  /** `<dir>/claude/scheduled_tasks.json` — where the native writer lands. */
  nativeFile: () => string;
  /** Everything written to stdout during this test, in order. */
  stdout: () => string[];
  /** Everything written to stderr during this test, in order. */
  stderr: () => string[];
};

/**
 * Register the CLI fixture's lifecycle hooks and return accessors. Call at
 * describe scope; the accessors are only valid inside a test.
 */
export function makeCliFixture(options: CliFixtureOptions): CliFixture {
  const cleanup = options.cleanup ?? "afterEach";
  const restoreMocks = options.restoreMocks ?? true;
  let dir = "";
  let priorClaudeHome: string | undefined;
  let priorExitCode: typeof process.exitCode;
  let out: string[] = [];
  let err: string[] = [];
  const created: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), options.prefix));
    created.push(dir);
    priorClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = join(dir, "claude");
    priorExitCode = process.exitCode;
    process.exitCode = 0;
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    if (restoreMocks) {
      vi.restoreAllMocks();
    }
    if (priorClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = priorClaudeHome;
    }
    // Restore the exact prior value — including `undefined`, which must clear
    // the property rather than assign the number 0.
    process.exitCode = priorExitCode;
    if (cleanup === "afterEach") {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (!restoreMocks) {
      vi.restoreAllMocks();
    }
    if (cleanup === "afterAll") {
      for (const d of created) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  return {
    dir: () => dir,
    storePath: () => join(dir, "scheduled_tasks.json"),
    nativeFile: () => join(dir, "claude", "scheduled_tasks.json"),
    stdout: () => out,
    stderr: () => err,
  };
}
