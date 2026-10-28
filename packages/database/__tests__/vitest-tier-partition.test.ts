import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

// ISS-7168, the @repo/database half. `vitest.config.integration.ts` documents
// the intent — "the unit config keeps the fast 5s default so unit hangs fail
// fast" — but the unit CONFIG carried no `exclude`; the 20 real-Postgres suites
// were held out by a `--exclude` flag on the `test:unit` script instead. CI ran
// the script, so nothing was double-collected in practice, but any bare
// `vitest run` in this package picked all 20 up at the 5s default. The
// exclusion now lives in the config, and this asserts the resulting partition
// against the real configs and Vitest's own resolver so it cannot drift back.
//
// The counterpart guard for apps/api is
// `apps/api/__tests__/vitest-tier-partition.test.ts`; the two are separate
// because each resolves its own package's configs in its own package root.

const TEST_FILE_PATTERN = /\.test\.tsx?$/;
const IGNORED_DIRECTORY_PATTERN = /^(?:node_modules|dist|generated|\.turbo)$/;

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const RESOLVE_TIMEOUT_MS = 60_000;
// Vitest's own per-test default. The integration tier exists precisely because
// a real-Postgres suite cannot finish inside it under CI contention.
const VITEST_DEFAULT_TIMEOUT_MS = 5000;

type ResolvedTier = {
  files: string[];
  testTimeout: number | undefined;
  hookTimeout: number | undefined;
};

async function resolveTier(configFileName: string): Promise<ResolvedTier> {
  const vitest = await createVitest("test", {
    watch: false,
    run: true,
    root: PACKAGE_ROOT,
    config: path.join(PACKAGE_ROOT, configFileName),
  });
  try {
    const specifications = await vitest.globTestSpecifications();
    const unique = new Set(
      specifications.map((specification) =>
        path.relative(PACKAGE_ROOT, specification.moduleId)
      )
    );
    return {
      files: [...unique].sort(),
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
      found.push(path.relative(PACKAGE_ROOT, absolute));
    }
  }
  return found;
}

describe("@repo/database Vitest tier partition (ISS-7168)", () => {
  it(
    "keeps the real-Postgres suites in the integration tier only, and drops nothing",
    async () => {
      const [unit, integrationTier, onDisk] = await Promise.all([
        collectedFiles("vitest.config.ts"),
        resolveTier("vitest.config.integration.ts"),
        testFilesOnDisk(PACKAGE_ROOT),
      ]);
      const integration = integrationTier.files;

      expect(integration.length).toBeGreaterThan(0);

      // Membership is only half of it — the other half is the budget these
      // suites need. Deleting `testTimeout` from the integration config would
      // otherwise leave every assertion below green.
      expect(integrationTier.testTimeout).toBeGreaterThan(
        VITEST_DEFAULT_TIMEOUT_MS
      );
      expect(integrationTier.hookTimeout).toBeGreaterThan(
        VITEST_DEFAULT_TIMEOUT_MS
      );

      // No suite runs twice under two different timeouts. Deleting the unit
      // config's `exclude` puts all 20 integration suites back into the unit
      // tier at the 5s default; this is the assertion that catches it.
      const integrationSet = new Set(integration);
      expect(unit.filter((file) => integrationSet.has(file))).toEqual([]);

      // And nothing falls through the gap between the two globs — a dropped
      // file is invisible in a green run, so it gets its own assertion.
      const collected = new Set([...unit, ...integration]);
      const orphans = onDisk.filter((file) => !collected.has(file)).sort();
      expect(orphans).toEqual([]);
    },
    RESOLVE_TIMEOUT_MS
  );
});
