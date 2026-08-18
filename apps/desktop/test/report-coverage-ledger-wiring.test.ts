import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PARTITION_RULES,
  stableContentHash,
} from "../scripts/report-coverage-lib.mjs";
import { TOOLING_REACH_LEDGER } from "../scripts/tooling-reach-ledger.mjs";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const REPORTER = path.join(desktopDir, "scripts", "report-coverage.mjs");

// A ledgered script that really exists, so the fixture universe can contain it
// and the run must classify it as a legitimate declared exclusion.
const LEDGERED_FIXTURE = TOOLING_REACH_LEDGER[0];
const SCRIPTS_PREFIX_PATTERN = /^scripts\//;
const FORGOTTEN_SCRIPT_PATTERN = /scripts\/forgotten\.mjs/;
const REACH_DIAGNOSTIC_PATTERN = /\[tooling-reach\]/;
const UNKNOWN_ARGUMENT_PATTERN = /unknown argument/;
const EXPECTS_A_PATH_PATTERN = /expects a path/;
const MISSING_LANE_PATTERN = /missing (node|renderer) lane map/;
const UNREADABLE_BASE_PATTERN = /compare skipped: base report .* is unreadable/;
const COMPARE_VERDICT_PATTERN = /\[report-coverage\] compare:/;
const COMPARISON_REFUSED_PATTERN = /comparison refused:.*incomplete/;
const UNREADABLE_SOURCE_PATTERN =
  /unreadable source file .* fingerprint is withheld/;

// Test-tree members whose ONLY route into the test universe is the directory
// rule: neither name contains a `.test.` segment. One per directory shape the
// rule covers — the node lane's own `test/` root, and a `__tests__/` folder
// co-located under production source.
const DIRECTORY_RULE_TEST_FILES = [
  "test/gateway-test-doubles.ts",
  "src/server/__tests__/doubles.ts",
];

// The two files that decide WHICH node-lane tests run: `nodeLaneInclude()`
// derives the config's `include` from the census, whose `EXCLUDED_TEST_FILES`
// drops files outright. Neither tree fingerprint can see them.
const NODE_LANE_SELECTION_FILES = [
  "vitest.node.config.ts",
  "scripts/node-test-census.mjs",
];

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iss5303-reporter-"));
  tempRoots.push(root);
  return root;
}

/**
 * A minimal but REAL istanbul record: one `if` with two branch locations, the
 * first taken and the second not. The reporter merges full istanbul maps, so a
 * summary-shaped stub would be rejected rather than measured.
 */
function istanbulRecord(absolutePath: string) {
  return {
    path: absolutePath,
    statementMap: { "0": loc() },
    fnMap: {},
    branchMap: { "0": { type: "if", loc: loc(), locations: [loc(), loc()] } },
    s: { "0": 1 },
    f: {},
    b: { "0": [1, 0] },
  };
}

function loc() {
  return { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
}

type Fixture = {
  sourceRoot: string;
  outDir: string;
  nodeMapPath: string;
  rendererMapPath: string;
};

/**
 * Build a fixture tree whose tooling partition contains `scriptNames` PLUS
 * every path the real ledger declares, with `executedNames` present in the node
 * lane map.
 *
 * Materializing the real ledger paths is what makes "reconciled" meaningful
 * here: the reporter reconciles against the SHIPPED ledger, so a fixture that
 * omitted those files would (correctly) report all seven as stale and no fixture
 * could ever reach a clean state.
 */
function buildFixture(scriptNames: string[], executedNames: string[]): Fixture {
  const root = makeTempRoot();
  const sourceRoot = path.join(root, "tree");
  const scriptsDir = path.join(sourceRoot, "scripts");
  mkdirSync(scriptsDir, { recursive: true });

  const ledgerNames = TOOLING_REACH_LEDGER.map((item) =>
    item.path.replace(SCRIPTS_PREFIX_PATTERN, "")
  );
  for (const name of [...ledgerNames, ...scriptNames]) {
    mkdirSync(path.dirname(path.join(scriptsDir, name)), { recursive: true });
    writeFileSync(path.join(scriptsDir, name), "export const x = 1;\n", "utf8");
  }

  const nodeMap: Record<string, unknown> = {};
  for (const name of executedNames) {
    const absolutePath = path.join(scriptsDir, name);
    nodeMap[absolutePath] = istanbulRecord(absolutePath);
  }

  const nodeMapPath = path.join(root, "node-coverage.json");
  const rendererMapPath = path.join(root, "renderer-coverage.json");
  const outDir = path.join(root, "merged");
  writeFileSync(nodeMapPath, JSON.stringify(nodeMap), "utf8");
  writeFileSync(rendererMapPath, JSON.stringify({}), "utf8");

  return { sourceRoot, outDir, nodeMapPath, rendererMapPath };
}

// An explicit deadline, not the runner default: this suite gates the required
// `desktop` check, which has no retry, and a child that hangs must fail as a
// hang rather than as an opaque suite timeout.
const REPORTER_TIMEOUT_MS = 60_000;

function runReporterArgs(args: string[]) {
  const result = spawnSync("node", [REPORTER, ...args], {
    encoding: "utf8",
    cwd: desktopDir,
    timeout: REPORTER_TIMEOUT_MS,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(
      `report-coverage.mjs was killed by ${result.signal} — it exceeded the ${REPORTER_TIMEOUT_MS}ms deadline`
    );
  }
  return result;
}

function runReporter(fixture: Fixture) {
  const result = runReporterArgs([
    "--node-map",
    fixture.nodeMapPath,
    "--renderer-map",
    fixture.rendererMapPath,
    "--out-dir",
    fixture.outDir,
    "--source-root",
    fixture.sourceRoot,
  ]);
  const summary = JSON.parse(
    readFileSync(path.join(fixture.outDir, "coverage-summary.json"), "utf8")
  );
  return { result, summary };
}

// These drive the REAL entrypoint. Synthetic unit tests over diffToolingReach
// cannot see a missing call site, swapped source/executed arguments, or a
// failure to serialize — deleting the wiring in report-coverage.mjs would leave
// those green. This is the test that goes red instead.
describe("ISS-5303: report-coverage.mjs actually consults the reach ledger", () => {
  test("an undeclared unreached script lands in toolingReachGap and is printed", () => {
    const fixture = buildFixture(
      ["covered.mjs", "forgotten.mjs"],
      ["covered.mjs"]
    );

    const { result, summary } = runReporter(fixture);

    assert.deepEqual(summary.toolingReachGap.unledgeredUnreached, [
      "scripts/forgotten.mjs",
    ]);
    assert.equal(summary.toolingReachGap.reconciled, false);
    assert.match(result.stderr, FORGOTTEN_SCRIPT_PATTERN);
    assert.match(result.stderr, REACH_DIAGNOSTIC_PATTERN);
  });

  test("a declared exclusion is folded into validityLedger with its real reason", () => {
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    const { summary } = runReporter(fixture);

    const emitted = summary.validityLedger.find(
      (item: { id: string }) =>
        item.id === `tooling-unreached:${LEDGERED_FIXTURE.path}`
    );
    assert.ok(
      emitted,
      "the ledgered exclusion must appear in the emitted validity ledger"
    );
    assert.equal(emitted.reason, LEDGERED_FIXTURE.reason);
  });

  test("the four structural validity entries survive alongside the reach entries", () => {
    // The reach entries are APPENDED to STATIC_VALIDITY_LEDGER. Clobbering the
    // structural disclosures would make the report claim less than it used to.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    const { summary } = runReporter(fixture);

    for (const id of [
      "prisma-baseline-lane-excluded",
      "node-lane-executed-files-only",
      "renderer-lane-all-files",
      "lane-ownership-disjoint",
    ]) {
      assert.ok(
        summary.validityLedger.some((item: { id: string }) => item.id === id),
        `structural validity entry ${id} was dropped`
      );
    }
  });

  test("a fully reached tooling partition reports reconciled with no diagnostic", () => {
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    const { result, summary } = runReporter(fixture);

    assert.equal(summary.toolingReachGap.reconciled, true);
    assert.deepEqual(summary.toolingReachGap.unledgeredUnreached, []);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stderr, REACH_DIAGNOSTIC_PATTERN);
  });

  test("counts describe the tooling partition, not the whole map", () => {
    const fixture = buildFixture(
      ["covered.mjs", "forgotten.mjs"],
      ["covered.mjs"]
    );

    const { summary } = runReporter(fixture);

    // Two fixture scripts plus every real ledgered path the fixture
    // materializes; only `covered.mjs` is in the lane map.
    assert.equal(
      summary.toolingReachGap.counts.sourceFiles,
      2 + TOOLING_REACH_LEDGER.length
    );
    assert.equal(summary.toolingReachGap.counts.executedFiles, 1);
    assert.equal(
      summary.toolingReachGap.counts.unreached,
      1 + TOOLING_REACH_LEDGER.length
    );
  });

  test("the override writes nowhere near the live coverage tree", () => {
    // The whole reason --out-dir exists: without it this test would clobber
    // apps/desktop/coverage/merged/ mid-run and race the parallel node lane.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    runReporter(fixture);

    assert.ok(
      fixture.outDir.startsWith(tmpdir()),
      "the fixture must write inside the OS temp dir"
    );
  });

  test("an unknown argument is still rejected", () => {
    // The new flags are additive; the reporter must not have become permissive.
    const result = runReporterArgs(["--not-a-flag"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, UNKNOWN_ARGUMENT_PATTERN);
  });

  test("a path flag with no value is rejected rather than silently ignored", () => {
    const result = runReporterArgs(["--out-dir"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, EXPECTS_A_PATH_PATTERN);
  });

  test("a path flag does not swallow the following flag as its value", () => {
    // `--out-dir --compare` must not set outDir to the literal string
    // "--compare" and leave compare unset: the run would write its report into
    // a directory named after a flag AND silently skip the comparison, so a CI
    // step that looked like it diffed against main would have done neither.
    const result = runReporterArgs(["--out-dir", "--compare"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, EXPECTS_A_PATH_PATTERN);
  });

  test("absent lane maps are a lane failure, exit 1", () => {
    // The half-measured case. coverage-main.yml publishes this run's output as
    // the coverage-base every PR diffs against, so a run that measured nothing
    // must not exit 0 and be mistaken for a clean baseline.
    const root = makeTempRoot();
    const outDir = path.join(root, "merged");
    const result = runReporterArgs([
      "--node-map",
      path.join(root, "absent-node.json"),
      "--renderer-map",
      path.join(root, "absent-renderer.json"),
      "--out-dir",
      outDir,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, MISSING_LANE_PATTERN);
    assert.equal(
      existsSync(path.join(outDir, "coverage-summary.json")),
      false,
      "no lane maps must not be serialized as a zero-valued measurement"
    );
  });

  test("absent lane maps refuse comparison instead of reporting a 0% regression", () => {
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    const { result: baseResult } = runReporter(fixture);
    assert.equal(baseResult.status, 0);
    const root = makeTempRoot();

    const result = runReporterArgs([
      "--node-map",
      path.join(root, "absent-node.json"),
      "--renderer-map",
      path.join(root, "absent-renderer.json"),
      "--out-dir",
      path.join(root, "merged"),
      "--source-root",
      fixture.sourceRoot,
      "--compare",
      "--base",
      path.join(fixture.outDir, "coverage-summary.json"),
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, COMPARISON_REFUSED_PATTERN);
    assert.doesNotMatch(result.stdout, COMPARE_VERDICT_PATTERN);
  });

  test("a corrupt base artifact is a loud skip at exit 0, not a crash", () => {
    // The header promises a LOUD SKIP for a base it cannot use, and a
    // truncated artifact download is that case. Throwing would discard the
    // report itself, which is the actual product of the run.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    const basePath = path.join(path.dirname(fixture.outDir), "truncated.json");
    writeFileSync(basePath, '{"partitions": {"too', "utf8");

    const result = runReporterArgs([
      "--node-map",
      fixture.nodeMapPath,
      "--renderer-map",
      fixture.rendererMapPath,
      "--out-dir",
      fixture.outDir,
      "--source-root",
      fixture.sourceRoot,
      "--compare",
      "--base",
      basePath,
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, UNREADABLE_BASE_PATTERN);
  });

  // The provenance fields the churn allowance is gated on. Unit tests over
  // computePartitionSourceHashes/computeTestTreeHash all build their own
  // fixtures, so deleting the emit in report-coverage.mjs left every one of
  // them green while the feature silently died — the allowance would then be
  // withheld forever and the gate would quietly go back to the strict ratchet.
  // These drive the REAL entrypoint and go red instead.
  test("every partition's sourceHash reaches the emitted artifact", () => {
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    // A real production file per partition. Without them only `tooling` has
    // any source, and the other five would be asserted against the withheld
    // empty-set case rather than against a fingerprint the reporter computed.
    for (const rule of PARTITION_RULES) {
      const absolutePath = path.join(
        fixture.sourceRoot,
        rule.prefix,
        "sample.ts"
      );
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "export const sample = 1;\n", "utf8");
    }

    const { summary } = runReporter(fixture);

    for (const rule of PARTITION_RULES) {
      const emitted = summary.partitions[rule.name]?.sourceHash;
      assert.equal(
        typeof emitted,
        "string",
        `partition ${rule.name} published no sourceHash`
      );
      assert.ok(
        (emitted as string).length > 0,
        `partition ${rule.name} published an empty sourceHash`
      );
    }
  });

  test("the run publishes a testTreeHash, and withholds it with no test tree", () => {
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    // buildFixture materializes only scripts/, so the test universe is empty.
    // Fingerprinting nothing yields a constant that agrees with itself, which
    // `fingerprintsAgree` would read as PROOF the tree did not move and grant
    // the full allowance on it. Nothing to compare must publish nothing.
    assert.equal(runReporter(fixture).summary.testTreeHash, undefined);

    const testDir = path.join(fixture.sourceRoot, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      path.join(testDir, "covered.test.ts"),
      "assert.ok(true);\n",
      "utf8"
    );

    const { summary } = runReporter(fixture);

    assert.equal(typeof summary.testTreeHash, "string");
    assert.ok(summary.testTreeHash.length > 0);
  });

  test("test SELECTION config is covered by the method identity", () => {
    // Neither fingerprinted tree reaches these two files: the config sits at
    // the package root, outside `collectTree`'s src/scripts/test walk, and the
    // census lands in the `tooling` partition's sourceHash alone. So dropping
    // one flaky suite would leave `gateway`'s sourceHash AND the testTreeHash
    // byte-identical while a different set of tests produced the numbers —
    // buying that partition up to MAX_CHURN_ALLOWANCE_PCT of amnesty. The
    // proof therefore has to live here, where drift REFUSES the comparison.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);

    const { summary } = runReporter(fixture);

    assert.equal(
      summary.method.nodeLaneSelectionHash,
      stableContentHash(
        NODE_LANE_SELECTION_FILES.map((relativePath) =>
          readFileSync(path.join(desktopDir, relativePath), "utf8")
        ).join("\n")
      ),
      "the published method identity must fingerprint the node lane's test-selection config"
    );
  });

  test("a file the reporter cannot read withholds its partition's sourceHash", () => {
    // Both coverage lanes run on ubuntu runners at the identical
    // /home/runner/work/<repo>/<repo> path, so a placeholder built from an
    // ENOENT message is byte-identical across runs — a file unreadable on BOTH
    // sides would be certified "unchanged" without its bytes ever being read.
    // A broken symlink is the portable way to make the read fail.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    symlinkSync(
      path.join(fixture.sourceRoot, "scripts", "does-not-exist.mjs"),
      path.join(fixture.sourceRoot, "scripts", "broken.mjs")
    );

    const { result, summary } = runReporter(fixture);

    assert.equal(summary.partitions.tooling.sourceHash, undefined);
    assert.match(result.stderr, UNREADABLE_SOURCE_PATTERN);
  });

  test("a changed production file moves only its own partition's sourceHash", () => {
    // Proves the emitted hash is computed over the REAL tree rather than being
    // a constant that merely looks like a fingerprint.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    const first = runReporter(fixture).summary;

    writeFileSync(
      path.join(fixture.sourceRoot, "scripts", "covered.mjs"),
      "export const x = 2;\n",
      "utf8"
    );
    const second = runReporter(fixture).summary;

    assert.notEqual(
      first.partitions.tooling.sourceHash,
      second.partitions.tooling.sourceHash
    );
    assert.equal(
      first.partitions.gateway.sourceHash,
      second.partitions.gateway.sourceHash
    );
    assert.equal(first.testTreeHash, second.testTreeHash);
  });

  test("a changed TEST file moves the testTreeHash and no partition sourceHash", () => {
    // The Finding 1 contract at the wiring level: a test edit must be visible
    // to the compare step, and it is invisible to every partition sourceHash.
    const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
    const testDir = path.join(fixture.sourceRoot, "test");
    mkdirSync(testDir, { recursive: true });
    const testFile = path.join(testDir, "covered.test.ts");
    writeFileSync(testFile, "assert.equal(fn(1), 1);\n", "utf8");
    const first = runReporter(fixture).summary;

    writeFileSync(testFile, "assert.ok(true);\n", "utf8");
    const second = runReporter(fixture).summary;

    assert.notEqual(first.testTreeHash, second.testTreeHash);
    for (const rule of PARTITION_RULES) {
      assert.equal(
        first.partitions[rule.name].sourceHash,
        second.partitions[rule.name].sourceHash,
        `weakening a test must not move ${rule.name}'s production sourceHash`
      );
    }
  });

  for (const testTreeFile of DIRECTORY_RULE_TEST_FILES) {
    test(`${testTreeFile} joins the test universe by its DIRECTORY`, () => {
      // `covered.test.ts` above also matches the FILENAME rule, so it can
      // never prove the `|| TEST_DIR_PATTERN.test(relativePath)` disjunct in
      // report-coverage.mjs. These names carry no `.test.` segment, so the
      // directory rule is the ONLY thing that classifies them. Without it the
      // 250-odd non-`.test.` modules in apps/desktop/test/ (test doubles,
      // fixtures, helpers) fall to the source universe — where `partitionOf`
      // returns null for a `test/` path — and vanish from BOTH universes
      // silently, so editing a double to execute less code leaves
      // `testTreeHash` and every `sourceHash` byte-identical and a real
      // regression is absorbed as branch churn.
      const fixture = buildFixture(["covered.mjs"], ["covered.mjs"]);
      const absolutePath = path.join(fixture.sourceRoot, testTreeFile);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "export const stub = () => 1;\n", "utf8");
      const first = runReporter(fixture).summary;

      writeFileSync(absolutePath, "export const stub = () => 2;\n", "utf8");
      const second = runReporter(fixture).summary;

      assert.notEqual(
        first.testTreeHash,
        second.testTreeHash,
        `editing ${testTreeFile} must move the testTreeHash`
      );
      for (const rule of PARTITION_RULES) {
        assert.equal(
          first.partitions[rule.name].sourceHash,
          second.partitions[rule.name].sourceHash,
          `${testTreeFile} must not be measured as ${rule.name} production source`
        );
      }
    });
  }
});
