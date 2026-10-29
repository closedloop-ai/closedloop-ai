import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

// ISS-7168. The three apps/api Vitest configs partition this app's suites, and
// the partition is expressed only as globs across three separate files. Two
// silent failure modes live in that gap, and neither shows up as a red test:
//
//   1. A file collected by NEITHER tier passes by not existing. This is the
//      worse one — a whole suite disappears and the run stays green.
//   2. A file collected by BOTH tiers runs twice, once under the wrong
//      timeout. That is what shipped: `.integration.test.ts` suites hit real
//      Postgres, but the base config excluded only the
//      `__tests__/integration/` DIRECTORY, so the ones co-located beside their
//      source under `app/`/`lib/` were collected by the unit tier at Vitest's
//      5s default while the whole turbo fan-out contended for one database. A
//      genuine regression in them was indistinguishable from ambient flake.
//
// So assert the partition itself, against the real config files resolved by
// the real Vitest resolver, rather than trusting three glob lists to stay in
// agreement by inspection.

const TEST_FILE_PATTERN = /\.test\.tsx?$/;
const INTEGRATION_SUFFIX_PATTERN = /\.integration\.test\.ts$/;
const IGNORED_DIRECTORY_PATTERN = /^(?:node_modules|dist|\.next|\.turbo)$/;

// `__tests__/health.test.ts` is deliberately in two tiers: the compatibility
// config names it alongside `__tests__/compatibility/**` so the deployed-shape
// run always includes a liveness check, and the unit tier keeps it as an
// ordinary suite. Pinned as the ONE permitted overlap so a future accidental
// one cannot hide behind a blanket allowance.
const PERMITTED_UNIT_COMPATIBILITY_OVERLAP = ["__tests__/health.test.ts"];

// The three lanes, in the spelling `--vitest-config` takes.
const TIER_CONFIG_FILES = [
  "vitest.config.mts",
  "vitest.config.compatibility.mts",
  "vitest.config.integration.mts",
];

const APP_ROOT = path.resolve(import.meta.dirname, "..");
// Where `pnpm mutation` spawns Stryker, and therefore where Vitest roots itself
// for a repo-root-sandbox run (ISS-7952).
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const RESOLVE_TIMEOUT_MS = 60_000;
// Vitest's own per-test default. The integration tier exists precisely because
// a real-Postgres suite cannot finish inside it under CI contention.
const VITEST_DEFAULT_TIMEOUT_MS = 5000;
/**
 * The CEILING on the tier's own budget, and the counterpart to the floor below
 * it — SHRINK-ONLY, like the grandfather ledger it backstops.
 *
 * ISS-8553 made the tier the sole owner of the number: fifteen per-suite budgets
 * were deleted, and `integration-suite-timeout-budget.test.ts` now holds every
 * collected suite to whatever `vitest.config.integration.mts` resolves. A floor
 * alone leaves that number free upward, so raising `testTimeout` to 300_000 in
 * one line would keep this suite green, keep the budget guard green, keep the
 * ledger at one entry, and hand every suite back the 299s declaration the ledger
 * exists to refuse. That is the same widening arriving through the config
 * instead of the ledger.
 *
 * The value is the job's, not a preference. `api-integration-tests` caps at
 * `timeout-minutes: 15` and a normal run spends ~520s of it, so ~380s is the
 * whole spare headroom shared by ~124 suites; a per-test bound anywhere near
 * that cannot fail loudly, it can only reap the job. Raising it is a deliberate
 * edit to this line with the headroom argument made in the PR — never a side
 * effect of a config change.
 */
const INTEGRATION_TIER_MAX_TIMEOUT_MS = 30_000;

type ResolvedTier = {
  files: string[];
  setupFiles: string[];
  testTimeout: number | undefined;
  hookTimeout: number | undefined;
};

async function resolveTier(
  configFileName: string,
  root: string = APP_ROOT
): Promise<ResolvedTier> {
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    root,
    // Vitest scopes discovery to `dir` but keeps resolving every other relative
    // path against `root`, which is exactly the split a repo-root run exposes.
    ...(root === APP_ROOT ? {} : { dir: APP_ROOT }),
    config: path.join(APP_ROOT, configFileName),
  });
  try {
    const specifications = await vitest.globTestSpecifications();
    const unique = new Set(
      specifications.map((specification) =>
        path.relative(APP_ROOT, specification.moduleId)
      )
    );
    return {
      files: [...unique].sort(),
      setupFiles: [...vitest.config.setupFiles],
      testTimeout: vitest.config.testTimeout,
      hookTimeout: vitest.config.hookTimeout,
    };
  } finally {
    await vitest.close();
  }
}

async function collectedFiles(configFileName: string): Promise<string[]> {
  return (await resolveTier(configFileName)).files;
}

async function testFilesOnDisk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY_PATTERN.test(entry.name)) {
        found.push(...(await testFilesOnDisk(absolute)));
      }
      continue;
    }
    if (TEST_FILE_PATTERN.test(entry.name)) {
      found.push(path.relative(APP_ROOT, absolute));
    }
  }
  return found;
}

describe("apps/api Vitest tier partition (ISS-7168)", () => {
  it(
    "assigns every suite on disk to exactly one tier, with the DB-backed suffix in the integration tier",
    async () => {
      const [unit, integrationTier, compatibility, onDisk] = await Promise.all([
        collectedFiles("vitest.config.mts"),
        resolveTier("vitest.config.integration.mts"),
        collectedFiles("vitest.config.compatibility.mts"),
        testFilesOnDisk(APP_ROOT),
      ]);
      const integration = integrationTier.files;

      // Membership is only half the fix — the other half is the budget these
      // suites were moved here to get. Without this, deleting `testTimeout`
      // from the integration config restores the exact 5s-under-contention
      // failure ISS-7168 is about, and the partition assertions below stay
      // green because the partition itself is unchanged.
      expect(integrationTier.testTimeout).toBeGreaterThan(
        VITEST_DEFAULT_TIMEOUT_MS
      );
      expect(integrationTier.hookTimeout).toBeGreaterThan(
        VITEST_DEFAULT_TIMEOUT_MS
      );
      // ...and bounded above, because the budget guard measures every collected
      // suite against THIS number. Without a ceiling the guard's expectation is
      // whatever the config says, so the widening the ledger refuses arrives
      // one line over instead.
      expect(integrationTier.testTimeout).toBeLessThanOrEqual(
        INTEGRATION_TIER_MAX_TIMEOUT_MS
      );
      expect(integrationTier.hookTimeout).toBeLessThanOrEqual(
        INTEGRATION_TIER_MAX_TIMEOUT_MS
      );

      // The suffix marks a real-Postgres suite wherever it lives. Every one of
      // them belongs to the integration tier, which budgets 30s and runs with
      // `--no-file-parallelism`.
      const suffixed = onDisk
        .filter((file) => INTEGRATION_SUFFIX_PATTERN.test(file))
        .sort();
      expect(suffixed.length).toBeGreaterThan(0);
      expect(integration).toEqual(expect.arrayContaining(suffixed));

      // ...and to no other tier. Reverting the base config's suffix exclusion
      // puts them back in the unit tier at the 5s default; this is the
      // assertion that catches it.
      const suffixedInUnit = unit.filter((file) =>
        INTEGRATION_SUFFIX_PATTERN.test(file)
      );
      expect(suffixedInUnit).toEqual([]);

      // No suite runs twice under two different timeouts.
      const integrationSet = new Set(integration);
      expect(unit.filter((file) => integrationSet.has(file))).toEqual([]);

      const compatibilitySet = new Set(compatibility);
      expect(integration.filter((file) => compatibilitySet.has(file))).toEqual(
        []
      );
      expect(unit.filter((file) => compatibilitySet.has(file))).toEqual(
        PERMITTED_UNIT_COMPATIBILITY_OVERLAP
      );

      // And nothing falls through the gap between the three globs. A dropped
      // file is invisible in a green run, so it gets its own assertion.
      const collected = new Set([...unit, ...integration, ...compatibility]);
      const orphans = onDisk.filter((file) => !collected.has(file)).sort();
      expect(orphans).toEqual([]);
    },
    RESOLVE_TIMEOUT_MS
  );

  // ISS-7952. `pnpm mutation apps/api/...` runs Stryker in a repo-root sandbox,
  // so Vitest's `root` is the repo root and only `dir` points at this app.
  // `setupFiles` is resolved against `root`, so the cwd-relative
  // `./__tests__/setup.ts` became `<repo>/__tests__/setup.ts` there, failed to
  // load, and reported all 35 related suites as "no tests" — a mutation run
  // that cannot start, presenting as unresolved imports.
  //
  // EVERY lane, not just the unit one: `ROOT_SANDBOX_PACKAGES` in
  // scripts/mutation/run.mjs is keyed on the PACKAGE, so `--vitest-config`
  // can name any of these three and each gets the same repo-root `root`.
  // Discovery is compared too: it survives the move today because Vitest globs
  // `include`/`exclude` from `dir`, and this is what would catch a future
  // `root`/`include` change quietly taking that back.
  it.each(TIER_CONFIG_FILES)(
    "resolves %s identically from the repo root, so `pnpm mutation` sees the same suite",
    async (configFileName) => {
      const [fromApp, fromRepoRoot] = await Promise.all([
        resolveTier(configFileName),
        resolveTier(configFileName, REPO_ROOT),
      ]);

      expect(fromRepoRoot.setupFiles.length).toBeGreaterThan(0);
      for (const setupFile of fromRepoRoot.setupFiles) {
        expect(existsSync(setupFile)).toBe(true);
      }
      // Existence alone is not identity: a `<repo>/__tests__/setup.ts` that
      // ever appears would satisfy the loop above while the run silently loaded
      // the wrong module. This is what pins it to the app's own file.
      expect(fromRepoRoot.setupFiles).toEqual(fromApp.setupFiles);
      expect(fromRepoRoot.files).toEqual(fromApp.files);
      expect(fromRepoRoot.files.length).toBeGreaterThan(0);
    },
    RESOLVE_TIMEOUT_MS
  );
});
