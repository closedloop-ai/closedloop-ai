/**
 * ISS-4638 — the desktop `node:test` shard partition.
 *
 * The failure this guards is silent by construction: a shard that drops files
 * does not go red, it just stops running them, and every shard still reports
 * success. So the assertions here are the partition PROPERTY (union == input,
 * pairwise disjoint) over the real shard counts, not a spot-check of one index.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { censusTestFiles } from "../scripts/node-test-census.mjs";
import {
  parseShardSpec,
  selectShard,
} from "../scripts/run-node-tests-shard.mjs";
import nodeConfig, { nodeLaneInclude } from "../vitest.node.config.js";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

const SHARD_COUNTS = [1, 2, 3, 4, 8] as const;

/**
 * `run-node-tests.mjs` runs the suite on import, so it cannot be imported —
 * only executed. Spawn it with a stub `pnpm` first on PATH that records its argv
 * instead of running anything, which is the only way to see the file list the
 * runner ACTUALLY hands the test process.
 */
const RUNNER_SCRIPT = join(desktopDir, "scripts/run-node-tests.mjs");

/** Spawning node + a shell stub, per case; includes full-coverage CI contention. */
const RUNNER_SPAWN_TIMEOUT_MS = 120_000;

/** ISS-4933: the runner spawns two lanes, so the stub records one block per spawn. */
const LANE_SEPARATOR = "---lane---";

/** The stub records the shard it was HANDED, on its own line, before the argv. */
const INHERITED_SHARD_PREFIX = "NODE_TEST_SHARD=";

type CapturedLane = {
  /** The lane's argv, as `pnpm` received it. */
  argv: string[];
  /** `NODE_TEST_SHARD` as the CHILD saw it — empty string when unset. */
  inheritedShard: string;
};

type CapturedRun = {
  lanes: CapturedLane[];
  /** The runner's own exit status. */
  status: number | null;
};

/**
 * Run run-node-tests.mjs against a stub `pnpm` and report what it spawned.
 *
 * APPEND, not overwrite. Since ISS-4933 the runner spawns twice — Vitest for the
 * shim-compatible files, then `tsx --test` for the remainder — and a stub that
 * truncated would show only the second, leaving every assertion about the first
 * asserting nothing at all.
 *
 * The stub also records `NODE_TEST_SHARD` as the CHILD received it. The Vitest
 * lane carries no file list in its argv (`vitest.node.config.ts` derives
 * `include`), so the env is the only place the shard crosses that process
 * boundary — and wongk's finding on PR #4532 was precisely that proving the
 * SELECTOR proves nothing about the entrypoint. Without this, scrubbing the
 * child env would leave all three matrix legs running all 776 Vitest files with
 * every assertion in this file still green.
 *
 * `failingLaneMatch` makes the stub exit non-zero for the lane whose argv
 * contains that token, so the two-lane outcome aggregation can be driven.
 */
function spawnRunnerAndCapture(
  shardSpec: string | undefined,
  failingLaneMatch?: string
): CapturedRun {
  const sandbox = mkdtempSync(join(tmpdir(), "run-node-tests-argv-"));
  try {
    const binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    const argvFile = join(sandbox, "argv.txt");
    // `stdio: "inherit"`, so the stub must not report on stdout.
    const failClause =
      failingLaneMatch === undefined
        ? ""
        : `for a in "$@"; do [ "$a" = ${JSON.stringify(failingLaneMatch)} ] && exit 3; done\n`;
    writeFileSync(
      join(binDir, "pnpm"),
      `#!/bin/sh\n{ echo "${INHERITED_SHARD_PREFIX}\${NODE_TEST_SHARD:-}"; printf '%s\\n' "$@"; echo ${LANE_SEPARATOR}; } >> ${JSON.stringify(argvFile)}\n${failClause}exit 0\n`,
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = { ...process.env, PATH: binDir };
    // A leaked GITHUB_STEP_SUMMARY would have the runner append to the real
    // job summary from inside a test.
    Reflect.deleteProperty(env, "GITHUB_STEP_SUMMARY");
    if (shardSpec === undefined) {
      Reflect.deleteProperty(env, "NODE_TEST_SHARD");
    } else {
      env.NODE_TEST_SHARD = shardSpec;
    }

    const result = spawnSync(process.execPath, [RUNNER_SCRIPT], {
      cwd: desktopDir,
      encoding: "utf8",
      env,
      timeout: RUNNER_SPAWN_TIMEOUT_MS,
    });
    // A helper precondition, not a test assertion: if the runner did not reach
    // its spawn there is no argv to compare, and the caller's `deepEqual` would
    // report a confusing empty-list diff instead of the real cause.
    if (result.status !== 0 && failingLaneMatch === undefined) {
      throw new Error(
        `runner exited ${result.status}\n${result.stdout}\n${result.stderr}`
      );
    }

    const lanes: CapturedLane[] = [];
    let current: string[] = [];
    let inheritedShard = "";
    for (const line of readFileSync(argvFile, "utf8").split("\n")) {
      if (line === LANE_SEPARATOR) {
        lanes.push({ argv: current, inheritedShard });
        current = [];
        inheritedShard = "";
      } else if (line.startsWith(INHERITED_SHARD_PREFIX)) {
        inheritedShard = line.slice(INHERITED_SHARD_PREFIX.length);
      } else if (line !== "") {
        current.push(line);
      }
    }
    return { lanes, status: result.status };
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
}

/** Hoisted per Ultracite's `useTopLevelRegex` rule. */
const MALFORMED_SPEC_MESSAGE = /NODE_TEST_SHARD must be/;
const OUT_OF_RANGE_MESSAGE = /out of range/;

function syntheticFiles(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `test/file-${index}.test.ts`
  );
}

function realTestFiles(): string[] {
  return readdirSync(join(desktopDir, "test"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

describe("parseShardSpec", () => {
  it("treats unset and empty as unsharded", () => {
    assert.equal(parseShardSpec(undefined), null);
    assert.equal(parseShardSpec(null), null);
    assert.equal(parseShardSpec(""), null);
    assert.equal(parseShardSpec("   "), null);
  });

  it("parses a 1-based index/total pair", () => {
    assert.deepEqual(parseShardSpec("1/3"), { index: 1, total: 3 });
    assert.deepEqual(parseShardSpec(" 3/3 "), { index: 3, total: 3 });
    assert.deepEqual(parseShardSpec("1/1"), { index: 1, total: 1 });
  });

  it("throws rather than falling back to the full suite on a malformed spec", () => {
    // Falling back would run every file on every shard runner — a silent 3x
    // cost regression that reports green.
    for (const malformed of [
      "abc",
      "1",
      "1/",
      "/3",
      "1/2/3",
      "1-3",
      "one/three",
    ]) {
      assert.throws(
        () => parseShardSpec(malformed),
        MALFORMED_SPEC_MESSAGE,
        `${malformed} must be rejected`
      );
    }
  });

  it("throws on an out-of-range shard", () => {
    for (const outOfRange of ["0/3", "4/3", "1/0", "0/0"]) {
      assert.throws(
        () => parseShardSpec(outOfRange),
        OUT_OF_RANGE_MESSAGE,
        `${outOfRange} must be rejected`
      );
    }
  });
});

describe("selectShard", () => {
  it("returns every file when unsharded", () => {
    const files = syntheticFiles(7);
    assert.deepEqual(selectShard(files, null), files);
  });

  it("returns a copy, so a caller cannot mutate the source list", () => {
    const files = syntheticFiles(3);
    const selected = selectShard(files, null);
    selected.push("test/injected.test.ts");
    assert.equal(files.length, 3);
  });

  for (const total of SHARD_COUNTS) {
    it(`partitions the real suite across ${total} shard(s) with nothing lost or duplicated`, () => {
      const files = realTestFiles();
      assert.ok(
        files.length > total,
        `expected more desktop test files than shards, found ${files.length}`
      );

      const seen: string[] = [];
      for (let index = 1; index <= total; index++) {
        const selected = selectShard(
          files,
          parseShardSpec(`${index}/${total}`)
        );
        assert.ok(
          selected.length > 0,
          `shard ${index}/${total} selected no files — that shard's runner would exit 1`
        );
        seen.push(...selected);
      }

      // Disjoint: no file runs twice (which would double the suite's cost and
      // report the same test's history twice).
      assert.equal(
        new Set(seen).size,
        seen.length,
        `shards of ${total} overlap; ${seen.length - new Set(seen).size} file(s) run more than once`
      );
      // Complete: no file is dropped. This is the assertion that fails if the
      // stride math is replaced by a contiguous slice with a rounding bug.
      assert.deepEqual(
        [...seen].sort(),
        files,
        `shards of ${total} do not cover the suite; ${files.length - new Set(seen).size} file(s) would never run`
      );
    });
  }

  it("partitions a suite whose size is NOT divisible by the shard count", () => {
    // The real file count happens to divide evenly by the 3 shards pr-test.yml
    // uses today, which would hide a contiguous-slice rounding bug at exactly
    // the count that ships. Drive the remainder explicitly so it cannot.
    for (const count of [700, 701, 702, 703]) {
      const files = syntheticFiles(count);
      const seen: string[] = [];
      for (let index = 1; index <= 3; index++) {
        seen.push(...selectShard(files, parseShardSpec(`${index}/3`)));
      }
      assert.equal(new Set(seen).size, seen.length, `${count} files: overlap`);
      assert.deepEqual(
        [...seen].sort(),
        [...files].sort(),
        `${count} files across 3 shards drops ${count - new Set(seen).size} file(s)`
      );
    }
  });

  it("balances shard sizes to within one file", () => {
    // A stride partition is inherently balanced by COUNT. Duration balance is
    // not asserted — it is not a property of the split — but a count skew would
    // mean the stride was replaced by something that groups files, which is what
    // turns one shard into the new critical path.
    const files = syntheticFiles(701);
    const sizes = [1, 2, 3].map(
      (index) => selectShard(files, parseShardSpec(`${index}/3`)).length
    );
    assert.ok(
      Math.max(...sizes) - Math.min(...sizes) <= 1,
      `shard sizes ${sizes.join(", ")} differ by more than one file`
    );
  });

  it("keeps every file when there is exactly one shard", () => {
    const files = realTestFiles();
    assert.deepEqual(selectShard(files, parseShardSpec("1/1")), files);
  });
});

describe("run-node-tests.mjs honours NODE_TEST_SHARD", () => {
  // wongk, PR #4532: everything above proves the SELECTOR. None of it proves the
  // selector is wired into the entrypoint. Deleting the `parseShardSpec` /
  // `selectShard` pair from run-node-tests.mjs leaves this whole file green
  // while all three matrix legs run every file — a silent 3x cost regression
  // that reports success. These cases execute the real script and read the argv
  // it actually spawned.
  /**
   * ISS-4933. The Vitest lane carries NO file list on the command line —
   * `vitest.node.config.ts` derives `include` from the same census and the same
   * `selectShard` — so what this asserts about it is that it was spawned
   * against that config. The file set it resolves to is asserted where it is
   * decided, in test/node-test-census.test.ts.
   */
  function vitestLane(lanes: CapturedLane[]): CapturedLane {
    const lane = lanes.find((candidate) => candidate.argv.includes("vitest"));
    // A helper precondition, not a test assertion — same reason the spawn
    // helper above throws: with no such lane the caller's `deepEqual` would
    // report an `undefined` diff instead of the real cause.
    if (lane === undefined) {
      throw new Error(
        `the runner must spawn the Vitest lane; spawned: ${JSON.stringify(lanes)}`
      );
    }
    return lane;
  }

  /** The remaining `tsx --test` lane — mostly the set ISS-4934 converts. */
  function legacyLane(lanes: CapturedLane[]): CapturedLane {
    const lane = lanes.find((candidate) => candidate.argv.includes("--test"));
    if (lane === undefined) {
      throw new Error(
        `the runner must still spawn the legacy node:test lane; spawned: ${JSON.stringify(lanes)}`
      );
    }
    return lane;
  }

  function laneFiles(lane: CapturedLane): string[] {
    return lane.argv.filter((argument) => argument.startsWith("test/"));
  }

  /** The Vitest lane's exact argv — it must carry the config and NO file list. */
  const VITEST_LANE_ARGV = [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.node.config.ts",
  ];

  it("spawns the whole suite when NODE_TEST_SHARD is unset", {
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  }, () => {
    const { lanes } = spawnRunnerAndCapture(undefined);

    // The unsharded contract every non-PR caller depends on: desktop-release,
    // the post-merge validation/auto-revert lanes and a local `pnpm test`.
    assert.deepEqual(
      vitestLane(lanes).argv,
      VITEST_LANE_ARGV,
      "the Vitest lane must run the node config, and must not be handed a file list that could drift from the config's"
    );
    assert.deepEqual(laneFiles(legacyLane(lanes)), censusTestFiles().nodeTest);
    assert.equal(
      vitestLane(lanes).inheritedShard,
      "",
      "an unsharded run must not manufacture a shard for the Vitest child"
    );
  });

  it("spawns exactly this shard's files, and the three shards together spawn the suite", {
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  }, () => {
    const expectedAll = censusTestFiles().nodeTest;
    const seen: string[] = [];

    for (let index = 1; index <= 3; index++) {
      const spec = `${index}/3`;
      const { lanes } = spawnRunnerAndCapture(spec);
      assert.deepEqual(vitestLane(lanes).argv, VITEST_LANE_ARGV);
      // The Vitest lane's file list is not in its argv, so the ENV is where the
      // shard has to cross that process boundary. Scrubbing it would otherwise
      // leave all three legs running all 776 files with this file still green.
      assert.equal(
        vitestLane(lanes).inheritedShard,
        spec,
        `the Vitest child must inherit NODE_TEST_SHARD=${spec}; without it vitest.node.config.ts derives the WHOLE census on every matrix leg`
      );
      const spawned = laneFiles(legacyLane(lanes));
      assert.deepEqual(
        spawned,
        selectShard(expectedAll, parseShardSpec(spec)),
        `NODE_TEST_SHARD=${spec} must reach the spawned argv as this shard's files, not the whole suite`
      );
      seen.push(...spawned);
    }

    assert.equal(new Set(seen).size, seen.length, "shards overlapped");
    assert.deepEqual(
      [...seen].sort(),
      expectedAll,
      "the three real runner invocations did not cover the legacy lane"
    );
  });

  for (const [label, token] of [
    ["Vitest", "vitest"],
    ["legacy node:test", "--test"],
  ] as const) {
    it(`fails the run when the ${label} lane fails, and still runs the other`, {
      timeout: RUNNER_SPAWN_TIMEOUT_MS,
    }, () => {
      const { lanes, status } = spawnRunnerAndCapture(undefined, token);

      // The aggregation the runner does over two lanes is the whole gate: a
      // reducer that read only the first result, or defaulted a failing lane's
      // status to 0, would exit 0 on a red REQUIRED check.
      assert.notEqual(
        status,
        0,
        `a failing ${label} lane must fail the runner, not be averaged away`
      );
      // And the other lane must still have been given its turn — stopping at
      // the first red would report its files as absent rather than as passing.
      assert.equal(
        lanes.length,
        2,
        `both lanes must run even when ${label} fails; got ${lanes.length}`
      );
    });
  }

  it("refuses to run rather than falling back to the full suite on a bad shard", {
    timeout: RUNNER_SPAWN_TIMEOUT_MS,
  }, () => {
    // parseShardSpec throws; the point here is that the ENTRYPOINT lets it
    // throw instead of catching and running everything.
    const sandbox = mkdtempSync(join(tmpdir(), "run-node-tests-bad-"));
    try {
      const binDir = join(sandbox, "bin");
      mkdirSync(binDir);
      const argvFile = join(sandbox, "argv.txt");
      writeFileSync(
        join(binDir, "pnpm"),
        `#!/bin/sh\nprintf 'spawned\\n' > ${JSON.stringify(argvFile)}\nexit 0\n`,
        { mode: 0o755 }
      );

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_TEST_SHARD: "4/3",
        PATH: binDir,
      };
      Reflect.deleteProperty(env, "GITHUB_STEP_SUMMARY");

      const result = spawnSync(process.execPath, [RUNNER_SCRIPT], {
        cwd: desktopDir,
        encoding: "utf8",
        env,
        timeout: RUNNER_SPAWN_TIMEOUT_MS,
      });

      assert.notEqual(result.status, 0, "an out-of-range shard must fail");
      assert.match(result.stderr, OUT_OF_RANGE_MESSAGE);
      assert.throws(() => readFileSync(argvFile, "utf8"));
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});

describe("vitest.node.config.ts honours NODE_TEST_SHARD", () => {
  // The Vitest lane's file list never appears in the runner's argv — the config
  // derives it — so the wiring assertion has to be made against the config
  // itself. Without this, deleting `selectShard` from the config leaves every
  // assertion above green while all three matrix legs run all 776 files.
  it("ships an include that IS the derivation, not a parallel list", () => {
    assert.deepEqual(
      nodeConfig.test?.include,
      nodeLaneInclude(process.env.NODE_TEST_SHARD),
      "the config's `include` must be `nodeLaneInclude()` under the ambient shard — a hand-written glob here would decouple what runs from the census and the partition"
    );
  });

  it("aliases node:test onto the shim", () => {
    // The one line all 776 migrated files rest on. Removing it is loud (Vitest
    // collects nothing) but nothing else in the suite pins it, and the shim's
    // own test imports `node:test` rather than the shim, so it cannot tell the
    // two apart.
    const alias = nodeConfig.resolve?.alias as
      | Record<string, string>
      | undefined;
    assert.ok(alias, "the node config must declare resolve.alias");
    assert.equal(
      alias["node:test"],
      join(desktopDir, "test/support/node-test-vitest-shim.ts")
    );
  });

  it("gives hooks the same cap as tests", () => {
    // Vitest defaults `hookTimeout` to 10s while node:test's `--test-timeout`
    // covered hooks too, so golden-layer3's ~20s fixture build started failing
    // on a difference in DEFAULTS rather than in the code. Pinned where the
    // lesson was learned.
    assert.equal(nodeConfig.test?.hookTimeout, nodeConfig.test?.testTimeout);
  });

  it("narrows the include to this shard, and the three cover the lane", () => {
    const expectedAll = censusTestFiles().vitest;
    const seen: string[] = [];
    for (let index = 1; index <= 3; index++) {
      const spec = `${index}/3`;
      const include = nodeLaneInclude(spec);
      assert.deepEqual(
        include,
        selectShard(expectedAll, parseShardSpec(spec)),
        `NODE_TEST_SHARD=${spec} must narrow the include, not leave the whole census`
      );
      assert.ok(
        include.length < expectedAll.length,
        `NODE_TEST_SHARD=${spec} selected every file — the shard spec is being ignored`
      );
      seen.push(...include);
    }

    assert.equal(new Set(seen).size, seen.length, "shards overlapped");
    assert.deepEqual(
      [...seen].sort(),
      [...expectedAll].sort(),
      "the three shards did not cover the Vitest lane"
    );
  });
});
