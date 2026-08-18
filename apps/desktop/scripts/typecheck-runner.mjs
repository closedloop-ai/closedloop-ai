// @ts-check

/**
 * ISS-5375 — the mechanics of running the desktop `tsc` projects concurrently.
 *
 * This module is deliberately SEPARATE from the `run-typecheck-passes.mjs`
 * command that the `typecheck` npm script invokes, and it deliberately has no
 * top-level side effects. An earlier revision kept both in one file behind an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` main-module guard so
 * that tests could import the seam without launching five compilers. That guard
 * is a FAIL-OPEN construct and was measured to be one: node realpaths the entry
 * module, so invoking the script through any symlinked path (`/tmp` ->
 * `/private/tmp` on macOS, a symlinked CI workspace, a pnpm store link) makes
 * `argv[1]` and `import.meta.url` disagree, the guard silently declines to run,
 * and the process exits **0** having typechecked nothing. A required gate that
 * reports success when its entry condition misfires is precisely the ISS-5142
 * failure this PR exists to make impossible, so there is no guard: the command
 * file always runs, and the importable code lives here where importing it is
 * inert by construction.
 *
 * Exit code is the aggregate: non-zero if ANY project failed, and non-zero if
 * the inventory is empty. Every project runs to completion even after one fails,
 * so a single broken pass does not hide the others' diagnostics behind it the
 * way the old `&&` chain did.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

// Resolve TypeScript's own entrypoint from this module rather than shelling out
// to `npx tsc`. `npx` costs ~1.9s of bootstrap per invocation (x5 projects), and
// when its cwd-relative lookup misses it will silently reach the NETWORK and
// install the deprecated third-party `tsc` stub — an unacceptable hermeticity
// hole in a required CI gate. `createRequire` either finds the workspace's
// TypeScript or throws here, where the message is actionable.
// Resolve the manifest, not `typescript/lib/tsc.js` directly: TypeScript 7's
// `exports` map does not list that subpath, so a direct resolve throws
// ERR_PACKAGE_PATH_NOT_EXPORTED even though the file is right there. Joining
// from the (exported) package.json keeps the same hermetic, workspace-local
// lookup and works on both 5.x and 7.x. `lib/tsc.js` is still a Node entry on
// 7.x — a thin shim that execs the native compiler — so it stays spawnable
// with `process.execPath` below.
const require = createRequire(import.meta.url);
const tscEntrypoint = join(
  dirname(require.resolve("typescript/package.json")),
  "lib",
  "tsc.js"
);

/**
 * Emit one project's captured output as a single block under its own header.
 *
 * The old chain got per-pass attribution for free: pnpm printed a `$ tsc -p …`
 * banner before each one. Sharing one inherited stdio across concurrent children
 * would lose that AND interleave the diagnostics themselves — three writers on
 * one pipe can tear each other mid-line above PIPE_BUF, which is 4096 bytes on
 * Linux CI but only 512 on macOS, so a long TS2322 would garble locally even
 * more readily than in CI. Buffering per project and flushing once keeps every
 * diagnostic attributable and intact.
 *
 * @param {string} name
 * @param {string} text
 */
function flushProjectOutput(name, text) {
  const body = text.trimEnd();
  if (body === "") {
    return;
  }
  console.log(`[typecheck] ----- ${name} output -----`);
  console.log(body);
}

/**
 * Run one `tsc` project to completion. This is the real spawn, and the default
 * implementation of the `spawnProject` seam below.
 *
 * Resolves rather than rejects on a non-zero exit: a failing project is an
 * expected outcome this runner reports, not an exception. A spawn `error` (tsc
 * missing, ENOENT) also resolves, as a failure carrying its message — an
 * unhandled rejection here would lose the other projects' results.
 *
 * @param {import("./typecheck-projects.mjs").TypecheckProject} entry
 * @returns {Promise<{name: string, code: number, elapsedMs: number}>}
 */
function spawnTscProject(entry) {
  const startedAtMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        tscEntrypoint,
        "-p",
        entry.project,
        "--noEmit",
        "--incremental",
        "--tsBuildInfoFile",
        entry.tsBuildInfoFile,
      ],
      { cwd: desktopDir, stdio: ["ignore", "pipe", "pipe"] }
    );
    let captured = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      captured += chunk;
    });
    child.stderr.on("data", (chunk) => {
      captured += chunk;
    });
    child.on("error", (error) => {
      console.error(
        `[typecheck] ${entry.name} failed to launch tsc: ${error.message}`
      );
      resolve({
        name: entry.name,
        code: 1,
        elapsedMs: Date.now() - startedAtMs,
      });
    });
    child.on("close", (code, signal) => {
      // A signalled child reports `code === null`; treat it as a failure rather
      // than letting `?? 0` turn a SIGKILLed (e.g. OOM-killed) pass into a pass.
      const exitCode = code === null ? 1 : code;
      flushProjectOutput(entry.name, captured);
      if (signal) {
        console.error(`[typecheck] ${entry.name} terminated on ${signal}`);
      }
      resolve({
        name: entry.name,
        code: exitCode,
        elapsedMs: Date.now() - startedAtMs,
      });
    });
  });
}

/**
 * Run every project with at most `concurrency` in flight.
 *
 * Workers pull from one shared cursor rather than taking a fixed slice, so a
 * slow project cannot leave a worker idle while another holds a queue of unrun
 * work — with a 37s project against four 4-20s ones, static partitioning would
 * waste most of the win. There is no `await` between reading the cursor and
 * incrementing it, so no project can be claimed twice or skipped.
 *
 * @param {readonly import("./typecheck-projects.mjs").TypecheckProject[]} projects
 * @param {number} concurrency
 * @param {(entry: import("./typecheck-projects.mjs").TypecheckProject) => Promise<{name: string, code: number, elapsedMs: number}>} spawnProject
 * @returns {Promise<{name: string, code: number, elapsedMs: number}[]>}
 */
async function runAll(projects, concurrency, spawnProject) {
  // Indexed rather than pushed, so the summary reports projects in inventory
  // order regardless of which finished first. `fill(null)` matters: `new Array(n)`
  // leaves HOLES, and `Array.prototype.filter` skips holes — an unfilled slot
  // would count as neither pass nor fail, which is fail-OPEN. A null placeholder
  // is visible to the aggregation below instead.
  /** @type {({name: string, code: number, elapsedMs: number} | null)[]} */
  const results = new Array(projects.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < projects.length) {
      const position = cursor;
      cursor += 1;
      const entry = projects[position];
      console.log(`[typecheck] start ${entry.name} (${entry.project})`);
      results[position] = await spawnProject(entry);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, projects.length) }, worker)
  );
  return results.map((result, position) => {
    if (result === null) {
      // Unreachable while every slot is awaited above; treated as a failure so
      // that a future early-return in the worker loop cannot green the gate.
      return {
        name: projects[position].name,
        code: 1,
        elapsedMs: 0,
      };
    }
    return result;
  });
}

/**
 * Run an inventory of tsc projects and return the aggregate exit code.
 *
 * `spawnProject` is the ONE injectable seam, and it exists so the coverage guard
 * in `test/run-typecheck-passes.test.ts` can drive the REAL exported inventory
 * all the way to the spawn boundary and record exactly which entries arrive,
 * without paying ~40s of compilation. It replaces an earlier
 * `DESKTOP_TYPECHECK_PLAN_ONLY` environment switch, which was the wrong shape
 * twice over: it lived in the PRODUCTION command, so setting it turned the
 * required desktop typecheck gate into a green no-op — and because
 * `turbo.json` runs in `envMode: "loose"` and never declares that variable,
 * turbo would pass it through to the task while omitting it from the task hash,
 * letting one dry run seed a "success" cache entry that a later real run
 * restores without ever launching tsc. It also announced each project and
 * returned BEFORE spawning, so the coverage test it existed for proved only that
 * the loop reached an announcement, never that a compiler was invoked.
 *
 * A test double passed as an argument cannot be reached from a shell, and it
 * observes the arguments at the spawn call rather than a log line printed near
 * it, so the seam is both safer and a stronger proof than what it replaces.
 *
 * @param {object} options
 * @param {readonly import("./typecheck-projects.mjs").TypecheckProject[]} options.projects
 * @param {number} options.concurrency
 * @param {((entry: import("./typecheck-projects.mjs").TypecheckProject) => Promise<{name: string, code: number, elapsedMs: number}>) | undefined} [options.spawnProject]
 * @returns {Promise<number>} 0 if every project passed, 1 otherwise.
 */
export async function runTypecheckPasses({
  projects,
  concurrency,
  spawnProject = spawnTscProject,
}) {
  const startedAtMs = Date.now();

  // Fail CLOSED on an empty inventory. Zero projects would otherwise spawn zero
  // workers, collect zero failures and exit 0 — a green gate that checked
  // nothing, which is the ISS-5142 failure mode with no code left to blame.
  if (projects.length === 0) {
    console.error(
      "[typecheck] TYPECHECK_PROJECTS is empty — refusing to report success without checking anything"
    );
    return 1;
  }

  console.log(
    `[typecheck] ${projects.length} projects, concurrency ${concurrency}`
  );

  const results = await runAll(projects, concurrency, spawnProject);
  const failed = results.filter((result) => result.code !== 0);

  for (const result of results) {
    const status = result.code === 0 ? "ok" : `FAILED (exit ${result.code})`;
    console.log(
      `[typecheck] ${result.name}: ${status} in ${(result.elapsedMs / 1000).toFixed(1)}s`
    );
  }
  console.log(
    `[typecheck] total ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`
  );

  if (failed.length > 0) {
    console.error(
      `[typecheck] ${failed.length} of ${results.length} projects failed: ${failed
        .map((result) => result.name)
        .join(", ")}`
    );
    return 1;
  }
  return 0;
}
