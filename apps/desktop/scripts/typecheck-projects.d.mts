/**
 * ISS-5375 — types for the typecheck project inventory.
 *
 * The runner and its guards are `.mjs` (they run under bare node, before any
 * build step), and the desktop tsconfigs do not enable `allowJs`, so the JSDoc
 * in the implementation is invisible to `tsc`. This declaration is what lets
 * `test/typecheck-project-coverage.test.ts` and
 * `test/run-typecheck-passes.test.ts` import the inventory with real types
 * instead of suppressing the import with `@ts-expect-error`.
 */

export type TypecheckProject = {
  /** Short label used in runner output. */
  readonly name: string;
  /** The tsconfig passed to `tsc -p`. */
  readonly project: string;
  /** Incremental state file, relative to apps/desktop. */
  readonly tsBuildInfoFile: string;
};

/** Every `tsc` project the desktop typecheck gate must cover. */
export const TYPECHECK_PROJECTS: readonly TypecheckProject[];

/**
 * Ceiling on concurrent `tsc` processes; always at least 1.
 *
 * @param raw Value of `DESKTOP_TYPECHECK_CONCURRENCY`.
 * @param availableCores Result of `os.availableParallelism()`.
 */
export function resolveTypecheckConcurrency(
  raw: string | undefined | null,
  availableCores: number
): number;
