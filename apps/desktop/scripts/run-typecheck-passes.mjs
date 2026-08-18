#!/usr/bin/env node
// @ts-check

/**
 * ISS-5375 — run the desktop `tsc` projects concurrently instead of chaining
 * them with `&&`.
 *
 * The five projects are independent (no `references`, no `composite`), so the
 * old serial chain paid the SUM of their runtimes for no correctness benefit.
 * Measured cold on the dev box: 75s summed against a 37s largest project.
 *
 * Why a runner script rather than five sibling turbo tasks (the shape ISS-5375
 * originally proposed): three workflows invoke `pnpm --filter desktop run
 * typecheck` DIRECTLY, bypassing turbo entirely —
 * `.github/workflows/pr-test.yml` (the REQUIRED `desktop` context),
 * `desktop-test-validation.yml` and `desktop-test-auto-revert.yml`. Any pass
 * promoted out of the pnpm script silently stops running on all three. Keeping
 * one script that parallelizes internally gets the same wall-clock win with none
 * of that blast radius, and `desktop#typecheck` is already cacheable as a whole
 * (ISS-5370), so the residual gain from five separately-invalidated turbo tasks
 * is small — the projects overlap on all 64 files under `src/shared/`, so a
 * shared-code edit would invalidate several of them together anyway.
 *
 * This file is ONLY the command: it binds the real inventory and the environment
 * to `runTypecheckPasses` and translates the aggregate into an exit code. It
 * carries no main-module guard and no dry-run switch, so there is no condition
 * under which running it can decline to check anything and still exit 0. The
 * mechanics — and the one injectable seam the guards use — live in
 * `typecheck-runner.mjs`, which is inert on import.
 */

import { availableParallelism } from "node:os";
import {
  resolveTypecheckConcurrency,
  TYPECHECK_PROJECTS,
} from "./typecheck-projects.mjs";
import { runTypecheckPasses } from "./typecheck-runner.mjs";

const exitCode = await runTypecheckPasses({
  projects: TYPECHECK_PROJECTS,
  concurrency: resolveTypecheckConcurrency(
    process.env.DESKTOP_TYPECHECK_CONCURRENCY,
    availableParallelism()
  ),
});

if (exitCode !== 0) {
  // Assigned only on failure. An unconditional `= 0` would clobber a non-zero
  // code Node had already set for its own reasons.
  process.exitCode = exitCode;
}
