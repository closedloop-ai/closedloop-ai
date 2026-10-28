/**
 * Spawning the Prisma CLI for one migration run, and the migration-file readers
 * that run shares. Split out of `migration-pipeline.ts` (ISS-12056) so the
 * pipeline stays under the file-size ceiling.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readMigrationSql } from "./db-utils";
import { defaultListMigrationDirs } from "./preview-at-head";

/**
 * Absolute path of the bundled Prisma CLI entrypoint, for a caller that cannot
 * reach the CLI through `PATH`. Read here and set by
 * `apps/api/app/preview-schemas/ensure` — the env var is the contract between
 * them, so neither side spells it as a literal.
 */
export const PRISMA_CLI_ENTRY_ENV = "PRISMA_CLI_ENTRY";

/**
 * How to spawn the Prisma CLI: found on `PATH` (the build), or run as an
 * explicit entrypoint under the current `node` (a deployed function).
 *
 * ISS-6403. The build has pnpm's `.bin` on `PATH`, so a bare `prisma` resolves.
 * A deployed serverless bundle only LOOKS like it does: Next file tracing copies
 * the `.bin/prisma` shim and the CLI's files in the pnpm store, but not the
 * symlink between them, so the shim's `<bin>/../prisma/build/index.js` is
 * MODULE_NOT_FOUND and the CLI dies before it opens a connection. A caller that
 * has located the real entrypoint in its own bundle passes it here instead.
 *
 * BOTH `prisma` spawns in this module route through this helper deliberately.
 * The rolled-back recovery has to run wherever the migrate itself does — a
 * migrate that can spawn and a recovery that cannot is the worse failure, since
 * it strands `_prisma_migrations` mid-migration.
 *
 * ISS-6781: an entrypoint spawn also takes `cli.preload` as node's `--import`.
 * `NODE_PATH` (ISS-6728) makes the CLI's CommonJS `require`s resolve out of the
 * symlink-free bundle; its config loader then `import`s ES modules, which node
 * resolves without ever consulting `NODE_PATH`. The preload is the ESM half of
 * that bridge. Passed as an argument, not through `NODE_OPTIONS`: it belongs to
 * this spawn, and the env would carry it into every child of this process. The
 * PATH spawn ignores it — the build's install has its symlinks.
 */
export function prismaCliInvocation(
  args: string[],
  cli: PrismaCliOptions
): {
  command: string;
  args: string[];
  cwd: string | undefined;
} {
  // Empty/whitespace reads as unset: a blank cwd names no directory, and
  // spawning into one would only guarantee the CLI fails.
  const cwd = cli.cwd?.trim() || undefined;
  const entry = process.env[PRISMA_CLI_ENTRY_ENV];
  if (!entry) {
    return { command: "prisma", args, cwd };
  }
  const preload = cli.preload?.trim();
  const preloadArgs = preload ? ["--import", pathToFileURL(preload).href] : [];
  return {
    command: process.execPath,
    args: [...preloadArgs, entry, ...args],
    cwd,
  };
}

/**
 * How to spawn the Prisma CLI for ONE pipeline run.
 *
 * `cwd` is the directory the CLI discovers `prisma.config.mjs` from (Prisma 7
 * reads `datasource.url` only from a config file), for a caller whose OWN cwd is
 * not where that config lives — today `apps/api/app/preview-schemas/ensure`.
 * Absent → the child inherits this process's cwd, which is what the build and
 * the migrator walk want.
 *
 * ISS-6403 Finding 5. That caller first `process.chdir()`d into the config
 * directory, then passed it through a `PRISMA_CLI_CWD` env var. Neither is
 * per-invocation: `chdir` moved the cwd of every OTHER request on a warm Fluid
 * Compute instance for the rest of its life, and an env var is the same
 * process-global reach one indirection later — every build and migrator caller
 * reads whatever was last written to it, so a stale inherited value silently
 * runs Prisma from the wrong config directory. A value that belongs to one run
 * travels as an argument of that run (review: davetho).
 */
export type PrismaCliOptions = {
  cwd?: string;
  /**
   * Absolute path of an ES module for node's `--import`, honored only on an
   * entrypoint spawn (`PRISMA_CLI_ENTRY`). Today the ensure route's
   * `esm-store-resolver.mjs`; see `prismaCliInvocation`.
   */
  preload?: string;
  /**
   * ISS-6810: the migrations directory THIS run's in-process readers use — the
   * at-head probe, the pre-stamp (and its recovery re-run), the plain-index
   * build and the ownership preflight all read `prisma/migrations` themselves,
   * off `process.cwd()` by default. The CLI finds the same directory through
   * `prisma.config.mjs`; these readers have no config, so a caller whose cwd is
   * not the Prisma project names it here. Absent → cwd-relative, as the build.
   */
  migrationsDir?: string;
};

/**
 * The migration-file readers a run's `migrationsDir` implies, or nothing when
 * it is unset so every callee keeps its own cwd-relative default.
 */
export type MigrationFileReaders = {
  readMigrationSql?: (migrationName: string) => string;
  listMigrationDirs?: () => string[];
};

export function migrationFileReaders(
  cli: PrismaCliOptions
): MigrationFileReaders {
  const migrationsDir = cli.migrationsDir?.trim();
  if (!migrationsDir) {
    return {};
  }
  return {
    readMigrationSql: (migrationName) =>
      readMigrationSql(migrationName, migrationsDir),
    listMigrationDirs: () => defaultListMigrationDirs(migrationsDir),
  };
}

/**
 * What both CLI wrappers branch on: the child's exit status, the spawn error if
 * it never started, and its drained output.
 */
export type PrismaCliResult = {
  status: number | null;
  error: Error | undefined;
  stdout: string;
  stderr: string;
};

/**
 * Ceiling on the CLI output held in memory, across both streams, per spawn.
 *
 * ISS-6403: `spawnSync` enforced a 1 MB `maxBuffer` by default and killed the
 * child past it; the async drain that replaced it accumulated into JS strings
 * with no bound at all, so a verbose or runaway migration could grow the SHARED
 * api process heap until unrelated requests died with it — and overlapping
 * ensure requests multiply that (review: davetho). Counted in UTF-16 units
 * rather than bytes, which bounds the heap by construction and is the same
 * number for the CLI's ASCII output.
 */
const MAX_PRISMA_CLI_OUTPUT_CHARS = 1_000_000;

/** Kept in the bounded output so an operator sees diagnostics END, not stop. */
const PRISMA_CLI_OUTPUT_TRUNCATED_MARKER =
  "\n[output truncated: exceeded the Prisma CLI output ceiling]\n";

/** Forwards the CLI's captured output to this process's streams, as before. */
export function writeCliOutput(result: PrismaCliResult): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

/**
 * Spawns the Prisma CLI and resolves once it has exited and its output is
 * drained.
 *
 * ISS-6403 Finding 4: this was `spawnSync`. Correct for the build script it was
 * written for, and wrong once `apps/api` reached it from a REQUEST HANDLER —
 * `spawnSync` blocks the Node event loop for the child's entire lifetime, so a
 * `migrate deploy` froze every other request Fluid Compute had multiplexed onto
 * that instance. This is the BFF that serves all product traffic.
 *
 * Resolves rather than rejects on failure: the callers above own the error
 * shapes (recovery classifies P3009/P3018 off `stdout`/`stderr` attached to the
 * thrown error), and a rejection here would flatten that distinction. `close`
 * fires after the stdio streams end, so nothing is lost by resolving on it; a
 * process that never starts emits `error` instead and reports a null status.
 *
 * Output is bounded — see `MAX_PRISMA_CLI_OUTPUT_CHARS`. Past the ceiling the
 * child is terminated and the run FAILS, carrying the output captured up to
 * that point plus a truncation marker: the diagnostics are the whole reason
 * this output is captured (recovery classifies off them, and the sanitizer
 * exists to let them reach an operator), so the ceiling truncates them rather
 * than discarding them.
 */
export function runPrismaCli(
  args: string[],
  databaseUrl: string,
  cli: PrismaCliOptions
): Promise<PrismaCliResult> {
  const invocation = prismaCliInvocation(args, cli);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "pipe",
      cwd: invocation.cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    let stdout = "";
    let stderr = "";
    let overflow: Error | undefined;

    // One budget across both streams: the heap is what is being bounded, and it
    // does not care which stream filled it.
    const capture = (append: (text: string) => void) => (chunk: string) => {
      if (overflow) {
        return;
      }
      const remaining =
        MAX_PRISMA_CLI_OUTPUT_CHARS - (stdout.length + stderr.length);
      if (chunk.length <= remaining) {
        append(chunk);
        return;
      }
      append(chunk.slice(0, Math.max(0, remaining)));
      append(PRISMA_CLI_OUTPUT_TRUNCATED_MARKER);
      overflow = new Error(
        `prisma ${args[0] ?? "cli"} produced more than ${MAX_PRISMA_CLI_OUTPUT_CHARS} characters of output and was terminated`
      );
      child.kill();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      capture((text) => {
        stdout += text;
      })
    );
    child.stderr.on(
      "data",
      capture((text) => {
        stderr += text;
      })
    );

    child.on("error", (error) => {
      resolve({ status: null, error: overflow ?? error, stdout, stderr });
    });
    // An overflow is a FAILURE however the killed child exits: the output the
    // callers classify off is incomplete, so it must not be reported as success.
    child.on("close", (status) => {
      resolve({ status, error: overflow, stdout, stderr });
    });
  });
}
