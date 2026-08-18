import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildCoverageLanes,
  COVERAGE_MERGE_HEAP_MB,
  type CoverageLane,
  withCoverageMergeHeap,
} from "../scripts/coverage-lane-heap.mjs";

const MAX_OLD_SPACE_PATTERN = /--max-old-space-size=(\d+)/g;

// V8 honours the LAST occurrence of a repeated flag, so "what cap will actually
// apply" is the last one in the string — not the first, and not merely "one is
// present".
function effectiveHeapCapMb(nodeOptions: string | undefined): number {
  const caps = [...(nodeOptions ?? "").matchAll(MAX_OLD_SPACE_PATTERN)].map(
    (match) => Number(match[1])
  );
  return caps.at(-1) ?? Number.NaN;
}

function laneNamed(lanes: CoverageLane[], name: string): CoverageLane {
  const lane = lanes.find((candidate) => candidate.name === name);
  if (!lane) {
    throw new Error(`no ${name} lane in the coverage lane table`);
  }
  return lane;
}

describe("ISS-5299: the node coverage lane gets enough heap for c8's merge", () => {
  test("raises the cap when NODE_OPTIONS is unset", () => {
    const env = withCoverageMergeHeap({}, 4242);

    assert.equal(env.NODE_OPTIONS, "--max-old-space-size=4242");
  });

  test("keeps the rest of an inherited NODE_OPTIONS", () => {
    const env = withCoverageMergeHeap(
      { NODE_OPTIONS: "--enable-source-maps" },
      4242
    );

    assert.equal(
      env.NODE_OPTIONS,
      "--enable-source-maps --max-old-space-size=4242"
    );
  });

  test("wins over an inherited cap — V8 takes the last occurrence", () => {
    // Both coverage workflows set --max-old-space-size=3072 on their web phase,
    // and a developer may export one. Ours must be the cap V8 honours, or the
    // lane silently runs LOWER than the default it was raised from and the OOM
    // returns looking like a fresh bug.
    const env = withCoverageMergeHeap(
      { NODE_OPTIONS: "--max-old-space-size=3072" },
      4242
    );

    assert.equal(effectiveHeapCapMb(env.NODE_OPTIONS), 4242);
  });

  test("does not mutate the environment it derives from", () => {
    const original = { NODE_OPTIONS: "--enable-source-maps" };

    withCoverageMergeHeap(original, 4242);

    assert.equal(original.NODE_OPTIONS, "--enable-source-maps");
  });

  test("the shipped cap clears the merge's measured requirement", () => {
    // Calibrated in scripts/coverage-lane-heap.mjs against this branch's real
    // 2.6 GB / 1,721-file tmp set: 4,096 MB OOM'd (the bug), 5,120 MB peaked at
    // 4.70 GB, and peak RSS stopped growing at ~5.02 GB. A cap at or below what
    // the merge already needs is the bug, not a fix.
    assert.ok(
      COVERAGE_MERGE_HEAP_MB >= 8192,
      `the c8 merge needed >4 GB and peaked near 5 GB; ${COVERAGE_MERGE_HEAP_MB} MB leaves no headroom for PRD-618 to keep adding tests`
    );
  });
});

describe("ISS-5299: the lane table run-coverage-lanes.mjs executes", () => {
  test("hands the node lane a raised heap cap", () => {
    // The helper is worthless if the lane table stops using it. This drives the
    // table the entrypoint actually iterates, so deleting the raise goes red
    // here rather than silently restoring a 0%-everything coverage report.
    const lanes = buildCoverageLanes({});

    assert.equal(
      effectiveHeapCapMb(laneNamed(lanes, "node").env.NODE_OPTIONS),
      COVERAGE_MERGE_HEAP_MB
    );
  });

  test("runs the node lane before the renderer lane, and runs both", () => {
    const lanes = buildCoverageLanes({});

    assert.deepEqual(
      lanes.map((lane) => lane.name),
      ["node", "renderer"]
    );
    assert.deepEqual(laneNamed(lanes, "node").args, [
      "run",
      "test:node:coverage",
    ]);
    assert.deepEqual(laneNamed(lanes, "renderer").args, [
      "run",
      "test:renderer:coverage",
    ]);
  });

  test("leaves the renderer lane on the inherited environment", () => {
    // Scoped on purpose: @vitest/coverage-v8 streams its merge and has never
    // approached the ceiling, so raising it there would be unexplained cost.
    const lanes = buildCoverageLanes({ NODE_OPTIONS: "--enable-source-maps" });

    assert.equal(
      laneNamed(lanes, "renderer").env.NODE_OPTIONS,
      "--enable-source-maps"
    );
  });

  test("passes the caller's environment through to both lanes", () => {
    // spawnSync with an `env` REPLACES the child environment rather than
    // extending it. A lane that dropped the inherited vars would lose PATH,
    // HOME and CI — c8 and pnpm would fail to launch at all.
    const lanes = buildCoverageLanes({ PATH: "/usr/bin", CI: "true" });

    for (const lane of lanes) {
      assert.equal(lane.env.PATH, "/usr/bin", `${lane.name} lane lost PATH`);
      assert.equal(lane.env.CI, "true", `${lane.name} lane lost CI`);
    }
  });
});
