#!/usr/bin/env node
// Desktop dual-lane coverage report (ISS-4594). Merges the c8 node-lane map and
// the @vitest/coverage-v8 renderer-lane map into per-partition branch coverage
// and writes coverage/merged/. A run with neither raw map writes no merged
// measurement: zero lanes is absence, not a 0% result to compare or publish.
//
//   --compare --base <path>  verdict vs a PREVIOUS measurement of main —
//     the coverage-summary.json a prior coverage-main.yml run uploaded and the
//     current one downloaded. Exit 0 ok, 2 drop, 3 method discontinuity
//     (comparison refused, not guessed).
//
// Nothing is committed to git: there is no baseline file to go stale, to
// conflict between concurrent PRs, or to need hand-regeneration. A missing or
// unreadable --base is a LOUD SKIP at exit 0, not a failure — that is the
// steady state before main has ever published a report, and a branch is never
// blamed for the absence of something it does not control.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CompareOutcome, compareToBase } from "./report-coverage-compare.mjs";
import {
  computePartitionSourceHashes,
  computePartitionStats,
  computeTestTreeHash,
  mergeLaneMaps,
  PARTITION_RULES,
  partitionOf,
  partitionRulesHash,
  renderMarkdown,
  STATIC_VALIDITY_LEDGER,
  stableContentHash,
  TEST_FILE_PATTERN,
} from "./report-coverage-lib.mjs";
import {
  diffToolingReach,
  formatToolingReachGap,
  TOOLING_PARTITION,
  TOOLING_REACH_LEDGER,
} from "./tooling-reach-ledger.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const TEST_DIR_PATTERN = /(^|\/)(__tests__|test|test-e2e|e2e)(\/|$)/;
const SOURCE_EXTENSION_PATTERN = /\.(tsx|mts|cts|ts|mjs|cjs)$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The RESOLVED provider version, not the manifest range: a lockfile bump
// inside ^x.y.z changes the instrumenter without changing the range, and the
// method identity exists precisely to catch that. Falls back to the declared
// spec (marked as such) if the package.json subpath is unresolvable.
function resolvedPackageVersion(specifier, declaredSpec) {
  const requireFromHere = createRequire(import.meta.url);
  try {
    return readJson(requireFromHere.resolve(`${specifier}/package.json`))
      .version;
  } catch {
    return `spec:${declaredSpec}`;
  }
}

function loadLaneMap(path, lane) {
  if (!existsSync(path)) {
    console.error(
      `[report-coverage] missing ${lane} lane map at ${relative(desktopDir, path)} — treating lane as not measured`
    );
    return null;
  }
  // A truncated or partially-written lane map is the same situation as a
  // missing one — the lane did not produce a usable measurement — and it must
  // degrade to "not measured" rather than aborting the whole report. Throwing
  // here would lose the OTHER lane's numbers too.
  try {
    return readJson(path);
  } catch (error) {
    console.error(
      `[report-coverage] unreadable ${lane} lane map at ${relative(desktopDir, path)} (${error instanceof Error ? error.message : String(error)}) — treating lane as not measured`
    );
    return null;
  }
}

function canonicalPath(rawPath) {
  const relativePath = relative(sourceRoot, rawPath);
  if (relativePath.startsWith("..")) {
    return null;
  }
  if (
    TEST_FILE_PATTERN.test(relativePath) ||
    TEST_DIR_PATTERN.test(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

// Walks a tree once and splits it into the two universes the report needs: the
// PRODUCTION files a partition's percentage is computed over, and the TEST files
// whose execution produces those numbers. Both are fingerprinted, because the
// churn allowance has to prove neither tree moved (see `compareToBase`).
//
// A file is a test if its own name says so or if any ancestor directory does,
// which is the same rule `canonicalPath` uses to keep tests out of the measured
// universe — so `source` here stays exactly the set it collected before.
function collectTree(rootRelativeDir, source, tests) {
  const absoluteDir = join(sourceRoot, rootRelativeDir);
  if (!existsSync(absoluteDir)) {
    return;
  }
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = `${rootRelativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectTree(relativePath, source, tests);
      continue;
    }
    if (!SOURCE_EXTENSION_PATTERN.test(entry.name)) {
      continue;
    }
    const isTest =
      TEST_FILE_PATTERN.test(entry.name) || TEST_DIR_PATTERN.test(relativePath);
    if (isTest) {
      tests.push(relativePath);
      continue;
    }
    source.push(relativePath);
  }
}

// Everything that changes what the numbers MEAN: resolved provider versions,
// node major, partition rules, the exact c8 invocation (include globs live in
// the script string), the renderer coverage config (include/exclude/timeout
// live in the file), and — the other lane's equivalent — everything that
// decides WHICH node-lane tests run. Any drift here must surface as a
// comparison refusal, never as a silently incomparable percentage.
function buildMethodIdentity() {
  const packageJson = readJson(join(desktopDir, "package.json"));
  return {
    c8: resolvedPackageVersion("c8", packageJson.devDependencies.c8),
    coverageV8: resolvedPackageVersion(
      "@vitest/coverage-v8",
      packageJson.devDependencies["@vitest/coverage-v8"]
    ),
    nodeMajor: Number(process.version.slice(1).split(".")[0]),
    partitionRules: partitionRulesHash(PARTITION_RULES),
    nodeLaneScript: packageJson.scripts["test:node:coverage"],
    nodeLaneImplementationHash: stableContentHash(
      readFileSync(join(desktopDir, "scripts/run-node-tests.mjs"), "utf8")
    ),
    // Every file of the merge/compare implementation. Splitting the compare
    // step into its own module must not create a blind spot: a change to any
    // of them changes what the numbers mean and must force a refusal.
    //
    // THIS file is in the list, added when `TEST_FILE_PATTERN` here widened to
    // cover the `.test-<kind>` support suffixes. It was the blind spot the
    // comment above was written to prevent, one file short: `canonicalPath` and
    // `collectTree` live here and decide which files are measured AT ALL, so
    // editing them moves every percentage while the two hashed modules sit
    // unchanged — a measurement change presenting as a code change. Reading its
    // own bytes is not circular; the hash is over source text, not over output.
    mergeImplementationHash: stableContentHash(
      [
        readFileSync(join(desktopDir, "scripts/report-coverage.mjs"), "utf8"),
        readFileSync(
          join(desktopDir, "scripts/report-coverage-lib.mjs"),
          "utf8"
        ),
        readFileSync(
          join(desktopDir, "scripts/report-coverage-compare.mjs"),
          "utf8"
        ),
      ].join("\n")
    ),
    rendererConfigHash: stableContentHash(
      readFileSync(join(desktopDir, "vitest.renderer.config.ts"), "utf8")
    ),
    // Test SELECTION, which no fingerprint below can see. `testTreeHash`
    // proves the test files' BYTES did not move; it says nothing about which
    // of them the lane actually ran, and these two files decide exactly that
    // (`nodeLaneInclude()` derives `include` from `censusTestFiles()`, whose
    // `EXCLUDED_TEST_FILES` drops files outright). Neither is reachable by
    // the tree fingerprints: `collectTree` walks src/scripts/test, so the
    // config at the package root is in NO universe, and the census is in the
    // `tooling` partition's `sourceHash` alone, so excluding one flaky suite
    // would leave `gateway`'s proofs intact and buy it up to a full point of
    // churn amnesty. Dropping a suite is legitimate maintenance — but it
    // makes the two runs not like-for-like, so it must refuse, not forgive.
    nodeLaneSelectionHash: stableContentHash(
      [
        readFileSync(join(desktopDir, "vitest.node.config.ts"), "utf8"),
        readFileSync(join(desktopDir, "scripts/node-test-census.mjs"), "utf8"),
      ].join("\n")
    ),
    lanes: ["node:c8+tsx+node:test", "renderer:vitest+coverage-v8"],
  };
}

// Path overrides (ISS-5303). Without them every input and output path is
// derived from import.meta.url, so a test could only drive this script against
// the LIVE coverage/ tree — reading a node lane map c8 has not written yet and
// clobbering the real merged report mid-run, racing the parallel test files
// run-node-tests.mjs spawns. These make the reporter drivable against fixture
// maps in a temp directory.
//
// They are purely additive: run-coverage-lanes.mjs forwards only whatever the
// caller passed (`...process.argv.slice(2)`, in practice --compare/--base), so
// every existing invocation behaves exactly as before, and an unrecognised
// argument is still rejected. A Map (not an object literal) keeps an untrusted
// argv token from reaching `__proto__` or `constructor`.
const PATH_OPTION_KEYS = new Map([
  ["--base", "basePath"],
  ["--node-map", "nodeMapPath"],
  ["--renderer-map", "rendererMapPath"],
  ["--out-dir", "outDir"],
  ["--source-root", "sourceRoot"],
]);

function parseArgs(argv) {
  const options = {
    compare: false,
    basePath: null,
    nodeMapPath: null,
    rendererMapPath: null,
    outDir: null,
    sourceRoot: null,
  };
  const queue = [...argv];
  while (queue.length > 0) {
    const arg = queue.shift();
    if (arg === "--compare") {
      options.compare = true;
      continue;
    }
    const key = PATH_OPTION_KEYS.get(arg);
    if (!key) {
      console.error(`[report-coverage] unknown argument: ${arg}`);
      process.exit(1);
    }
    const value = queue.shift();
    // A bare `--out-dir --compare` must not silently consume the next flag as
    // its value: that would leave --compare unset AND write the report into a
    // directory literally named "--compare", so a run that looked like it
    // compared against main would quietly have done neither.
    if (!value || value.startsWith("--")) {
      console.error(`[report-coverage] ${arg} expects a path`);
      process.exit(1);
    }
    options[key] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const sourceRoot = options.sourceRoot ?? desktopDir;
const nodeMapPath =
  options.nodeMapPath ?? join(desktopDir, "coverage/node/coverage-final.json");
const rendererMapPath =
  options.rendererMapPath ??
  join(desktopDir, "coverage/renderer/coverage-final.json");
const mergedDir = options.outDir ?? join(desktopDir, "coverage/merged");
const nodeMap = loadLaneMap(nodeMapPath, "node");
const rendererMap = loadLaneMap(rendererMapPath, "renderer");
let laneFailure = nodeMap === null || rendererMap === null;

const { files, rejections } = mergeLaneMaps({
  nodeMap,
  rendererMap,
  canonicalPath,
});
for (const rejection of rejections) {
  console.error(
    `[report-coverage] lane "${rejection.label}" rejected: ${rejection.reason} — expected FULL istanbul maps, got a summary`
  );
}
if (rejections.length > 0) {
  laneFailure = true;
}

const sourceUniverse = [];
const testUniverse = [];
// src/ and scripts/ carry both universes (production files plus their
// co-located __tests__/). test/ is the node lane's own suite root. test-e2e/
// (Playwright) and type-tests/ (type-level only) are deliberately absent: no
// instrumented lane executes them, so they cannot move a coverage number, and
// hashing them would withhold the allowance for changes that provably cannot
// affect the measurement.
collectTree("src", sourceUniverse, testUniverse);
collectTree("scripts", sourceUniverse, testUniverse);
collectTree("test", sourceUniverse, testUniverse);

const stats = computePartitionStats(files, sourceUniverse);
// Provenance the compare step needs to tell a re-enumerated branch universe
// from newly-written untested code: without it a moving denominator is
// unattributable and earns no allowance at all (see `compareToBase` cause 3).
// An unreadable source file WITHHOLDS its partition's hash entirely, which
// withholds the allowance — the safe direction. Substituting a placeholder
// string here would not be: both coverage lanes run on ubuntu runners at the
// identical /home/runner/work/<repo>/<repo> path, so the ENOENT message and
// therefore the placeholder are byte-identical across runs, and a file
// unreadable on BOTH sides would be certified "unchanged" without its bytes
// ever having been read.
function readTreeText(path) {
  try {
    return readFileSync(join(sourceRoot, path), "utf8");
  } catch (error) {
    console.error(
      `[report-coverage] unreadable source file ${path}: ${error instanceof Error ? error.message : String(error)} — its fingerprint is withheld`
    );
    return null;
  }
}
const sourceHashes = computePartitionSourceHashes(sourceUniverse, readTreeText);
for (const rule of PARTITION_RULES) {
  stats[rule.name].sourceHash = sourceHashes[rule.name];
}
// The other half of that provenance. A partition's percentage moves when its
// TESTS change just as surely as when its source does, and a per-partition
// source hash cannot see that at all — so the allowance needs this too, or a
// weakened test reads as harmless churn.
const testTreeHash = computeTestTreeHash(testUniverse, readTreeText);
const method = buildMethodIdentity();
const generatedAt = new Date().toISOString();
const validityLedger = [...STATIC_VALIDITY_LEDGER];
const noLaneMaps = nodeMap === null && rendererMap === null;

// ISS-5303 — reconcile the tooling partition's reach against its ledger. The
// node lane reports executed files only, so an unimported script contributes
// nothing and disappears from the numbers entirely. Naming every such file is
// what PRD-618 rule 4 requires; the reconciliation below is what keeps those
// declarations honest as the tree changes.
const toolingSourceFiles = sourceUniverse.filter(
  (path) => partitionOf(path) === TOOLING_PARTITION
);
const toolingExecutedFiles = [...files.keys()].filter(
  (path) => partitionOf(path) === TOOLING_PARTITION
);
const toolingReach = diffToolingReach(
  TOOLING_REACH_LEDGER,
  toolingSourceFiles,
  toolingExecutedFiles
);
for (const path of toolingReach.ledgeredUnreached) {
  const entry = TOOLING_REACH_LEDGER.find(
    (candidate) => candidate.path === path
  );
  validityLedger.push({
    id: `tooling-unreached:${path}`,
    reason: entry?.reason ?? path,
  });
}
for (const line of formatToolingReachGap(toolingReach)) {
  console.error(line);
}

const summary = {
  generatedAt,
  method,
  testTreeHash,
  partitions: stats,
  validityLedger,
  toolingReachGap: {
    unledgeredUnreached: toolingReach.unledgeredUnreached,
    staleLedgered: toolingReach.staleLedgered,
    reconciled: toolingReach.reconciled,
    counts: toolingReach.counts,
  },
};
if (noLaneMaps) {
  console.error(
    "[report-coverage] no usable lane maps were produced — no merged Desktop measurement was written"
  );
} else {
  mkdirSync(mergedDir, { recursive: true });
  writeFileSync(
    join(mergedDir, "coverage-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  writeFileSync(
    join(mergedDir, "coverage-report.md"),
    renderMarkdown(stats, summary)
  );
  console.log(renderMarkdown(stats, summary));
}

if (options.compare && laneFailure) {
  console.error(
    "[report-coverage] comparison refused: the current Desktop measurement is incomplete"
  );
} else if (options.compare) {
  // A base that main has not published yet is the EXPECTED state on a fresh
  // repo and immediately after this lane lands, so it is a loud skip rather
  // than a failure. Blaming a branch for main not having measured yet is the
  // stale-artifact failure mode this design exists to remove.
  if (options.basePath && existsSync(options.basePath)) {
    // A truncated artifact download is indistinguishable, for our purposes,
    // from main never having published one: in both cases there is nothing
    // trustworthy to compare against. The header promises a LOUD SKIP at exit
    // 0 for that state, so a corrupt base must not abort the report either.
    const verdict = compareToBaseIfReadable(
      options.basePath,
      stats,
      method,
      testTreeHash
    );
    if (verdict !== null) {
      console.log(
        `[report-coverage] compare: ${verdict.outcome} — ${verdict.detail}`
      );
      for (const note of verdict.notes) {
        console.log(
          `  note ${note.partition}: base ${note.basePct ?? "?"}% → current ${note.currentPct ?? "?"}% (${note.reason})`
        );
      }
      for (const drop of verdict.drops) {
        console.log(
          `  ${drop.partition}: base ${drop.basePct ?? "?"}% → current ${drop.currentPct ?? "?"}%${drop.reason ? ` (${drop.reason})` : ""}`
        );
      }
      if (verdict.outcome === CompareOutcome.Discontinuity) {
        process.exit(3);
      }
      if (verdict.outcome === CompareOutcome.Drop) {
        process.exit(2);
      }
    }
  } else {
    console.log(
      `[report-coverage] compare skipped: no base report at ${options.basePath ?? "<--base not given>"} — ` +
        "main has not published a coverage run for this path yet; nothing to compare against."
    );
  }
}

if (laneFailure) {
  process.exitCode = process.exitCode || 1;
}

/**
 * Compare against the base artifact, or return null when it cannot be read.
 *
 * A truncated artifact download is, for our purposes, the same situation as
 * main never having published one: there is nothing trustworthy to compare
 * against. Both are a loud skip at exit 0 — aborting here would throw away the
 * report itself, which is the actual product of this run.
 */
function compareToBaseIfReadable(
  basePath,
  currentStats,
  currentMethod,
  currentTestTreeHash
) {
  try {
    return compareToBase(
      currentStats,
      currentMethod,
      readJson(basePath),
      currentTestTreeHash
    );
  } catch (error) {
    console.log(
      `[report-coverage] compare skipped: base report at ${basePath} is unreadable (${error instanceof Error ? error.message : String(error)}) — the artifact was likely truncated; nothing to compare against.`
    );
    return null;
  }
}
