import { dirname, resolve } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { drainDeferredTeardownWork } from "../../typescript-config/vitest-teardown-drain";
import { importsOf, parseSourceFileAt } from "../shared/testing/source-ast";

/**
 * ISS-9696. A drain that schedules on the GLOBAL `setImmediate`/`setTimeout`
 * never resolves once a test file has installed fake timers over them, so the
 * regression signature is a HANG, not an assertion. Each wait below carries an
 * explicit timeout so that regression lands as a fast, named red rather than a
 * wall-clock kill; the registered hook is bounded separately by Vitest's own
 * `hookTimeout`.
 */
const DRAIN_TIMEOUT_MS = 2000;

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/** The module whose import is the whole of the drain's production wiring. */
const DRAIN_MODULE = resolve(
  REPO_ROOT,
  "packages/typescript-config/vitest-teardown-drain"
);

/**
 * Every setup file that registers the drain for a real Vitest project. This
 * spec's own import registers the hook too, so every runtime assertion below
 * stays green with the production wiring deleted — measured on this branch, both
 * cases still passed with `packages/app/vitest.setup.ts`'s import removed. Only
 * a structural read of the setup files fails on that mutation, and AGENTS.md →
 * "Test Practices" makes the parsed AST, not a text scan, the way to do it.
 *
 * Declared with the other constants rather than at the bottom of the file: the
 * `it.each` below reads it while the module is still evaluating.
 */
const DRAIN_SETUP_FILES = [
  "packages/app/vitest.setup.ts",
  "apps/storybook/vitest.setup.ts",
];

/**
 * The restore must not sit at the end of a test body: the regression this file
 * guards is a TIMEOUT, so an in-body restore is exactly the statement that never
 * runs on the failing path, leaving a Sinon clock installed for every later hook
 * in the worker. `afterEach` runs either way.
 */
afterEach(() => {
  vi.useRealTimers();
});

// The control. It passes either way — only the fake-timers case below
// discriminates — and it is here so a green fake-timers case cannot be read as
// the drain having quietly restored real timers to get itself unstuck.
it(
  "drains under real timers",
  async () => {
    vi.useRealTimers();

    await drainDeferredTeardownWork();

    expect(vi.isFakeTimers()).toBe(false);
  },
  DRAIN_TIMEOUT_MS
);

it(
  "drains while fake timers are installed",
  async () => {
    vi.useFakeTimers();

    await drainDeferredTeardownWork();

    expect(vi.isFakeTimers()).toBe(true);
  },
  DRAIN_TIMEOUT_MS
);

it.each(DRAIN_SETUP_FILES)("%s imports the teardown drain", (relativePath) => {
  const setupFile = resolve(REPO_ROOT, relativePath);

  const edges = importsOf(parseSourceFileAt(setupFile))
    .filter((edge) => !edge.computed)
    .map((edge) => resolve(dirname(setupFile), edge.specifier));

  expect(edges).toContain(DRAIN_MODULE);
});

/**
 * Leaves the file ending in exactly the state ISS-9696 says must not hang, so
 * the module's REGISTERED `afterAll` — not the direct call above — also runs
 * against an unadvanced fake clock. Vitest runs `afterAll` hooks in reverse
 * registration order, and the drain registered its own at module load, before
 * this one, so this runs first no matter which tests precede it.
 */
afterAll(() => {
  vi.useFakeTimers();
});
