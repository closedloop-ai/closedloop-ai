// @ts-check

/**
 * ISS-5375 — the canonical inventory of desktop `tsc` projects.
 *
 * Why this is a module and not a line in `package.json`: the `typecheck` script
 * used to chain the five passes with `&&`, and the ISS-5142 coverage guard
 * asserted that chain by matching `typecheck:tests` / `typecheck:e2e` against the
 * script STRING. That guard exists for a real reason — `apps/desktop/test/**`
 * genuinely went unchecked once, silently, because a project nothing invokes is
 * a file rather than a gate — but a string match is the wrong shape for it, and
 * pinning it froze the serial chain in place.
 *
 * Exporting the inventory instead lets the runner and the guard read the SAME
 * list: the guard asserts coverage of this array (see
 * `test/typecheck-project-coverage.test.ts`), the runner executes it, and a
 * project dropped from the gate fails the guard by construction rather than by
 * a regex that happens to still match. It also keeps the guard off raw-text
 * source scanning, which `scripts/lint/rules/no-raw-text-source-scan.ts` bans.
 *
 * Coverage of this array is necessary but NOT sufficient, and the guard suite
 * says so: an edit that filtered entries out between here and the spawn would
 * satisfy an array-only assertion while quietly checking less. That is why
 * `run-typecheck-passes.mjs` takes its spawn function as an argument, and why
 * `test/run-typecheck-passes.test.ts` runs it over THIS array with a recording
 * double in that slot — every entry must arrive at the spawn boundary, with its
 * own tsconfig, in inventory order.
 *
 * The five projects have no `references` and no `composite`, so tsc imposes no
 * build order between them — they are safe to run concurrently. They are not
 * fully DISJOINT, though: `tsconfig.json` and `tsconfig.type-tests.json` share
 * every file under `src/shared/`, so the parallel win is bounded by the largest
 * single project rather than by the sum divided by five.
 */

/**
 * A bare run of digits and nothing else — the only accepted spelling of the
 * `DESKTOP_TYPECHECK_CONCURRENCY` override. Declared at module scope because
 * a literal inside the function would be recompiled per call and trips the
 * repo's `useTopLevelRegex` lint rule.
 */
const WHOLE_POSITIVE_INTEGER_RE = /^\d+$/;

/**
 * @typedef {object} TypecheckProject
 * @property {string} name Short label used in runner output.
 * @property {string} project The tsconfig passed to `tsc -p`.
 * @property {string} tsBuildInfoFile Incremental state file, relative to apps/desktop.
 */

/**
 * Every `tsc` project the desktop typecheck gate must cover.
 *
 * Ordered longest-first so the bounded-concurrency runner starts the slowest
 * project immediately instead of leaving it to a straggling final slot — with a
 * ceiling below the project count, start order sets the wall clock.
 *
 * Measured cold, 2026-08-09, 10-core dev box (wall times taken under 1-min load
 * 41-52, so the absolute numbers are inflated by contention; the ranking and the
 * peak-RSS figures are the durable part):
 *
 *   tests       37s   peak RSS 1.70 GB   (2,792 files — the floor for the whole run)
 *   renderer    20s   peak RSS 1.00 GB
 *   main         7s   peak RSS 1.02 GB
 *   type-tests   4s
 *   e2e          4s
 *
 * `tests` alone is half the chain, so it is the bound any parallel arrangement
 * can reach and it must start first.
 *
 * @type {readonly TypecheckProject[]}
 */
export const TYPECHECK_PROJECTS = [
  {
    name: "tests",
    project: "tsconfig.tests.json",
    tsBuildInfoFile: "./tsconfig.tests.tsbuildinfo",
  },
  {
    name: "renderer",
    project: "tsconfig.renderer.json",
    tsBuildInfoFile: "./tsconfig.renderer.tsbuildinfo",
  },
  {
    name: "main",
    project: "tsconfig.json",
    tsBuildInfoFile: "./tsconfig.tsbuildinfo",
  },
  {
    name: "type-tests",
    project: "tsconfig.type-tests.json",
    tsBuildInfoFile: "./tsconfig.type-tests.tsbuildinfo",
  },
  {
    name: "e2e",
    project: "tsconfig.e2e.json",
    tsBuildInfoFile: "./tsconfig.e2e.tsbuildinfo",
  },
];

/**
 * Ceiling on concurrent `tsc` processes. Default 2, deliberately.
 *
 * Concurrency here is a MEMORY decision, not a CPU one, and this repo has an
 * OOM history on the very runner that will execute it: the sibling typecheck
 * step in `pr-test.yml` records "~5.5 GB RSS" per tsc and pins itself to
 * `--concurrency=2` because 3-way "would risk re-triggering that OOM on the
 * 16 GB runner". `desktop#typecheck` is INSIDE that turbo graph, so whatever
 * this returns multiplies against turbo's own lane count rather than replacing
 * it. `.husky/pre-commit` makes the same bet locally, running turbo at
 * `--concurrency=1` as a laptop OOM guard whose arithmetic ("workers x lanes x
 * ~4GB must fit in RAM") this dial silently enters.
 *
 * 2 is what the measurements support, and it costs nothing. The five projects'
 * peak RSS is 1.70 / 1.00 / 1.02 GB for the three that matter, so a 2-wide worst
 * case is `tests` + `renderer` ≈ 2.7 GB — BELOW the 4 GB `--max-old-space-size`
 * ceiling the old serial chain already granted a single tsc, which is what keeps
 * the aggregate within the budget every one of those guards was tuned against.
 * Children inherit the step's `NODE_OPTIONS`, so each additional lane is another
 * whole ceiling, not a share of one.
 *
 * And 2 is not slower than 3: `tests` runs 37s while the other four total ~35s,
 * so a second worker clears the entire remainder inside the first worker's
 * single project. Measured wall clock is the same ~37s either way, so 3 would
 * buy no time in exchange for a third concurrent ceiling.
 *
 * `DESKTOP_TYPECHECK_CONCURRENCY` overrides it, mirroring the existing
 * `TURBO_TYPECHECK_CONCURRENCY` spelling. `=1` restores the old serial behavior
 * exactly, which is the escape hatch for a memory-constrained laptop.
 *
 * The override must be a WHOLE positive integer and nothing else. `parseInt` is
 * prefix-tolerant — `parseInt("4x", 10)` is `4`, `parseInt("2gb", 10)` is `2` —
 * so a typo'd or unit-suffixed value would silently be honoured rather than
 * falling back, and here that means launching more concurrent tsc processes than
 * the memory budget above allows. Since this dial multiplies against turbo's own
 * lane count and each lane inherits a whole `--max-old-space-size` ceiling, a
 * fat-fingered `4x` is an OOM on the 16 GB runner, not a rounding error. Match
 * the whole string first, then parse.
 *
 * @param {string | undefined | null} raw Value of DESKTOP_TYPECHECK_CONCURRENCY.
 * @param {number} availableCores Result of `os.availableParallelism()`.
 * @returns {number} A concurrency of at least 1.
 */
export function resolveTypecheckConcurrency(raw, availableCores) {
  const trimmed = (raw ?? "").trim();
  // Anchored on both ends, so only a run of digits is accepted: junk, empty,
  // signs, decimals, exponents, hex and unit suffixes all fall through to the
  // memory-safe default rather than contributing a prefix.
  if (WHOLE_POSITIVE_INTEGER_RE.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    // "000" matches the pattern but parses to 0; a zero ceiling would spawn zero
    // workers and green the gate without checking anything.
    if (parsed > 0) {
      return Math.min(parsed, TYPECHECK_PROJECTS.length);
    }
  }
  const cores = availableCores > 0 ? availableCores : 1;
  return Math.max(1, Math.min(cores, 2));
}
