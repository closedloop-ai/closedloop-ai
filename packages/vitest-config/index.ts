import { availableParallelism } from "node:os";
import path from "node:path";

/**
 * ISS-6947. The reporter list every Vitest config in this repo pins.
 *
 * Vitest auto-selects a reporter ONLY when a config sets none, and what it picks
 * depends on who is watching: `reporters.push([isAgent ? "agent" : "default"])`.
 * `isAgent` is std-env's harness sniff (`AI_AGENT`, `CLAUDECODE`, `CODEX_*`,
 * `CURSOR_AGENT`), and the `agent` reporter names a module only when that module
 * FAILED, with `silent: "passed-only"` on top — so under an agent harness a
 * healthy run prints a banner, nothing, then a summary. That is indistinguishable
 * from a hang; ISS-6183 was reported as a deadlock three times over it. `isAgent`
 * is false on a GitHub runner, so this is purely a local-loop defect.
 *
 * `github-actions` is re-added by hand because Vitest appends it INSIDE the same
 * `if (!resolved.reporters.length)` branch the pin skips, so pinning without it
 * would silently cost the lane its `::error file=` annotations.
 *
 * Executed rather than shape-asserted by
 * `scripts/lint/vitest-reporter-pin.test.ts`: `ReporterName` widens to
 * `(string & {})`, so a typo like `"defualt"` typechecks identically here.
 *
 * A workspace PACKAGE rather than a file under `scripts/`, because the thing
 * importing it is a per-package `vitest.config.ts` and a relative `../../`
 * escape out of the package root breaks every tool that treats a package as
 * self-contained. Two did, immediately: `tsc` raised TS6059 against
 * `apps/desktop`'s `rootDir` (its `tsconfig.tests.json` reaches the config
 * through `test/run-node-tests-shard.test.ts`), and Stryker resolved it inside
 * a sandbox that holds only the package, failing `pnpm mutation packages/cost`
 * before a single mutant ran. A `@repo/*` specifier resolves through
 * node_modules, which is exactly why the 301 other out-of-package `@repo/*`
 * sources already in that same desktop program raise no rootDir error and why
 * Stryker's symlinked node_modules can still see this one. Do not move it back.
 */
/**
 * ISS-9661 appended `unhandledErrorReporter`. An unhandled error is not a test
 * failure, so a run carrying one exits 1 with every test green and no failing
 * name anywhere; Vitest's `github-actions` reporter cannot annotate it either,
 * because it needs a project frame and this class of error has none. That
 * reporter states the originating file up front and annotates it on a runner.
 * Its docblock below explains why a `process.on("uncaughtException")` listener
 * is the wrong tool and why there is no fail-fast option to pair with it.
 */
export function pinnedReporters(): (string | typeof unhandledErrorReporter)[] {
  if (process.env.GITHUB_ACTIONS === "true") {
    return ["default", "github-actions", unhandledErrorReporter];
  }
  return ["default", unhandledErrorReporter];
}

/**
 * ISS-9661. Makes an UNHANDLED ERROR name the test file it came from, in the one
 * place a reader will see it.
 *
 * An unhandled error is not a test failure. Work scheduled by a test file that
 * outlives the file — a React root that was never unmounted, a `setTimeout` a
 * component's unmount cleanup left behind — runs after Vitest has torn the
 * environment down, throws there, and Vitest books it as an unhandled error. The
 * job exits 1 with `Tests 11013 passed` and NOT ONE failing test, so a
 * test-count assertion cannot detect it; the error count is the only signal.
 *
 * Vitest's own `github-actions` reporter cannot annotate these. It formats each
 * error through `printError` and then does `if (!stack) continue`, where `stack`
 * is the nearest frame belonging to the PROJECT — and this class of error has a
 * stack made entirely of `node_modules` frames (`react-dom-client`,
 * `scheduler`, `@radix-ui/*`). So it emits nothing, and the PR checks UI shows a
 * red job with no annotation anywhere. That silence is what made this signature
 * read as infrastructure and cost a lane a wrong-check chase.
 *
 * Vitest tags the error with `VITEST_TEST_PATH` (the file the worker was on when
 * it surfaced) and prints it — at the very bottom, after every passing line. All
 * this reporter does is state it up front, and turn it into a `::error file=`
 * annotation on a runner so it lands in the PR UI where the default reporter's
 * text does not.
 *
 * DO NOT solve this by adding a `process.on("uncaughtException")` listener
 * instead: Vitest's own worker handler starts with
 * `if (processListeners(event).length > 1) return`, so a second listener makes
 * Vitest silently DROP every unhandled error in the run. Same reason
 * `dangerouslyIgnoreUnhandledErrors` is not on the table — this class of bug has
 * to stay loud, it just has to say where it came from.
 *
 * There is no fail-fast lever to pair with this. `bail` counts failed TESTS, and
 * Vitest 4 exposes no option that ends a run on the first unhandled error, so a
 * run still pays for every remaining file before reporting.
 *
 * It lives in this module rather than a sibling because `index.ts` is loaded by
 * Vitest as NATIVE ESM, where a relative import must carry a `.ts` extension —
 * and that extension then fails `tsc` in every package whose program reaches
 * this file.
 */

type UnhandledError = {
  name?: string;
  message?: string;
  VITEST_TEST_PATH?: string;
};

type ReporterContext = {
  config?: { root?: string };
  logger?: { error: (message: string) => void };
};

const BANNER =
  "UNHANDLED ERROR(S): the suite is GREEN and the job still fails (ISS-9661).";
/**
 * Names the usual cause without ASSERTING it: a pool/worker failure is booked
 * here too, and a banner that swore every unhandled error was a teardown leak
 * would send the next reader after the wrong file.
 */
const EXPLANATION =
  "No test failed, so `Tests N passed` proves nothing here — the error count is the signal. The usual cause is work a test file scheduled and left behind (a React root never unmounted, a timer never cleared) running after that file's environment was torn down. A worker or pool failure reports here too, so read the error before blaming the file.";
const UNKNOWN_FILE = "unknown (Vitest could not attribute it to a file)";
const ANNOTATION_TITLE = "Unhandled error (green suite, failing job)";

/**
 * GitHub Actions annotation paths must be repo-root relative, and
 * `GITHUB_WORKSPACE` is exactly that root on a runner. The Vitest project root
 * is only the off-runner display fallback, where nothing is annotated anyway.
 */
function relativeTestPath(testPath: string, root: string): string {
  const relative = path.relative(
    process.env.GITHUB_WORKSPACE ?? root,
    testPath
  );
  return relative.startsWith("..") ? testPath : relative;
}

/**
 * GitHub Actions reads a workflow command as ONE line, so newlines must escape.
 * This is the MESSAGE half of GitHub's escaping rules (`toCommandValue`).
 */
export function escapeAnnotationData(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

/**
 * The PROPERTY half, which additionally escapes the command's own two field
 * separators: an unescaped `,` SPLITS one property into two and an unescaped
 * `:` ends the property list early, so either one silently truncates the
 * annotation GitHub renders. {@link ANNOTATION_TITLE} contains a comma, and a
 * repo-relative path is free to contain one too.
 *
 * A duplicate of `escapeProperty` in `scripts/lint/github-annotations.ts`, which
 * is the canonical owner and would be imported if it could be. It cannot:
 * `scripts/` is not a workspace package, so the only specifier available is a
 * relative one, and both spellings of it are broken in opposite directions —
 * WITH the `.ts` extension that Vitest's native-ESM load of this module
 * requires, `tsc` fails `TS5097` in every package whose program reaches this
 * file; WITHOUT it, the ESM loader fails `ERR_MODULE_NOT_FOUND` and takes every
 * Vitest config in the repo down with it. Re-homing the canonical escaper into a
 * shared package is not available either: the repo root links only
 * `@repo/typescript-config` and `@repo/vitest-config` into `node_modules`, so no
 * neutral package is resolvable from a `scripts/` guard at runtime.
 *
 * The two are therefore pinned to each other by an executed drift test rather
 * than by the type system — see `scripts/lint/vitest-unhandled-error-reporter.ts`'s
 * "matches the canonical escaper" case, which fails the moment they diverge.
 */
export function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationData(value)
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function describeError(error: UnhandledError): string {
  return `${error.name ?? "Error"}: ${error.message ?? String(error)}`;
}

/**
 * The lines this reporter prints for one run, as data, so a test can grade the
 * decision rather than the plumbing. Empty when the run had no unhandled errors,
 * which is the branch that must stay silent.
 */
export function unhandledErrorReport(
  unhandledErrors: readonly unknown[],
  root: string
): string[] {
  if (unhandledErrors.length === 0) {
    return [];
  }

  const lines = [`\n${BANNER}\n${EXPLANATION}`];
  for (const raw of unhandledErrors) {
    const error = (raw ?? {}) as UnhandledError;
    const testPath = error.VITEST_TEST_PATH;
    const shown = testPath ? relativeTestPath(testPath, root) : UNKNOWN_FILE;
    lines.push(
      `  originating test file: ${shown}`,
      `  ${describeError(error)}`
    );

    // Vitest's own github-actions reporter emits nothing for these, because
    // their stacks hold no project frame for it to point at.
    if (process.env.GITHUB_ACTIONS === "true" && testPath) {
      lines.push(
        `::error file=${escapeAnnotationProperty(shown)},title=${escapeAnnotationProperty(ANNOTATION_TITLE)}::${escapeAnnotationData(`${BANNER} ${describeError(error)}`)}`
      );
    }
  }
  return lines;
}

export const unhandledErrorReporter = {
  context: undefined as ReporterContext | undefined,

  onInit(context: ReporterContext) {
    unhandledErrorReporter.context = context;
  },

  onTestRunEnd(_testModules: unknown, unhandledErrors: readonly unknown[]) {
    const context = unhandledErrorReporter.context;
    const lines = unhandledErrorReport(
      unhandledErrors,
      context?.config?.root ?? process.cwd()
    );
    for (const line of lines) {
      // Called as a METHOD: Vitest's logger reads `this` internally, so a
      // destructured `error` throws inside the reporter and takes the whole run
      // down with it.
      if (context?.logger) {
        context.logger.error(line);
      } else {
        process.stderr.write(`${line}\n`);
      }
    }
  },
};

/**
 * ISS-9976. The env var `pr-test.yml#test-shard` sets to `<leg>/<total>` on its
 * `Run tests` step, and the one place its name is spelled.
 */
export const VITEST_SHARD_ENV = "VITEST_SHARD";

/**
 * ISS-9976. Spread into a config's `test` block so one env var splits this
 * package's suite across the `test-shard` matrix legs. Unset or empty means
 * unsharded, which is every run that is not that lane: local, Dagger, coverage.
 *
 * WHY AN ENV VAR AND NOT `pnpm test -- --shard=…`: turbo 2 hands pass-through
 * args to EVERY task in the run, and this lane's graph pulls in `tsup`/`tsc`
 * builds (`@closedloop-ai/telemetry-contract#build`, …) that reject the flag.
 * The var is in each `test` task's turbo `env`, so a leg can never replay
 * another leg's cached slice.
 *
 * WHY A SPREAD: Vitest types `shard` as CLI-only (`UserConfig`, not
 * `InlineConfig`), but its `resolveConfig` reads the key from the merged test
 * config all the same. `scripts/lint/test-lane-shard-fold.test.ts` executes a
 * sharded run to pin that, because a Vitest that stopped honoring it would run
 * the whole suite on every leg, green.
 *
 * Only packages with at least 10 spec files call this. Vitest throws when a
 * shard count exceeds the files it collected, and `passWithNoTests` — the only
 * way around that throw — is banned by ISS-8144. A package below the line runs
 * whole on every leg, which costs seconds and loses nothing.
 */
export function shardFromEnv(): { shard?: string } {
  const shard = process.env[VITEST_SHARD_ENV];
  return shard ? { shard } : {};
}

/**
 * The `oxc` slice that pins React's automatic JSX runtime, spread in as
 * `oxc: automaticJsx()`. Required wherever the tsconfig Vite resolves for a
 * `.tsx` extends `@repo/typescript-config/nextjs.json`: that preset's
 * `jsx: "preserve"` is meant for the Next compiler, Vite honors it, and the
 * untransformed JSX reaches the parser — every `.tsx` suite in the package
 * fails to load with `Unexpected JSX expression`.
 *
 * Pin it through `oxc`, never `esbuild`. Vitest sets `oxc` itself, so Vite 8
 * ignores a config's `esbuild` key outright, and the only trace is one `Both
 * esbuild and oxc options were set…` warning line above an otherwise
 * normal-looking run — the red reads as the suites' own.
 */
export function automaticJsx(): { jsx: { runtime: "automatic" } } {
  return { jsx: { runtime: "automatic" } };
}

/**
 * ISS-10902. The number of Vitest lanes the CI test steps fan out to at once.
 *
 * Both steps that run this repo's suites in bulk pass `--concurrency=2` to
 * turbo on an 8-core ARM runner: `coverage-main.yml`'s `Run workspace tests
 * with coverage` and `pr-test.yml`'s `test-shard`. The number is spelled here
 * because {@link resolveLaneWorkers} divides by it.
 *
 * It is a copy of a number those two workflows own, so it is PINNED to them
 * rather than merely documented: `scripts/lint/vitest-lane-width-pin.test.ts`
 * reads both `run:` lines and fails when either stops saying this value. A
 * reader is not the failure mode — tune either step to a different fan-out
 * without that guard and every lane stays sized for the old one, oversubscribed
 * again with the width assertions still green.
 */
export const TURBO_TEST_LANE_CONCURRENCY = 2;

/**
 * ISS-10902. How many test files ONE Vitest lane may run at once.
 *
 * Vitest sizes its pool per RUN, not per machine: a config that declares no
 * width takes one worker per core. Turbo then starts
 * {@link TURBO_TEST_LANE_CONCURRENCY} of those runs at once, so two undeclared
 * lanes put ~14 workers on an 8-core runner and every one of them is a jsdom
 * building and tearing down React trees.
 *
 * Oversubscription of that shape does not cost throughput so much as it costs
 * the MEANING of a per-test budget. `testTimeout` is wall clock, so a test that
 * needs one second of CPU spends four waiting to be scheduled and trips a 5s
 * cap it was never close to on an idle runner — while the suite around it still
 * passes, which is what makes the failure read as one flaky test. Measured on
 * `coverage-main`: the same unchanged `apps/app` file took 1,077 ms on
 * 2026-09-21 and 5,077 ms on 2026-09-22, and 12 further tests in 7 other files
 * tipped over with it under a local reproduction of the two-lane shape.
 *
 * Bounding the width is what makes those budgets mean what they say. Raising
 * them only moves the cliff to the next-nearest test, which is what ISS-10512
 * and ISS-10750 each did before their fix went red again two runs later.
 * `apps/desktop` reached the same conclusion first and from the other side —
 * see `resolveLaneConcurrency` in `apps/desktop/scripts/node-test-lane-settings.mjs`
 * (ISS-6732, ISS-9275) — and that lane keeps its own resolver because its
 * width answers to a 4-core PR runner first: it takes 4 up to 8 cores, and only
 * above that half the machine, capped at 8 (ISS-12047).
 *
 * Deliberately NOT gated on `CI`: a budget that means one thing on a runner and
 * another on a laptop is the unreliability this exists to remove, so the width
 * is the same expression everywhere.
 *
 * That is ONE divisor against THREE real fan-outs, and the other two are not
 * equal to it. Stated rather than smoothed over, because each is a live cost:
 *
 * | bulk step | fan-out | each lane gets | versus this divisor |
 * |---|---|---|---|
 * | `coverage-main.yml` / `pr-test.yml` `test-shard` | 2 | cores/2 | exact |
 * | `pnpm test`, `pnpm test:affected` (local) | 2 | cores/2 | exact |
 * | `dagger call test` (`pnpm prepush`, `.dagger/src/index.ts`) | 1 | cores/2 | half the machine for contention that is not there |
 *
 * The divisor tracks the `--concurrency=2` steps because those are where these
 * 5,000 ms budgets are ADJUDICATED — a red there blocks a merge, and ISS-10902
 * is a red there. The dagger row is a speed cost on a local tier, not a
 * correctness one. The local row used to be 3, and that WAS a correctness cost:
 * on a 10-core host a full `pnpm test` at 3 timed out 7-11 tests that pass in
 * 0.5-1.9s alone, and at 2 it timed out none and finished sooner (ISS-12047).
 *
 * It is a CONSTANT rather than a read of the real fan-out because a task cannot
 * see one. `turbo.json` is `envMode: "strict"` and the `test` task passes
 * through only `DD_*`, so `TURBO_CONCURRENCY` is filtered out of the task
 * environment before a config could read it, and turbo's `--concurrency` flag
 * sets no variable at all. A runtime read would quietly resolve to its fallback
 * on every lane while looking like it tracked the real number. Making it track
 * would take a new pass-through variable in `turbo.json` plus a setter in each
 * of the three callers — a change to the task graph that nobody has ruled on,
 * and `turbo.json` churn is already implicated in this lane's instability.
 */
export function resolveLaneWorkers(): number {
  return laneWorkersFor(availableParallelism(), TURBO_TEST_LANE_CONCURRENCY);
}

/**
 * ISS-10902. {@link resolveLaneWorkers} with the machine passed in.
 *
 * Split out so the single-core branch is assertable on any host. The clamp is
 * load-bearing rather than defensive: a CPU-limited container reports one core,
 * the division floors to 0, and `maxWorkers: 0` is not "run serially" — it is a
 * pool Vitest cannot start.
 */
export function laneWorkersFor(cores: number, lanes: number): number {
  return Math.max(1, Math.floor(cores / lanes));
}
