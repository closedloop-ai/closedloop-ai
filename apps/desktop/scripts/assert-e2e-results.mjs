#!/usr/bin/env node
// ISS-5111: assert the Electron e2e suite actually reported zero failures.
//
// `desktop-e2e` is a REQUIRED check and was observed reporting success on a run
// whose Playwright summary read `1 failed / 60 passed` — the suite failed on its
// first attempt AND on `retries: 1`, and the job still exited 0. The loss is
// intermittent (a contrast run in the same workflow propagated `2 failed`
// correctly, with the `[ELIFECYCLE]` line present), which points at a teardown
// race in the `dbus-run-session -- bash -c '… xvfb-run -a …'` wrapper clobbering
// `$?` rather than a constant swallow.
//
// The run step now propagates its status explicitly, but an exit code that a
// wrapper can intermittently drop must not be the ONLY thing standing between a
// red suite and `main`. This reads Playwright's own JSON reporter output and
// fails the job on any unexpected result, whatever the wrapper returned.
//
// FAIL-CLOSED. A missing or unparseable report is a FAILURE, not a pass: the
// exact scenario this guards is "the suite died and the exit code was lost",
// and in that scenario the report may never be written. "I could not prove the
// suite passed" and "the suite passed" must not be the same outcome — treating
// absence as success would reintroduce the bug through the guard meant to close
// it.
//
// Four independent conditions redden the gate, and each failure message names
// which one tripped so a reader can tell them apart without re-reading the log:
//
//  1. RUNNER-LEVEL FAILURE — a top-level `errors` entry that is NOT
//     teardown-class. This is the documented signature failure of THIS suite
//     (apps/desktop/test/AGENTS.md): importing a main-process module into a spec
//     aborts the ENTIRE suite at load time, which lands in `errors[]` with
//     `stats.unexpected` still 0. Any check keyed only on `unexpected` passes
//     exactly the failure that motivated this guard.
//
//     ISS-5804 narrowed this by ERROR SHAPE, never by stats. Playwright also
//     reports a worker TEARDOWN timeout through `errors[]`, and that one is
//     emitted AFTER the worker's specs have already reported their results — the
//     suite has a real verdict and, in the observed case, every spec passed.
//     Treating it like a load abort reddened the required `desktop` context on a
//     run where nothing failed, and PR #4569 was force-merged past it.
//
//     Tolerating it is safe only because conditions 2 and 3 still run below: a
//     teardown error on a suite that produced NO outcomes is still NOTHING RAN,
//     and one alongside a genuinely failed spec is still SPEC FAILURES.
//
//     Do NOT widen this to "ignore runner errors when `unexpected` is 0". That
//     reopens the hole for a PARTIAL abort — some specs run, then a load error
//     kills the rest — which leaves non-zero stats and a fatal error this gate
//     would then wave through. The discriminator must stay keyed on the error.
//  2. NOTHING RAN — expected + skipped + unexpected + flaky all zero. A suite
//     that produced no outcome proves nothing, and a swallowed wrapper status
//     would otherwise turn it into a green required check.
//  3. SPEC FAILURES — `stats.unexpected > 0`.
//
//     ISS-10132 narrowed this by DATADOG QUARANTINE, and only ever by a spec
//     the run NAMED as quarantined. dd-trace applies Test Management quarantine
//     inside Playwright's runner — a run whose every failure is quarantined
//     returns `passed` and exits 0 — but it never rewrites this report, so
//     `unexpected` still counted them and this gate ejected the merge group
//     anyway. Measured over EVERY `merge_group` run whose `desktop-e2e` job
//     failed between 2026-09-09 and 2026-09-12 — 14 of them. 13 printed no pnpm
//     `[ELIFECYCLE]` line, so Playwright had exited 0 and dd-trace had already
//     prevented-to-fail; the 1 that DID print it is the unquarantined control.
//     `SPEC FAILURES` failed all 14.
//
//     `dd-quarantine-reporter.ts` writes dd-trace's `_ddIsQuarantined` tags
//     beside this report and the partition below drops exactly the specs it
//     names — and only the ones dd-trace ITSELF absorbs, which excludes a
//     quarantined attempt-to-fix test, one the runner leaves red on purpose.
//
//     This is NOT the "clear condition 3 when the wrapper exited 0" shortcut,
//     which would reopen the droppable-exit-code hole ISS-5111 exists to close.
//     The wrapper's exit code is not read here and is still re-raised by both
//     callers. Three things keep the narrowing from widening into that:
//       - an absent, unreadable or wholly malformed quarantine report absorbs
//         NOTHING, and a single entry short of its three join fields contributes
//         no key, so the VERDICT is its pre-ISS-10132 self on every such input
//         (the failure message gained a clause, so the text is not identical);
//       - a failing spec the report does not name still reddens, whatever else
//         is quarantined alongside it;
//       - `unexpected > 0` with NO namable failing spec still reddens, because a
//         failure this gate cannot name is not one it can match against a list.
//
//     The trade it settles is on the record: ISS-6377 (quarantine-on) against
//     ISS-5111 (fail-closed), on a REQUIRED context.
//  4. CONTRACT CHANGE / unreadable report — see `readReport` and the
//     `stats.unexpected` type check below.
//
// THREE VERDICTS, not two (ISS-5804). Exit 0 is a clean pass. Exit 1 is one of
// the four conditions above. Exit `TEARDOWN_TOLERATED_EXIT` is "the run is green
// AND a worker teardown error was tolerated" — a PASS that callers may act on.
//
// That third verdict exists because tolerating the error here was necessary but
// not sufficient: Playwright's own process exits 1 whenever `teardownErrors` is
// non-empty, even with every spec green, and both workflow callers capture that
// wrapper status and re-raise it last. Until this told the two apart, the
// required check still went red on exactly the run ISS-5804 targets, whatever
// this script said. Keying the clearance on the VERDICT rather than on the exit
// code is what keeps it narrow: an unrelated wrapper failure — a crash, an OOM,
// a non-Playwright step — never produces this exit, because reaching it means
// all four conditions above already passed.
//
// `flaky` is deliberately NOT a failure; see the note at its use below.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Defaults to the reporter's real output path; an explicit argument exists so
// the guard test can drive this against fixture reports instead of only being
// asserted by source-reading.
const REPORT_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(
      import.meta.dirname,
      "..",
      "playwright-report-e2e",
      "results.json"
    );

/** Exit non-zero with a message the CI log surfaces without a 7-minute grep. */
function fail(message) {
  process.stderr.write(`e2e result assertion FAILED: ${message}\n`);
  process.exit(1);
}

function readReport() {
  let raw;
  try {
    raw = readFileSync(REPORT_PATH, "utf8");
  } catch (error) {
    fail(
      `could not read the Playwright JSON report at ${REPORT_PATH} (${error instanceof Error ? error.message : String(error)}). The suite may have died before writing it — treating an absent report as a pass is exactly the failure mode ISS-5111 closes.`
    );
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `the Playwright JSON report at ${REPORT_PATH} is not valid JSON (${error instanceof Error ? error.message : String(error)}); a truncated report means the run did not finish cleanly.`
    );
    return null;
  }
}

/**
 * Collect the titles of specs that ended in an unexpected status, so the failure
 * message names them instead of making someone grep the log.
 */
function failingTitles(report) {
  const titles = [];
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.ok !== true) {
        titles.push(specKey(spec));
      }
    }
    for (const child of suite.suites ?? []) {
      visitSuite(child);
    }
  };
  for (const suite of report.suites ?? []) {
    visitSuite(suite);
  }
  return titles;
}

/**
 * Read one outcome tally. The reporter omits a tally it has no value for, and an
 * absent tally contributes nothing — it must never be counted as an outcome, or
 * the "nothing ran" check below could be satisfied by a missing field.
 */
function statCount(stats, key) {
  return typeof stats[key] === "number" ? stats[key] : 0;
}

/**
 * ISS-5804. Worker teardown outlives the worker's specs, so a timeout here is
 * reported after those specs have already recorded their results — the run has a
 * verdict and this error does not contradict it. Deliberately narrow: it matches
 * the teardown timeout ONLY, not "worker process exited unexpectedly", which can
 * mean a crash mid-suite that really did cost results.
 *
 * ANCHORED TO THE WHOLE FIRST LINE, both ends, and never searched across the
 * rest of the message. The `errors[]` entry is multi-line in practice: Playwright
 * appends its "Failed worker ran N tests:" block — a list of SPEC TITLES — to the
 * same entry. Spec titles are PR-controlled, so a whole-message search let any PR
 * mark an unrelated FATAL error tolerated just by naming a spec "Worker teardown
 * timeout of doom", waving through the exact load abort this gate exists to catch
 * (whitlockk, PR #4731). The header is the only part of the entry Playwright itself
 * writes, so it is the only part that may decide this.
 *
 * Matched loosely WITHIN that line rather than pinned to the duration: were a
 * future Playwright format to reword the header, the match would simply not fire
 * and the gate would redden — the status quo, not a new hole.
 */
const WORKER_TEARDOWN_TIMEOUT_HEADER =
  /^Worker teardown timeout of .*exceeded\.$/;

/**
 * The third verdict (see the header): PASSED, and a worker teardown error was
 * tolerated on the way. Distinct from 0 so a caller can tell "clean" from
 * "green despite a teardown error" and clear Playwright's own exit 1 for the
 * latter only. Any value outside 0/1 works; 78 is far from both Node's own
 * codes and Playwright's, so a stray exit can never be mistaken for it.
 */
const TEARDOWN_TOLERATED_EXIT = 78;

/**
 * SGR colour escapes. Playwright colourizes the header in segments — including
 * around the timeout's own number — so the raw first line does not begin with
 * `Worker` and would never satisfy a `^` anchor. Stripping these is what the
 * anchor above costs, and the guard test drives a fixture carrying the real
 * escape bytes so the normalization is proven rather than assumed.
 *
 * Built from a char code rather than written as a literal: a raw ESC byte in
 * source is invisible in a diff and easy to delete by accident.
 */
const ANSI_SGR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g"
);

function normalizedFirstLine(message) {
  const [firstLine] = message.split("\n");
  return firstLine.replace(ANSI_SGR_PATTERN, "").trim();
}

/**
 * A runner error the gate tolerates.
 *
 * KNOWN CEILING: if a teardown timeout ever caused a worker's already-run specs
 * to be dropped from the report entirely, their absence would not be visible
 * here, and the surviving workers' outcomes would carry the run. Closing that
 * needs cross-checking the "Failed worker ran N tests" list against the reported
 * specs, which is more machinery than the observed failure justifies.
 */
function isToleratedRunnerError(message) {
  return WORKER_TEARDOWN_TIMEOUT_HEADER.test(normalizedFirstLine(message));
}

/**
 * Runner-level failures — a spec that fails to LOAD, a global-setup throw, a
 * worker crash before any test — land here, not in `stats.unexpected`.
 */
function runnerErrorMessages(report) {
  const errors = Array.isArray(report.errors) ? report.errors : [];
  return errors.map((error) => {
    if (typeof error?.message === "string") {
      return error.message;
    }
    if (typeof error?.stack === "string") {
      return error.stack;
    }
    return JSON.stringify(error);
  });
}

// Written by `dd-quarantine-reporter.ts` into the same directory, so the two
// artifacts move together and a caller redirecting the report cannot silently
// leave the gate reading a stale quarantine verdict from the default path.
const QUARANTINE_REPORT = "dd-quarantine.json";

/**
 * How one spec is named, for a human reading the failure AND for the ISS-10132
 * join against the quarantine report. ONE formatter, because the two sides are
 * compared: a second copy of this template is a join that silently stops
 * matching and a gate that silently stops absorbing.
 */
function specKey(spec) {
  return `${spec.file ?? "?"}:${spec.line ?? "?"} › ${spec.title}`;
}

/**
 * The quarantine verdict `dd-quarantine-reporter.ts` wrote beside this report,
 * as the SAME `file:line › title` keys `failingTitles` builds — so neither side
 * invents an identifier the other has to reproduce.
 *
 * Best-effort BY DESIGN, and in exactly one direction: no reporter, no tracer,
 * no key, an unparseable file — each yields an EMPTY set, and an entry short of
 * its three join fields contributes NO key, so the worst a reshaped file can do
 * is absorb less. It is never an error, because a missing quarantine verdict is
 * not evidence about the suite — it is the absence of a reason to be lenient.
 */
function readQuarantinedKeys() {
  const keys = new Set();
  let parsed;
  try {
    parsed = JSON.parse(
      readFileSync(
        path.join(path.dirname(REPORT_PATH), QUARANTINE_REPORT),
        "utf8"
      )
    );
  } catch {
    return keys;
  }
  for (const spec of Array.isArray(parsed?.quarantinedSpecs)
    ? parsed.quarantinedSpecs
    : []) {
    if (isNamedSpec(spec)) {
      keys.add(specKey(spec));
    }
  }
  return keys;
}

/**
 * All three join fields present and usable — the precondition for a quarantine
 * entry to be a STATEMENT about a spec rather than a shape this gate happens to
 * survive parsing.
 *
 * `specKey` renders an absent `file` or `line` as `?`, so an entry short of one
 * would key as `?:? › title` and match a FAILING spec the report left equally
 * unnamed: a reshaped quarantine report absorbing a failure neither side can
 * identify, which is the opposite of what `readQuarantinedKeys` promises
 * (whitlockk, PR #7187).
 */
function isNamedSpec(spec) {
  return (
    typeof spec?.file === "string" &&
    spec.file.length > 0 &&
    Number.isInteger(spec?.line) &&
    spec.line > 0 &&
    typeof spec?.title === "string" &&
    spec.title.length > 0
  );
}

const report = readReport();
const stats = report?.stats;
if (!stats || typeof stats.unexpected !== "number") {
  fail(
    "the Playwright JSON report has no numeric `stats.unexpected`; the reporter contract changed or the run did not complete."
  );
}

// Condition 1: a runner-level failure. `stats.unexpected` is 0 for a suite that
// aborted at load time, so this MUST be checked independently of it — it is the
// signature failure apps/desktop/test/AGENTS.md documents for this suite.
// Teardown-class errors are partitioned out per ISS-5804; see the header for why
// that is keyed on the error and not on the stats.
const runnerErrors = runnerErrorMessages(report);
const fatalRunnerErrors = runnerErrors.filter(
  (message) => !isToleratedRunnerError(message)
);
if (fatalRunnerErrors.length > 0) {
  fail(
    `RUNNER-LEVEL FAILURE: the Playwright JSON report carries ${fatalRunnerErrors.length} top-level error(s), which means the run itself failed (for example a spec that aborted the suite at load time) rather than an individual spec failing. \`stats.unexpected\` is ${stats.unexpected} and does NOT reflect these:\n${fatalRunnerErrors.map((message) => `  - ${message}`).join("\n")}`
  );
}

// Loud, not silent. A tolerated error still means the harness misbehaved, and
// the annotation is what stops this from quietly becoming the normal state.
const toleratedRunnerErrors = runnerErrors.filter(isToleratedRunnerError);
if (toleratedRunnerErrors.length > 0) {
  process.stderr.write(
    `::warning::e2e runner reported ${toleratedRunnerErrors.length} teardown-class error(s) after the suite had already produced its verdict; not treated as a suite failure (ISS-5804).\n${toleratedRunnerErrors.map((message) => `  - ${message}`).join("\n")}\n`
  );
}

const unexpected = stats.unexpected;
// `flaky` is a PASS: the spec failed an attempt and succeeded on retry, which is
// the behavior `retries: 1` exists to absorb. Only `unexpected` (failed every
// attempt) reddens the gate — matching what the human-readable summary calls
// `N failed`. It still counts as an OUTCOME for the "nothing ran" check below.
const flaky = statCount(stats, "flaky");
const expected = statCount(stats, "expected");
const skipped = statCount(stats, "skipped");
const outcomes = expected + skipped + unexpected + flaky;

// Condition 2: nothing ran. A report with no outcome at all proves nothing about
// the suite, so accepting it would let a swallowed wrapper status keep producing
// the green required check ISS-5111 exists to stop.
if (outcomes === 0) {
  fail(
    "NOTHING RAN: the Playwright JSON report records zero outcomes (expected + skipped + unexpected + flaky all 0). An empty run cannot prove the suite passed, and treating it as a pass is the failure mode ISS-5111 closes."
  );
}

// Condition 3: individual specs failed every attempt, minus the ones Datadog
// quarantine already absorbed inside the runner (ISS-10132).
const quarantinedKeys = readQuarantinedKeys();
let absorbedTitles = [];
if (unexpected > 0) {
  const titles = failingTitles(report);
  // A failing spec this gate could not name cannot be matched against the
  // quarantine list, so it can never be absorbed — `titles` being short of
  // `unexpected` means the report shape changed, which is a reason to redden.
  const unabsorbed =
    titles.length === unexpected
      ? titles.filter((title) => !quarantinedKeys.has(title))
      : titles;
  absorbedTitles = titles.filter((title) => quarantinedKeys.has(title));

  if (unabsorbed.length > 0 || titles.length !== unexpected) {
    fail(
      `SPEC FAILURES: ${unexpected} spec(s) failed every attempt, ${unabsorbed.length} of them NOT quarantined in Datadog:\n${unabsorbed.map((title) => `  - ${title}`).join("\n")}`
    );
  }

  // Loud, never silent — the same treatment as a tolerated teardown error. A
  // quarantined spec that keeps failing is still a spec nobody is gating on.
  process.stderr.write(
    `::warning::e2e suite had ${unexpected} failing spec(s), ALL of them quarantined in Datadog Test Management; not treated as a suite failure (ISS-10132). Quarantine is not coverage — each of these is ungated until its tag comes off:\n${absorbedTitles.map((title) => `  - ${title}`).join("\n")}\n`
  );
}

// The tolerated count is reported rather than folded into "0 runner errors" —
// a pass that silently absorbed a harness error would misdescribe the run.
process.stdout.write(
  `e2e result assertion passed: ${unexpected} unexpected (${absorbedTitles.length} Datadog-quarantined), 0 fatal runner errors (${toleratedRunnerErrors.length} tolerated), ${expected} passed, ${skipped} skipped, ${flaky} flaky.\n`
);

// Reached only after every condition above passed, so this cannot report a
// tolerated teardown on a run that failed for any other reason — which is the
// whole reason a caller is allowed to clear a wrapper exit on the strength of it.
if (toleratedRunnerErrors.length > 0) {
  process.exit(TEARDOWN_TOLERATED_EXIT);
}
