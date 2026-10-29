/**
 * Runs a script module in a child `node` and hands its JSON answer back.
 *
 * Coverage of the `scripts/**` `.mjs` libs is merged from two recorders, and the
 * merge keeps the record with the larger branch total per file. Where that is
 * the c8 record, only code a child process loaded is credited, so the suites
 * that cover those libs import them in a child rather than in-process.
 *
 * The child script binds the imported module as `m` and an `out(value)` that
 * writes `value` to stdout as JSON (`undefined` travels as `null`). `body` runs
 * after both, at module top level, so it may `await`.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";

export const CHILD_SPAWN_TIMEOUT_MS = 30_000;
/** Twice the spawn bound, so a hung child fails on its own error, not the case's. */
export const CHILD_CASE_TIMEOUT_MS = 2 * CHILD_SPAWN_TIMEOUT_MS;

export type ModuleChildOptions = {
  /** Script run after `m` and `out` are bound. */
  body: string;
  cwd: string;
  /** Replaces the child's env when given; it inherits this process's otherwise. */
  env?: NodeJS.ProcessEnv;
  moduleUrl: string;
  /** `node` flags placed ahead of `--input-type=module`. */
  nodeArgs?: readonly string[];
  /** Script run before the module is imported. */
  prelude?: string;
  /** Arguments the child sees as `process.argv.slice(1)`. */
  scriptArgs?: readonly string[];
  timeoutMs?: number;
};

/** Spawns the child and returns its raw result; throws only when it did not run. */
export function spawnModuleChild(
  options: ModuleChildOptions
): SpawnSyncReturns<string> {
  const script = [
    options.prelude ?? "",
    `const m = await import(${JSON.stringify(options.moduleUrl)});`,
    "const out = (v) => process.stdout.write(JSON.stringify(v === undefined ? null : v));",
    options.body,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      ...(options.nodeArgs ?? []),
      "--input-type=module",
      "-e",
      script,
      ...(options.scriptArgs ?? []),
    ],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      timeout: options.timeoutMs ?? CHILD_SPAWN_TIMEOUT_MS,
    }
  );
  if (result.error) {
    throw new Error(`child did not run: ${result.error.message}`);
  }
  return result;
}

/** Spawns the child and parses its stdout; throws on a nonzero exit. */
export function runModuleInChild<T>(options: ModuleChildOptions): T {
  const result = spawnModuleChild(options);
  if (result.status !== 0) {
    throw new Error(`child exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}
