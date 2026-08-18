/**
 * ISS-5375 — the desktop typecheck runner.
 *
 * The chain it replaced was `tsc … && pnpm typecheck:renderer && …`, whose one
 * virtue was that `&&` could not accidentally swallow a failure. A parallel
 * runner CAN: the classic bug in this shape is a fan-out that awaits every child
 * and then exits 0 regardless, so a broken project reports green and the gate
 * silently stops gating. That is the same silent-coverage-loss failure mode
 * ISS-5142 was filed for, arriving by a different route, so the aggregate exit
 * code is asserted here by EXECUTING the runner against projects that cannot
 * compile — not by inspecting its source.
 *
 * Two distinct things are proved, because either alone is insufficient:
 *
 *  1. AGGREGATION — a failing project fails the run, including when it is not
 *     the first project and the run is genuinely concurrent. A single-project
 *     fixture would leave the worker loop and the multi-result aggregation
 *     untested, which is precisely where a fan-out swallows failures.
 *  2. COVERAGE — the runner really does reach every entry of the REAL exported
 *     inventory. `typecheck-project-coverage.test.ts` asserts the inventory
 *     CONTAINS the tests and e2e projects, but an array assertion alone can be
 *     satisfied vacuously: an edit that filtered entries out between the export
 *     and the spawn would keep that guard green while checking less. So the
 *     runner is driven over the real inventory with a recording double in its
 *     `spawnProject` slot, and every entry must arrive there — a filter anywhere
 *     upstream of the spawn shows up as a missing project.
 *
 * The two halves are deliberately reached by different routes. Aggregation runs
 * the runner as a real CHILD PROCESS so the assertion is about the exit status a
 * CI step would actually observe, not about a return value that some later
 * wrapper might drop. Coverage runs it IN-PROCESS through an injected seam so it
 * costs milliseconds instead of ~40s of compilation, and so the cheap path is a
 * function argument rather than an environment variable — an env switch that
 * skips the compiler is reachable from any shell, and would let the required
 * desktop typecheck gate be turned into a green no-op (and, under
 * `envMode: "loose"`, poison turbo's cache with a success entry for a run that
 * never launched tsc).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveTypecheckConcurrency,
  TYPECHECK_PROJECTS,
  type TypecheckProject,
} from "../scripts/typecheck-projects.mjs";
import { runTypecheckPasses } from "../scripts/typecheck-runner.mjs";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
/** The command the `typecheck` npm script invokes. */
const CLI_SOURCE = path.join(desktopDir, "scripts/run-typecheck-passes.mjs");
/** The mechanics the command delegates to. */
const RUNNER_SOURCE = path.join(desktopDir, "scripts/typecheck-runner.mjs");
const PROJECTS_SOURCE = path.join(desktopDir, "scripts/typecheck-projects.mjs");

const projects = TYPECHECK_PROJECTS;
const GOOD_SOURCE = "export const ok: number = 1;\n";
const BAD_SOURCE = 'export const bad: number = "no";\n';

const SOLO_FAILED_RE = /solo: FAILED/;
const BRAVO_FAILED_RE = /bravo: FAILED/;
const ALPHA_OK_RE = /alpha: ok/;
const CHARLIE_OK_RE = /charlie: ok/;
const ONE_OF_THREE_FAILED_RE = /1 of 3 projects failed: bravo/;
const BRAVO_OUTPUT_HEADER_RE = /----- bravo output -----/;
const TS2322_RE = /TS2322/;

type FixtureProject = { name: string; source: string };

/**
 * Run the REAL runner over a throwaway inventory, so the assertion is about the
 * runner's own aggregation rather than the real projects' current health.
 *
 * Only the INVENTORY is substituted — the command and the runner are both copied
 * byte-for-byte from the production files, so this cannot drift into testing a
 * stale duplicate.
 *
 * The scratch tree lives UNDER apps/desktop, not in the OS temp dir: the runner
 * resolves TypeScript with `createRequire` relative to its own location, which
 * needs the workspace `node_modules` above it.
 */
function runRunnerOverFixture(
  fixtures: readonly FixtureProject[],
  env: Record<string, string> = {},
  { viaSymlink = false }: { viaSymlink?: boolean } = {}
): { status: number | null; output: string } {
  const root = mkdtempSync(path.join(desktopDir, ".iss5375-fixture-"));
  const symlinkedRoot = `${root}-link`;
  try {
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    // The runner derives its own directory as the PARENT of scripts/, and runs
    // tsc there, so this manifest is what makes `root` look like a package root.
    writeFileSync(path.join(root, "package.json"), JSON.stringify({}));

    const entries = fixtures.map((fixture) => {
      mkdirSync(path.join(root, fixture.name), { recursive: true });
      writeFileSync(path.join(root, fixture.name, "index.ts"), fixture.source);
      writeFileSync(
        path.join(root, `tsconfig.${fixture.name}.json`),
        JSON.stringify({
          compilerOptions: { strict: true, skipLibCheck: true },
          include: [`${fixture.name}/**/*.ts`],
        })
      );
      return {
        name: fixture.name,
        project: `tsconfig.${fixture.name}.json`,
        tsBuildInfoFile: `./tsconfig.${fixture.name}.tsbuildinfo`,
      };
    });

    // Substitute only the inventory, and RE-EXPORT the real concurrency resolver
    // by module URL rather than slicing it out of the production file's text.
    // Text surgery made the fixture's behaviour depend on the source's spelling
    // and layout: a rename broke it, and an earlier incidental match would have
    // silently changed which code the fixture ran, neither of which is a change
    // in production behaviour. A re-export binds to the export itself, so the
    // fixture runs the production resolver by definition or fails to load.
    writeFileSync(
      path.join(scripts, "typecheck-projects.mjs"),
      `export { resolveTypecheckConcurrency } from ${JSON.stringify(
        pathToFileURL(PROJECTS_SOURCE).href
      )};\nexport const TYPECHECK_PROJECTS = ${JSON.stringify(entries, null, 2)};\n`
    );
    // Byte-for-byte copies, not read-and-rewrites: the fixture must execute the
    // production command and the production mechanics, never a transcription of
    // either. Copying the CLI too is what makes this an end-to-end check of the
    // chain a CI step actually runs — command, runner, spawn, exit status — so a
    // CLI that stopped delegating, or stopped translating the aggregate into an
    // exit code, fails here rather than only under manual inspection.
    copyFileSync(CLI_SOURCE, path.join(scripts, "run-typecheck-passes.mjs"));
    copyFileSync(RUNNER_SOURCE, path.join(scripts, "typecheck-runner.mjs"));

    // Invoking through a symlink makes `process.argv[1]` and the entry module's
    // realpath'd `import.meta.url` disagree, which is the condition a
    // main-module guard misreads.
    let invokedRoot = root;
    if (viaSymlink) {
      symlinkSync(root, symlinkedRoot, "dir");
      invokedRoot = symlinkedRoot;
    }

    const result = spawnSync(
      process.execPath,
      [path.join(invokedRoot, "scripts", "run-typecheck-passes.mjs")],
      {
        cwd: invokedRoot,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env, ...env },
      }
    );
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(symlinkedRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ISS-5375 desktop typecheck runner", () => {
  test("a failing project makes the whole run exit non-zero", () => {
    const result = runRunnerOverFixture([{ name: "solo", source: BAD_SOURCE }]);
    assert.notEqual(
      result.status,
      0,
      `a broken tsc project must fail the runner, got exit ${result.status}:\n${result.output}`
    );
    assert.match(result.output, SOLO_FAILED_RE);
  });

  // The command must not be conditional on HOW it was invoked. An earlier
  // revision put a `pathToFileURL(process.argv[1]).href === import.meta.url`
  // main-module guard on the entry file so tests could import its seam; node
  // realpaths the entry module, so running it through any symlinked path — `/tmp`
  // -> `/private/tmp` on macOS, a symlinked CI workspace, a pnpm store link —
  // made the two disagree and the guard silently declined to run. The process
  // printed nothing and exited 0 having compiled nothing, which is a required
  // gate reporting success for a run that never happened. The seam now lives in
  // an inert module and the command runs unconditionally; this proves it, by
  // invoking a project that CANNOT compile through a symlink and requiring the
  // failure to still surface.
  test("the command still runs when invoked through a symlinked path", () => {
    const result = runRunnerOverFixture(
      [{ name: "solo", source: BAD_SOURCE }],
      {},
      { viaSymlink: true }
    );
    assert.notEqual(
      result.status,
      0,
      `invoked via a symlink the runner must still typecheck and fail, got exit ${result.status} with output:\n${result.output}`
    );
    // Exit code alone is not enough: a crash would also be non-zero. Require the
    // evidence that the compiler actually ran and was attributed.
    assert.match(result.output, SOLO_FAILED_RE);
    assert.match(result.output, TS2322_RE);
  });

  test("a clean project exits zero", () => {
    const result = runRunnerOverFixture([
      { name: "solo", source: GOOD_SOURCE },
    ]);
    assert.equal(
      result.status,
      0,
      `a clean tsc project must pass the runner, got exit ${result.status}:\n${result.output}`
    );
  });

  // The failure sits in the MIDDLE slot and the run is genuinely concurrent,
  // because that is the arrangement a naive fan-out gets wrong: the first and
  // last results are the ones an off-by-one in the worker loop preserves.
  test("a failure in a middle slot still fails a concurrent multi-project run", () => {
    const result = runRunnerOverFixture(
      [
        { name: "alpha", source: GOOD_SOURCE },
        { name: "bravo", source: BAD_SOURCE },
        { name: "charlie", source: GOOD_SOURCE },
      ],
      { DESKTOP_TYPECHECK_CONCURRENCY: "3" }
    );
    assert.notEqual(
      result.status,
      0,
      `a middle-slot failure must fail the run, got exit ${result.status}:\n${result.output}`
    );
    assert.match(result.output, BRAVO_FAILED_RE);
    // The siblings must still be reported — the point of not short-circuiting.
    assert.match(result.output, ALPHA_OK_RE);
    assert.match(result.output, CHARLIE_OK_RE);
    assert.match(result.output, ONE_OF_THREE_FAILED_RE);
  });

  test("every project's diagnostics are attributed to it", () => {
    const result = runRunnerOverFixture([
      { name: "alpha", source: GOOD_SOURCE },
      { name: "bravo", source: BAD_SOURCE },
    ]);
    assert.match(result.output, BRAVO_OUTPUT_HEADER_RE);
    assert.match(result.output, TS2322_RE);
  });

  // COVERAGE, not aggregation: runs the REAL runner over the REAL exported
  // inventory with a recording double in the spawn slot, so every entry must
  // arrive at the point where tsc would be launched. That is stronger than the
  // `DESKTOP_TYPECHECK_PLAN_ONLY` dry run it replaces, which observed a log line
  // emitted BEFORE the spawn and could not see a filter placed after it — and it
  // is a function argument, so unlike an environment switch it cannot be set
  // from a shell to turn the production gate into a no-op.
  test("the runner reaches the spawn boundary for every project in the real inventory", async () => {
    const spawned: TypecheckProject[] = [];
    const exitCode = await runTypecheckPasses({
      projects,
      concurrency: 2,
      spawnProject: (entry) => {
        spawned.push(entry);
        return Promise.resolve({ name: entry.name, code: 0, elapsedMs: 0 });
      },
    });

    assert.equal(exitCode, 0, "an all-passing inventory must aggregate to 0");
    // deepEqual on the whole records, in order: a project dropped, duplicated,
    // reordered, or handed the wrong tsconfig/tsbuildinfo all fail here.
    assert.deepEqual(
      spawned,
      [...projects],
      "the runner did not hand every TYPECHECK_PROJECTS entry to the spawn seam exactly once, in inventory order — something between the exported array and the spawn is filtering or rewriting it"
    );
  });

  // Positive control for the guard above: the assertion is only meaningful if a
  // runner that DROPPED a project would fail it. Feeding the same predicate a
  // filtered inventory must produce a mismatch, so the deepEqual is not passing
  // merely because both sides are derived from the same array.
  test("the coverage guard's predicate rejects a filtered inventory", async () => {
    const spawned: TypecheckProject[] = [];
    await runTypecheckPasses({
      projects: projects.filter((entry) => entry.name !== "tests"),
      concurrency: 2,
      spawnProject: (entry) => {
        spawned.push(entry);
        return Promise.resolve({ name: entry.name, code: 0, elapsedMs: 0 });
      },
    });
    assert.notDeepEqual(spawned, [...projects]);
  });

  // The empty-inventory guard is the fail-CLOSED case: zero projects means zero
  // failures, and a naive aggregate would call that success.
  test("an empty inventory fails rather than reporting a vacuous success", async () => {
    let spawnCalls = 0;
    const exitCode = await runTypecheckPasses({
      projects: [],
      concurrency: 2,
      spawnProject: (entry) => {
        spawnCalls += 1;
        return Promise.resolve({ name: entry.name, code: 0, elapsedMs: 0 });
      },
    });
    assert.notEqual(exitCode, 0, "an empty inventory must not exit 0");
    assert.equal(spawnCalls, 0);
  });

  // Aggregation at the seam, independent of tsc: a failure in ANY slot must
  // surface, including when it is neither the first project nor the last one to
  // finish. The double delays the passing projects past the failing one, so a
  // runner that reported the LAST result to complete would return 0 here.
  test("a single failing project outweighs later-finishing passes", async () => {
    const exitCode = await runTypecheckPasses({
      projects,
      concurrency: 5,
      spawnProject: (entry) => {
        const code = entry.name === "main" ? 1 : 0;
        return new Promise((resolveResult) => {
          setTimeout(
            () => resolveResult({ name: entry.name, code, elapsedMs: 0 }),
            code === 0 ? 20 : 0
          );
        });
      },
    });
    assert.notEqual(
      exitCode,
      0,
      "one failing project must fail the aggregate even when every other project finishes after it"
    );
  });

  test("every project has a distinct name, config, and tsbuildinfo", () => {
    assert.ok(projects.length >= 5, "expected at least the five tsc projects");
    for (const key of ["name", "project", "tsBuildInfoFile"] as const) {
      const values = projects.map((entry) => entry[key]);
      assert.equal(
        new Set(values).size,
        values.length,
        `duplicate ${key} in TYPECHECK_PROJECTS`
      );
    }
  });

  test("concurrency is bounded and never below 1", () => {
    // The default is a MEMORY bound, not a CPU one: `desktop#typecheck` runs
    // inside a turbo graph that is itself pinned to --concurrency=2 for OOM
    // reasons, and .husky/pre-commit pins turbo to 1 as a laptop guard, so this
    // dial multiplies against theirs. 2 is measured to be no slower than 3.
    assert.equal(resolveTypecheckConcurrency(undefined, 10), 2);
    assert.equal(resolveTypecheckConcurrency("", 10), 2);
    assert.equal(resolveTypecheckConcurrency(undefined, 1), 1);
    // An explicit override wins, including the serial escape hatch.
    assert.equal(resolveTypecheckConcurrency("1", 10), 1);
    assert.equal(resolveTypecheckConcurrency("4", 2), 4);
    assert.equal(resolveTypecheckConcurrency(" 3 ", 10), 3);
    // Junk and non-positive values fall back rather than yielding 0 or NaN,
    // which would spawn zero workers and green the gate without checking.
    assert.equal(resolveTypecheckConcurrency("0", 10), 2);
    assert.equal(resolveTypecheckConcurrency("-2", 10), 2);
    assert.equal(resolveTypecheckConcurrency("abc", 10), 2);
    assert.ok(resolveTypecheckConcurrency(undefined, 0) >= 1);
  });

  // `parseInt` is PREFIX-tolerant, so every value here parses to a positive
  // number under a bare `Number.parseInt(raw, 10) > 0` check and would be
  // honoured as a real concurrency — `"4x"` would launch four concurrent tsc
  // processes on a typo. Each case must fall back to the memory-safe default
  // instead. This is the assertion that fails if the anchored match is removed.
  test("a malformed concurrency override falls back instead of parsing a prefix", () => {
    for (const raw of [
      "4x",
      "2gb",
      "3 workers",
      "1.9",
      "1e3",
      "0x4",
      "+4",
      "5,",
      "--4",
    ]) {
      assert.equal(
        resolveTypecheckConcurrency(raw, 10),
        2,
        `DESKTOP_TYPECHECK_CONCURRENCY="${raw}" is not a whole positive integer and must fall back to the default, not to its numeric prefix`
      );
    }
    // "000" is all digits but parses to zero, which must not become a ceiling of
    // 0 — that would spawn no workers and report success having checked nothing.
    assert.equal(resolveTypecheckConcurrency("000", 10), 2);
    // Positive control on the same predicate: the well-formed spellings the
    // cases above are typos OF are still accepted, so the loop is not passing
    // merely because the function rejects everything.
    assert.equal(resolveTypecheckConcurrency("4", 10), 4);
    assert.equal(resolveTypecheckConcurrency("003", 10), 3);
  });
});
