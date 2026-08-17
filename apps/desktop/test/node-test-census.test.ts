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
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  censusTestFiles,
  EXCLUDED_TEST_FILES,
  GLOB_METACHARACTERS,
  importsVitest,
  installsLoaderHook,
  isVitestEligible,
  SHIMMED_NODE_TEST_SPECIFIERS,
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
  it("excludes exactly the one file another script is known to run", () => {
    // The partition assertion below subtracts EXCLUDED_TEST_FILES from BOTH
    // sides, so growing that set would drop a file from every lane AND from the
    // expectation — a file run by nobody, on a required check, with the test
    // whose whole job is to catch that still green. Pinning the literal makes
    // adding one a deliberate edit here, where the reviewer is forced to say
    // which script picks it up instead.
    assert.deepEqual(
      [...EXCLUDED_TEST_FILES].sort(),
      ["prisma-baseline-equivalence.test.ts"],
      "a newly excluded file must name the script that runs it — `test:prisma-baseline` runs this one"
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
    // This is one half of a contract whose other half lives in a DIFFERENT
    // required check: scripts/lint/node-test-lane-coverage.test.ts keeps five
    // EXEMPT_JOBS entries alive on the strength of this lane existing, and its
    // own discovery is a text scan for `"--test"` in run-node-tests.mjs — which
    // would keep finding the string even after the lane stopped selecting any
    // file. This assertion is what makes that state loud instead.
    const { nodeTest, vitest } = censusTestFiles();
    assert.ok(vitest.length > 0, "the Vitest lane must own files");
    assert.ok(
      nodeTest.length > 0,
      "the legacy node:test lane selects nothing — delete the second spawn in run-node-tests.mjs and the five desktop entries in scripts/lint/node-test-lane-coverage.test.ts's EXEMPT_JOBS rather than leaving a dead spawn holding live exemptions"
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
  it("takes a file whose node:test imports are all shimmed", () => {
    assert.equal(
      isVitestEligible(
        'import { after, before, describe, test } from "node:test";\ntest("x", () => {});',
        "sample.test.ts"
      ),
      true
    );
  });

  it("takes a file that never imports node:test at all", () => {
    // The golden-* suites already import from `vitest` directly, and would
    // otherwise fall to a legacy lane that cannot run them.
    assert.equal(
      isVitestEligible(
        'import { expect, test } from "vitest";\ntest("x", () => { expect(1).toBe(1); });',
        "sample.test.ts"
      ),
      true
    );
  });

  it("leaves a `mock` importer on the legacy lane", () => {
    // No `mock.fn()` call in the fixture: that would trip the unshimmed-PROPERTY
    // rule instead, and this case would keep passing even if `mock` were added
    // to SHIMMED_NODE_TEST_SPECIFIERS. The import alone must be enough.
    assert.equal(
      isVitestEligible(
        'import { mock, test } from "node:test";\ntest("x", () => { /* noop */ });',
        "sample.test.ts"
      ),
      false,
      "node:test's mock call records have a different shape from vi.fn()'s. ISS-4934 converted every such file in this tree; the rule stays so a NEW `mock` importer is routed rather than crashing on a shim that has no `mock` to give it"
    );
  });

  it("leaves `only`/`todo` property users on the legacy lane", () => {
    // Both mean different things on the two runners: node:test without
    // `--test-only` runs every sibling, and node:test RUNS a todo body.
    for (const property of ["only", "todo"]) {
      assert.equal(
        isVitestEligible(
          `import { test } from "node:test";\ntest.${property}("x", () => {});`,
          "sample.test.ts"
        ),
        false,
        `test.${property} must not reach the shim`
      );
    }
  });

  it("takes a default importer, and still rejects a namespace one", () => {
    // ISS-4934. node:test's default export IS `test`, and the shim exports it.
    // A default binding is no weaker a signal than a named one, because the
    // unshimmed-PROPERTY rule reads accesses off whichever local name the
    // import produced — asserted by the `test.mock` case below, which is the
    // only thing standing between this and 83 files reaching a shim that has
    // no `mock` to give them.
    assert.equal(
      isVitestEligible(
        'import test from "node:test";\ntest("x", () => {});',
        "sample.test.ts"
      ),
      true
    );
    assert.equal(
      isVitestEligible(
        'import test from "node:test";\ntest("x", () => { test.mock.fn(); });',
        "sample.test.ts"
      ),
      false,
      "a default importer that reaches for .mock must still go to the legacy lane"
    );
    // The two spellings a PROPERTY-ACCESS rule cannot name. Neither is in this
    // tree, but accepting `<default>` is what makes that rule load-bearing, so
    // the ways around it have to be closed in the same change.
    assert.equal(
      isVitestEligible(
        'import test from "node:test";\nconst { mock } = test;\nmock.fn();',
        "sample.test.ts"
      ),
      false,
      "destructuring `mock` off the default binding must not reach a shim that has no `mock`"
    );
    assert.equal(
      isVitestEligible(
        'import test from "node:test";\ntest["mock"].fn();',
        "sample.test.ts"
      ),
      false,
      "an element access off a node:test binding is opaque to the property rule"
    );
    // A namespace object's members ARE the module's export set, so the property
    // rule cannot distinguish `nodeTest.mock` from `nodeTest.describe`.
    assert.equal(
      isVitestEligible('import * as nodeTest from "node:test";', "s.test.ts"),
      false
    );
  });

  it("leaves a TestContext user on the legacy lane", () => {
    assert.equal(
      isVitestEligible(
        'import { test } from "node:test";\ntest("x", async (t) => { t.after(() => {}); });',
        "sample.test.ts"
      ),
      false,
      "Vitest's test context does not implement t.after/t.diagnostic/t.mock"
    );
  });

  it("leaves a file reaching for an unshimmed property on the legacy lane", () => {
    assert.equal(
      isVitestEligible(
        'import { test } from "node:test";\ntest.somethingNew("x", () => {});',
        "sample.test.ts"
      ),
      false
    );
    // `test.after` IS shimmed, and 13 files in this tree use it.
    assert.equal(
      isVitestEligible(
        'import { test } from "node:test";\ntest.after(() => {});',
        "sample.test.ts"
      ),
      true
    );
  });

  it("survives a multi-line import, which a text scan would misread", () => {
    assert.equal(
      isVitestEligible(
        'import {\n  mock,\n  test,\n} from "node:test";',
        "sample.test.ts"
      ),
      false
    );
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
      'import { test } from "node:test";\nimport { registerElectronModuleMock } from "./helpers/electron-module-mock.js";';
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

describe("the census and the shim cannot drift apart", () => {
  it("shims exactly the specifiers the census promises are shimmed", async () => {
    // Loaded dynamically because a namespace import is banned repo-wide, and
    // what is under test here is the module's EXPORT SET, not any one export.
    const shim = await import("./support/node-test-vitest-shim.js");
    const exported = new Set(
      Object.keys(shim).filter((name) => name !== "default")
    );
    assert.deepEqual(
      [...exported].sort(),
      [...SHIMMED_NODE_TEST_SPECIFIERS].sort(),
      "a specifier the census calls shimmed but the shim does not export is an import-time crash on a required gate; one the shim exports but the census omits sends working files to the legacy lane forever"
    );
  });

  it("exports the default 83 files now depend on", () => {
    // DEFAULT_IMPORT_SPECIFIER is deliberately not a member of
    // SHIMMED_NODE_TEST_SPECIFIERS (that set is the shim's NAMED exports), and
    // the drift assertion above filters `default` out — so between them, nothing
    // covered the one export the census's ISS-4934 rule actually rests on.
    // Deleting `export default test` would leave every test here green while 83
    // real suites failed at import with "does not provide an export named
    // 'default'".
    assert.equal(
      isVitestEligible(
        'import test from "node:test";\ntest("x", () => {});',
        "sample.test.ts"
      ),
      true,
      "the census routes default importers to the Vitest lane, so the shim must have a default to route them to"
    );
  });

  it("hands the default importer the same registrar as the named one", async () => {
    const shim = await import("./support/node-test-vitest-shim.js");
    assert.equal(
      shim.default,
      shim.test,
      "node:test's default export IS `test`; a default that differs would give the 83 default-importing suites a different registrar from the rest of the tree"
    );
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
    // `tsx --test` — the exact failure the guard exists to prevent (wongk).
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
      'import { test } from "node:test";\nimport "./helper-a.js";\ntest("x", () => {});\n'
    );

    const census = censusTestFiles(dir);

    assert.deepEqual(census.nodeTest, ["test/two-hop.test.ts"]);
    assert.deepEqual(census.vitest, []);
  });
});
