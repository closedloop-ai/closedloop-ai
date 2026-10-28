/**
 * Change-scoped selection for the `desktop-e2e` lane (ISS-10407).
 *
 * Turns two environment inputs into the `grep` Playwright runs with. The
 * decision lives here, in one pure function, rather than in the workflow's shell
 * — `.github/workflows/e2e-test.yml` threads the Electron run through
 * `dbus-run-session` and `xvfb-run`, whose option parsers are already documented
 * in that file as mangling flags they were not expecting, so a CLI argument is
 * the one place this must NOT be decided.
 *
 * FAIL OPEN, ALWAYS. `undefined` means "run everything", and every ambiguous
 * input resolves to it: no smoke tag, an empty changed-spec list, a changed-spec
 * entry that does not name a real top-level spec. That direction is the whole
 * safety story. `desktop-e2e` is a REQUIRED context, so a selection that is
 * wrong in the narrowing direction produces a green check over a suite that
 * never ran the thing it was meant to — which is strictly worse than paying for
 * the full lane. State that price honestly, because it is the whole cost of this
 * direction: ISS-6018 measured the full lane at 16.6m, and measured again
 * 2026-09-16 over 63 merge groups that RAN it (skips excluded — a skipped job is
 * not a fast one) it is p50 36.4m / p95 37.5m. Failing open
 * therefore costs ~36 minutes of merge dwell, not ~17 — and is still the right
 * trade, because the alternative buys those minutes back with a green check over
 * an unexamined regression.
 *
 * WHY A FILENAME GREP IS SOUND HERE. Playwright matches `grep` against a test's
 * full title path, which begins with the spec's path, so
 * `first-launch-dashboard-welcome\.spec\.ts` selects every test in that file.
 * Verified against this repo's pinned Playwright: `--grep
 * "first-launch-dashboard-welcome"` listed exactly the two tests in
 * `first-launch-dashboard-welcome.spec.ts` and nothing else.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never widens by guessing. A changed
 * helper, fixture, page object, or `playwright.config.ts` is not a spec, so it
 * never reaches `changedSpecs`, and the caller (the workflow's classifier step)
 * is what must send an empty list in that case — the same division ISS-5449 drew
 * for the browser lane, where the classifier owns "is this narrowable" and the
 * runner owns "narrow it".
 */

import { DESKTOP_SMOKE_SPECS } from "./e2e-smoke-specs.ts";

/** A top-level Electron spec basename and nothing else — no path, no traversal. */
const SPEC_BASENAME = /^[A-Za-z0-9._-]+\.spec\.ts$/;

/** Whitespace between entries in the changed-spec list the workflow emits. */
const LIST_SEPARATOR = /\s+/;

/** Regex metacharacters, escaped so a spec name reaches Playwright as text. */
const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/g;

/** The inputs a run is narrowed by, read from the environment. */
export type SelectionEnv = {
  /**
   * Non-empty when the lane should narrow at all. Carries the tag token for
   * parity with the browser lane's `E2E_SMOKE_TAG`, but this lane selects by
   * filename, so only its emptiness is read.
   */
  readonly smokeTag?: string;
  /** Whitespace-separated spec basenames the PR itself changed. */
  readonly changedSpecs?: string;
};

/**
 * Every basename the run should execute, or `undefined` for the full suite.
 *
 * Exported separately from `selectionGrep` so a guard can assert the SET a given
 * environment selects without going through a regular expression to do it.
 */
export function selectedSpecFiles(
  env: SelectionEnv
): readonly string[] | undefined {
  if (!env.smokeTag?.trim()) {
    return undefined;
  }

  const changed = (env.changedSpecs ?? "")
    .split(LIST_SEPARATOR)
    .filter((entry) => entry.length > 0);

  // One unusable entry puts the whole run back on the full suite rather than
  // silently dropping that entry. A name this function cannot select is a name
  // the classifier believed WAS covered, so honouring the rest of the list would
  // report a narrowed green over exactly the spec that went unexamined.
  if (changed.some((entry) => !SPEC_BASENAME.test(entry))) {
    return undefined;
  }

  const smoke = DESKTOP_SMOKE_SPECS.map((spec) => spec.file);
  const union = [...new Set([...smoke, ...changed])];

  // Cannot happen while the manifest is non-empty, and is not left to that
  // assumption: an empty grep alternation matches everything, so the one shape
  // that must never reach Playwright is the one an emptied manifest would build.
  return union.length > 0 ? union : undefined;
}

/**
 * The `grep` value for `playwright.config.ts`, or `undefined` to run everything.
 *
 * Anchored on both sides. Unanchored, `branch-details.spec.ts` would also select
 * `branch-details-timeline.spec.ts`, quietly widening the lane — harmless here,
 * but the same looseness in the other direction is how a narrowed lane starts
 * selecting the wrong file entirely.
 */
export function selectionGrep(env: SelectionEnv): RegExp | undefined {
  const files = selectedSpecFiles(env);
  if (!files) {
    return undefined;
  }

  const alternation = files.map(escapeForRegex).join("|");
  return new RegExp(`(^|[\\s›/])(${alternation})(\\s|$|:)`);
}

/** Reads the two inputs this lane narrows by from a process environment. */
export function selectionFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RegExp | undefined {
  return selectionGrep({
    smokeTag: env.DESKTOP_E2E_SMOKE_TAG,
    changedSpecs: env.DESKTOP_E2E_CHANGED_SPECS,
  });
}

function escapeForRegex(value: string): string {
  return value.replace(REGEX_METACHARACTER, String.raw`\$&`);
}

/**
 * ISS-9871. The post-merge lane's slice of the suite, from `DESKTOP_E2E_SHARD`
 * as `i/n`, or null for the whole suite. It narrows a LEG, never a run: the
 * lane's legs together cover every spec, and its fan-in posts no verdict
 * unless every leg reported. Anything but a well-formed `i/n` with
 * `1 <= i <= n` is the whole suite, in keeping with the rest of this module.
 */
export function shardFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { current: number; total: number } | null {
  const match = SHARD_PATTERN.exec(env.DESKTOP_E2E_SHARD?.trim() ?? "");
  if (!match) {
    return null;
  }
  const current = Number(match[1]);
  const total = Number(match[2]);
  return current >= 1 && current <= total ? { current, total } : null;
}

/**
 * ISS-9871. Workers from `DESKTOP_E2E_WORKERS`, defaulting to the 2 the queue
 * tier has always run. The test-only gateway policy isolates binds and profile
 * discovery writes. The test policy permits overrides through 14 independently
 * of the production probe port count.
 */
export function workersFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DESKTOP_E2E_WORKERS?.trim() ?? "";
  const workers = WORKERS_PATTERN.test(raw) ? Number(raw) : Number.NaN;
  return workers >= 1 && workers <= MAX_WORKERS ? workers : DEFAULT_WORKERS;
}

const SHARD_PATTERN = /^(\d{1,3})\/(\d{1,3})$/;
const WORKERS_PATTERN = /^[1-9]\d?$/;
const DEFAULT_WORKERS = 2;
export const MAX_WORKERS = 14;
