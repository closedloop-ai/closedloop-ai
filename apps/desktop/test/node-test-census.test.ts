/**
 * ISS-4933 — the census that decides which runner each desktop test file goes to.
 *
 * The failure this guards is the same shape as the shard partition's, and just
 * as silent: a file that neither lane claims does not go red, it simply stops
 * running while both lanes report success. So the assertions are the partition
 * PROPERTY over the real directory (union == every collectable file, disjoint),
 * plus the classification rules driven on synthetic sources.
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  censusTestFiles,
  EXCLUDED_TEST_FILES,
  GLOB_METACHARACTERS,
  importsVitest,
  installsLoaderHook,
  isVitestEligible,
  VITEST_INCOMPATIBLE_FILES,
  vitestReachingHelperSpecifiers,
} from "../scripts/node-test-census.mjs";
import {
  parseShardSpec,
  selectShard,
} from "../scripts/run-node-tests-shard.mjs";
import { createTempDirManager } from "./helpers/temp-dir.js";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const SHARD_COUNTS = [1, 2, 3, 4, 8] as const;

/** ISS-6258 ratchet: lowered whenever a file leaves the legacy lane, never raised. */
const LEGACY_LANE_FILE_COUNT = 2;

function collectableTestFiles(): string[] {
  return readdirSync(join(desktopDir, "test"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !EXCLUDED_TEST_FILES.has(entry.name)
    )
    .map((entry) => `test/${entry.name}`)
    .sort();
}

describe("censusTestFiles", () => {
  it("excludes exactly the files another script is known to run", () => {
    // The partition assertion below subtracts EXCLUDED_TEST_FILES from BOTH
    // sides, so growing that set would drop a file from every lane AND from the
    // expectation — a file run by nobody, on a required check, with the test
    // whose whole job is to catch that still green. Pinning the literal makes
    // adding one a deliberate edit here, where the reviewer is forced to say
    // which script picks it up instead.
    assert.deepEqual(
      [...EXCLUDED_TEST_FILES].sort(),
      ["no-token-surface-dist.test.ts"],
      "a newly excluded file must name the script that runs it — `test:dist-token-surface` runs `no-token-surface-dist.test.ts`"
    );
  });

  it("has no test filename Vitest's include would read as a pattern", () => {
    // `include` is glob-matched, not opened. `foo[1].test.ts` matches nothing
    // and is dropped in silence, where the legacy lane's literal argv would
    // make `tsx --test` error. Renaming the file is the fix; an escaping layer
    // for a case this tree does not have is not.
    for (const file of collectableTestFiles()) {
      assert.ok(
        !GLOB_METACHARACTERS.test(file),
        `\`${file}\` contains a glob metacharacter, so Vitest's \`include\` would silently not match it and the file would stop running while every lane reported success. Rename it.`
      );
    }
  });

  it("assigns every collectable test file to exactly one lane", () => {
    const { vitest, nodeTest } = censusTestFiles();
    const assigned = [...vitest, ...nodeTest].sort();

    assert.equal(
      new Set(assigned).size,
      assigned.length,
      "a file claimed by both lanes would run twice and report its history twice"
    );
    assert.deepEqual(
      assigned,
      collectableTestFiles(),
      "a file claimed by NEITHER lane never runs, and both lanes still go green"
    );
  });

  it("still has files on the legacy lane, so its exemptions are not yet stale", () => {
    // This used to be one half of a contract whose other half lived in a
    // DIFFERENT required check: scripts/lint/node-test-lane-coverage.test.ts kept
    // five EXEMPT_JOBS entries alive on the strength of this lane existing. That
    // suite, and the EXEMPT_JOBS register with it, were deleted by ISS-10525, so
    // this assertion is now the only thing that makes a dead legacy lane loud.
    const { nodeTest, vitest } = censusTestFiles();
    assert.ok(vitest.length > 0, "the Vitest lane must own files");
    assert.ok(
      nodeTest.length > 0,
      "the legacy node:test lane selects nothing — delete the second spawn in run-node-tests.mjs rather than leaving a dead spawn behind (the EXEMPT_JOBS register that used to pair with it went with scripts/lint/node-test-lane-coverage.test.ts in ISS-10525)"
    );
  });

  it("holds the legacy lane at its committed size, which only ever goes down", () => {
    // ISS-6258. Nothing else notices growth: a new file on node:test's `mock`
    // is routed to the legacy lane and both lanes stay green.
    const { nodeTest } = censusTestFiles();
    assert.ok(
      nodeTest.length <= LEGACY_LANE_FILE_COUNT,
      `the legacy node:test lane grew to ${nodeTest.length} files (ratchet: ${LEGACY_LANE_FILE_COUNT}). Write the new suite against vitest (vi, test/support/node-test-fake-timers.ts) instead of node:test; do not raise the ratchet. Legacy lane: ${nodeTest.join(", ")}`
    );
    assert.equal(
      nodeTest.length,
      LEGACY_LANE_FILE_COUNT,
      `the legacy node:test lane shrank to ${nodeTest.length} files — lower LEGACY_LANE_FILE_COUNT to ${nodeTest.length} in this change so the room cannot be refilled`
    );
    // A count survives a swap: unpin one file and add a `mock` file in the
    // same change and both asserts above still pass.
    const pinned = new Set(
      [...VITEST_INCOMPATIBLE_FILES.keys()].map((name) => `test/${name}`)
    );
    assert.deepEqual(
      nodeTest.filter((file) => !pinned.has(file)),
      [],
      "only VITEST_INCOMPATIBLE_FILES entries may run on the legacy node:test lane; write the listed suite against vi / test/support/node-test-fake-timers.ts instead"
    );
  });

  it("routes no file that imports vitest to the legacy lane", () => {
    // ISS-4934 hit this for real. A file can be converted to `vi` and STILL be
    // held on the legacy lane by a rule that has nothing to do with node:test's
    // API — `db-host-unexpected-exit-telemetry.test.ts` imports the loader-hook
    // electron helper, so the conversion moved its API without moving its lane,
    // and `tsx --test` then ran a file whose first `vi.useFakeTimers()` throws
    // "Vitest failed to access its internal state".
    //
    // The two ways to reach that state are converting a file the census cannot
    // take, and adding a disqualifier to a file that is already converted; this
    // catches both, and it catches them in this fast suite rather than several
    // minutes into the full runner.
    // Includes the TRANSITIVE path, which is the one every converted suite
    // actually uses: they import ./support/node-test-fake-timers.js, not vitest.
    const viaHelper = vitestReachingHelperSpecifiers();
    assert.ok(
      viaHelper.has("./support/node-test-fake-timers.js"),
      "the timer helper must be recognised as vitest-reaching, or the transitive half of this guard checks nothing"
    );
    const { nodeTest } = censusTestFiles();
    for (const file of nodeTest) {
      const source = readFileSync(join(desktopDir, file), "utf8");
      assert.ok(
        !importsVitest(source, file, viaHelper),
        `\`${file}\` imports vitest but the census routes it to \`tsx --test\`, which has no Vitest runtime — every vi.* call throws "Vitest failed to access its internal state". Either revert it to node:test's API, or remove whatever disqualifier keeps it off the Vitest lane (run the census to see which rule fired).`
      );
    }
  });

  for (const total of SHARD_COUNTS) {
    it(`shards both lanes across ${total} shard(s) with nothing lost or duplicated`, () => {
      const census = censusTestFiles();
      for (const [lane, files] of Object.entries(census)) {
        const seen: string[] = [];
        for (let index = 1; index <= total; index++) {
          seen.push(...selectShard(files, parseShardSpec(`${index}/${total}`)));
        }
        assert.equal(
          new Set(seen).size,
          seen.length,
          `${lane} shards of ${total} overlap`
        );
        assert.deepEqual(
          [...seen].sort(),
          [...files].sort(),
          `${lane} shards of ${total} drop ${files.length - new Set(seen).size} file(s)`
        );
      }
    });
  }
});

describe("isVitestEligible", () => {
  it("takes a file that imports vitest and never node:test", () => {
    assert.equal(
      isVitestEligible(
        'import { expect, test } from "vitest";\ntest("x", () => { expect(1).toBe(1); });',
        "sample.test.ts"
      ),
      true
    );
  });

  it("leaves every spelling of a node:test import on the legacy lane", () => {
    // ISS-11262 retired the alias shim, so the Vitest lane resolves `node:test`
    // to the real module: its `test` would register with a runner Vitest never
    // starts, and the file would go green by running nothing.
    for (const source of [
      'import { test } from "node:test";\ntest("x", () => {});',
      'import test from "node:test";\ntest("x", () => {});',
      'import * as nodeTest from "node:test";',
      'import {\n  describe,\n  it,\n} from "node:test";',
    ]) {
      assert.equal(
        isVitestEligible(source, "sample.test.ts"),
        false,
        `must not reach the Vitest lane: ${source}`
      );
    }
  });
});

describe("installsLoaderHook", () => {
  it("catches both spellings of a Node ESM loader hook", () => {
    assert.equal(
      installsLoaderHook(
        'import { registerHooks } from "node:module";',
        "helper.ts"
      ),
      true
    );
    assert.equal(
      installsLoaderHook('import { register } from "node:module";', "h.ts"),
      true
    );
  });

  it("does not fire on other node:module exports", () => {
    // `createRequire` is used by several suites and works fine under Vitest —
    // it resolves a module, it does not intercept resolution.
    assert.equal(
      installsLoaderHook(
        'import { createRequire } from "node:module";',
        "h.ts"
      ),
      false
    );
  });

  it("routes a test that imports a loader-hook helper to the legacy lane", () => {
    const specifiers = new Set(["./helpers/electron-module-mock.js"]);
    const source =
      'import { test } from "vitest";\nimport { registerElectronModuleMock } from "./helpers/electron-module-mock.js";';
    assert.equal(isVitestEligible(source, "sample.test.ts", specifiers), false);
    // Same file, no such helper in the set: eligible. Without this the case
    // above would pass even if the specifier check were dropped entirely.
    assert.equal(isVitestEligible(source, "sample.test.ts", new Set()), true);
  });
});

describe("VITEST_INCOMPATIBLE_FILES", () => {
  it("names only files that exist, each with a stated reason", () => {
    const present = new Set(
      readdirSync(join(desktopDir, "test"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    );
    for (const [name, reason] of VITEST_INCOMPATIBLE_FILES) {
      assert.ok(
        present.has(name),
        `\`${name}\` is held off the Vitest lane but no longer exists — a renamed or deleted file leaves a silent no-op here, and the next file to hit the same incompatibility gets no hint that it was ever diagnosed`
      );
      assert.ok(
        reason.length > 40,
        `\`${name}\` must say WHY tsx --test's runtime is required, not just that it is`
      );
    }
  });

  it("keeps those files on the legacy lane", () => {
    const { nodeTest } = censusTestFiles();
    for (const name of VITEST_INCOMPATIBLE_FILES.keys()) {
      assert.ok(
        nodeTest.includes(`test/${name}`),
        `\`${name}\` must be routed to the node:test lane`
      );
    }
  });
});

describe("the helper closure reaches a fixed point, not one hop", () => {
  const { makeTempDir } = createTempDirManager("census-helper-closure-");

  const VITEST_HELPER =
    'import { vi } from "vitest";\nexport const spy = vi;\n';
  const LOADER_HOOK_HELPER =
    'import { registerHooks } from "node:module";\nexport const hooks = registerHooks;\n';

  function writeHelper(dir: string, relativePath: string, source: string) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }

  it("marks a helper that reaches vitest through ANOTHER helper", () => {
    // The defect this replaced: a one-hop set knows `helper-b` and stops, so a
    // legacy-routed test importing `helper-a` passes the cross-lane guard and
    // then throws "Vitest failed to access its internal state" under
    // `tsx --test` — the exact failure the guard exists to prevent (whitlockk).
    const dir = makeTempDir();
    writeHelper(dir, "helper-b.ts", VITEST_HELPER);
    writeHelper(dir, "helper-a.ts", 'import { spy } from "./helper-b.js";\n');

    const reaching = vitestReachingHelperSpecifiers(dir);

    assert.ok(reaching.has("./helper-b.js"), "the direct importer");
    assert.ok(
      reaching.has("./helper-a.js"),
      "a helper reaching vitest through another helper is still vitest-reaching"
    );
  });

  it("resolves a helper import against the importing helper's own directory", () => {
    // `golden/golden-layer3.ts` writes `./golden-corpus.js` and
    // `../agent-db-test-utils.js` for files this set keys as
    // `./golden/golden-corpus.js` and `./agent-db-test-utils.js`. Concatenating
    // the walker's prefix instead of resolving would match neither, which is a
    // closure that reports one hop while looking transitive.
    const dir = makeTempDir();
    writeHelper(dir, "helper-b.ts", VITEST_HELPER);
    writeHelper(
      dir,
      "support/helper-c.ts",
      'import { spy } from "../helper-b.js";\n'
    );
    writeHelper(
      dir,
      "support/helper-d.ts",
      'import "./helper-c.js";\nexport const d = 1;\n'
    );

    const reaching = vitestReachingHelperSpecifiers(dir);

    assert.ok(reaching.has("./support/helper-c.js"), "parent-relative import");
    assert.ok(reaching.has("./support/helper-d.js"), "sibling import, 3 hops");
  });

  it("terminates on a cycle between two helpers", () => {
    const dir = makeTempDir();
    writeHelper(dir, "helper-b.ts", VITEST_HELPER);
    writeHelper(
      dir,
      "helper-x.ts",
      'import "./helper-y.js";\nimport { spy } from "./helper-b.js";\n'
    );
    writeHelper(dir, "helper-y.ts", 'import "./helper-x.js";\n');

    const reaching = vitestReachingHelperSpecifiers(dir);

    assert.ok(reaching.has("./helper-x.js"));
    assert.ok(reaching.has("./helper-y.js"), "reaches vitest through x");
  });

  it("catches the two-hop test file the guard is actually written for", () => {
    // End of the chain: the guard in `censusTestFiles` above calls
    // `importsVitest(source, file, viaHelper)` with this set, so a set that
    // stopped at one hop would report this file clean.
    const dir = makeTempDir();
    writeHelper(dir, "helper-b.ts", VITEST_HELPER);
    writeHelper(dir, "helper-a.ts", 'import { spy } from "./helper-b.js";\n');
    const testSource = 'import "./helper-a.js";\n';

    assert.equal(
      importsVitest(
        testSource,
        "two-hop.test.ts",
        vitestReachingHelperSpecifiers(dir)
      ),
      true
    );
  });

  it("routes a test whose helper chain reaches a disqualifier to the legacy lane", () => {
    // The same closure, mirrored: a loader hook two helpers away disqualifies
    // its importer just as surely as one imported directly. One hop sends this
    // file to Vitest, where the hook is registered and never consulted.
    const dir = makeTempDir();
    writeHelper(dir, "support/hooks.ts", LOADER_HOOK_HELPER);
    writeHelper(dir, "helper-a.ts", 'import "./support/hooks.js";\n');
    writeHelper(
      dir,
      "two-hop.test.ts",
      'import { test } from "vitest";\nimport "./helper-a.js";\ntest("x", () => {});\n'
    );

    const census = censusTestFiles(dir);

    assert.deepEqual(census.nodeTest, ["test/two-hop.test.ts"]);
    assert.deepEqual(census.vitest, []);
  });
});
