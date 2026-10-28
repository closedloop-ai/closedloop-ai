/**
 * ISS-10132 — put Datadog's quarantine verdict IN the run's own artifacts.
 *
 * dd-trace applies Test Management quarantine INSIDE Playwright's runner: when
 * every failing test is quarantined it rewrites the runner's return value to
 * `passed`, so `pnpm test:e2e` exits 0. It does NOT rewrite the JSON reporter's
 * output — `stats.unexpected` still counts the failure and the test's own
 * `annotations` stay empty — so `assert-e2e-results.mjs` reddened the REQUIRED
 * `desktop-e2e` context anyway. 13 of the 14 desktop-e2e merge-group ejections
 * between 2026-09-09 and 09-12 were that, most recently runs 34669805188 and
 * 34669806655 (2026-09-12 03:14Z), each ejecting a merge group on a spec
 * dd-trace had already prevented from failing.
 *
 * The signal exists but only in memory: `processRootSuite` in dd-trace's
 * Playwright instrumentation tags each quarantined `TestCase` with
 * `_ddIsQuarantined` in the RUNNER process, which is the same process, and the
 * same objects, a Reporter is handed. This writes those tags to disk beside the
 * JSON report so the gate can read a verdict instead of inferring one from an
 * exit code — which is what ISS-5111 exists to stop anyone doing.
 *
 * It writes dd-trace's absorbed set, which is NARROWER than `_ddIsQuarantined`:
 * see `onTestEnd` for why an attempt-to-fix test carrying that tag is excluded.
 *
 * DELIBERATELY WRITES A FILE PER RUN, EVEN AN EMPTY ONE. "No quarantined tests"
 * and "this reporter never ran" must not look the same to the gate; only the
 * first is a statement. An absent file leaves the gate exactly where ISS-5111
 * left it, which is the safe direction, and the gate says so rather than
 * absorbing anything.
 *
 * Both tags are dd-trace PRIVATE fields, and they fail in opposite directions on
 * an upstream rename. `_ddIsQuarantined` renamed empties this report, and the
 * gate goes back to reddening on every quarantined failure — the pre-ISS-10132
 * status quo, not a new hole. `_ddIsAttemptToFix` renamed makes its clause
 * always true, which WIDENS the report back to every quarantined test: a
 * quarantined attempt-to-fix failure would be absorbed here while dd-trace left
 * it red. Nothing in this repo can detect that, so it is a reason to pin the
 * dd-trace version rather than a reason to trust the flag.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullConfig, Reporter, TestCase } from "@playwright/test/reporter";

/** Filename the gate looks for, resolved beside the JSON reporter's output. */
export const QUARANTINE_REPORT_FILENAME = "dd-quarantine.json";

type QuarantinedSpec = {
  file: string;
  line: number;
  title: string;
};

/**
 * The three fields the gate joins on. They are the SAME three the Playwright
 * JSON reporter writes per spec (`file` relative to `config.rootDir`, `line`,
 * `title`), so the gate compares like with like without either side inventing
 * an identifier the other has to reproduce.
 */
function quarantinedSpec(rootDir: string, test: TestCase): QuarantinedSpec {
  return {
    file: path.relative(rootDir, test.location.file),
    line: test.location.line,
    title: test.title,
  };
}

export default class DatadogQuarantineReporter implements Reporter {
  readonly #outputDir: string;
  #rootDir = "";
  readonly #specs: QuarantinedSpec[] = [];

  constructor(options: { outputDir?: string } = {}) {
    this.#outputDir = options.outputDir ?? process.cwd();
  }

  onBegin(config: FullConfig) {
    this.#rootDir = config.rootDir;
  }

  onTestEnd(test: TestCase) {
    const tags = test as {
      _ddIsAttemptToFix?: boolean;
      _ddIsQuarantined?: boolean;
    };
    // dd-trace's OWN absorbed set, mirrored rather than approximated.
    // `processRootSuite` sets `_ddIsQuarantined` on every quarantined test, but
    // only the ones that are not also attempt-to-fix join
    // `quarantinedButNotAttemptToFixFqns` — the set `runAllTests` counts before
    // rewriting its return to `passed`. So a quarantined attempt-to-fix test
    // that fails is one Datadog deliberately leaves RED, and Playwright exits 1
    // for it on purpose. Naming it here would have the gate absorb a failure the
    // runner did not, leaving the job red only through the wrapper status — the
    // droppable signal ISS-5111 exists to stop anyone leaning on.
    if (tags._ddIsQuarantined === true && tags._ddIsAttemptToFix !== true) {
      this.#specs.push(quarantinedSpec(this.#rootDir, test));
    }
  }

  onEnd() {
    mkdirSync(this.#outputDir, { recursive: true });
    writeFileSync(
      path.join(this.#outputDir, QUARANTINE_REPORT_FILENAME),
      `${JSON.stringify({ quarantinedSpecs: this.#specs }, null, 2)}\n`
    );
  }
}
