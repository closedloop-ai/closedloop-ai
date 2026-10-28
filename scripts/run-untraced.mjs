/**
 * ISS-8775 — run a build command with the dd-trace preload taken back out of
 * `NODE_OPTIONS`.
 *
 * The CI lanes that run `pnpm test` set
 * `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js` so the tracer
 * instruments Vitest. Turbo hands that whole environment to every task in the
 * graph it walks, and the `test` graph pulls dependency `build` tasks in with
 * it. Those builds shell out to TypeScript 7's `bin/tsc`, which is ESM: the
 * dd-trace require-rewriter compiles it through `Module.prototype._compile`,
 * Node refuses the resulting `require(esm)` inside the loader cycle, and the
 * build dies with `ERR_REQUIRE_CYCLE_MODULE` before `tsc` reads a source file.
 *
 * A compile is not a traced runtime, so the tracer had nothing to collect here
 * in the first place. The strip lives at the command rather than in one job's
 * env because turbo caching decides which job actually executes the build: a
 * cache hit skips it and the check goes green, so whichever lane won the race to
 * a cold cache entry determined whether a PR went red. Fixing it here covers
 * every context the build runs in — PR lanes, the merge queue, Dagger, a local
 * shell that happens to export the preload.
 *
 * Sibling of `scripts/vitest-setup-strip-tracer.ts`, which applies the same rule
 * inside a Vitest worker; both strip through
 * `scripts/tracer-preload-tokens.mjs`.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { withoutTracerPreload } from "./tracer-preload-tokens.mjs";

/**
 * Turn a command line into the arguments `spawn` needs on this platform.
 *
 * On POSIX the command is executed directly, so no argument is ever re-parsed
 * by a shell. On Windows a workspace binary is a `cmd`/`ps1` shim that Node
 * refuses to execute without a command interpreter (node:child_process,
 * "Spawning .bat and .cmd files on Windows") — the same failure the `pnpm.cmd`
 * branches in `scripts/verify.ts` and `scripts/mutation/run.mjs` exist for. So
 * `pnpm --filter @repo/api build` would have exited through the error handler
 * below before tsc started (ISS-8775 review, whitlockk + codex). This wrapper takes
 * an arbitrary command, so there is no one extension to append; the command goes
 * through the shell instead, with anything cmd.exe would re-interpret quoted
 * first.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} command
 * @param {string[]} args
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function spawnPlanFor(platform, command, args) {
  if (platform !== "win32") {
    return { command, args, shell: false };
  }
  return {
    command: quoteForCommandShell(command),
    args: args.map(quoteForCommandShell),
    shell: true,
  };
}

/**
 * `spawn` does no quoting of its own once `shell` is on — it joins the command
 * and arguments into one string — so a path with a space would arrive at cmd.exe
 * as two tokens.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteForCommandShell(value) {
  if (!COMMAND_SHELL_METACHARACTER.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined) {
    process.stderr.write(
      "run-untraced: expected a command to run, e.g. `node scripts/run-untraced.mjs tsc -p tsconfig.build.json`\n"
    );
    process.exit(1);
  }

  const plan = spawnPlanFor(process.platform, command, args);
  const child = spawn(plan.command, plan.args, {
    env: withoutTracerPreload(process.env),
    shell: plan.shell,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    process.stderr.write(
      `run-untraced: failed to start ${command}: ${error}\n`
    );
    process.exit(1);
  });

  // A signalled child reports `code === null`; turning that into 0 would report
  // a killed compile as a successful build, which is the failure mode this whole
  // change exists to remove.
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}

const COMMAND_SHELL_METACHARACTER = /[\s"^&|<>()%!]/;

// Only spawn when run as a program. The regression guard imports this module for
// `spawnPlanFor`, and the Windows branch is unreachable from a POSIX runner in
// any other way.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
