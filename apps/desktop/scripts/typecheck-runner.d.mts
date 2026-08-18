/**
 * ISS-5375 — types for the desktop typecheck runner.
 *
 * The runner is `.mjs` (it runs under bare node, before any build step) and the
 * desktop tsconfigs do not enable `allowJs`, so its JSDoc is invisible to `tsc`.
 * This declaration is what lets `test/run-typecheck-passes.test.ts` import the
 * runner's exported seam with real types instead of an `@ts-expect-error`.
 *
 * Only the mechanics are declared here. `run-typecheck-passes.mjs` — the command
 * itself — is intentionally NOT importable: it has top-level side effects and no
 * main-module guard, so the guards exercise it by running it as a child process,
 * never by importing it.
 */

import type { TypecheckProject } from "./typecheck-projects.mjs";

export type TypecheckProjectResult = {
  readonly name: string;
  readonly code: number;
  readonly elapsedMs: number;
};

/**
 * Run an inventory of tsc projects and resolve to the aggregate exit code:
 * 0 only when every project passed, 1 otherwise (including an empty inventory).
 *
 * `spawnProject` defaults to the real `tsc` spawn. It is injectable so a guard
 * can observe which entries reach the spawn boundary without compiling them.
 */
export function runTypecheckPasses(options: {
  readonly projects: readonly TypecheckProject[];
  readonly concurrency: number;
  readonly spawnProject?: (
    entry: TypecheckProject
  ) => Promise<TypecheckProjectResult>;
}): Promise<number>;
