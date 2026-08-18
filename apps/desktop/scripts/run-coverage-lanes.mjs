#!/usr/bin/env node
// ISS-4594: run both desktop coverage lanes to completion, then the merged
// report. A lane failure must NOT abort the report — the report is the product
// and a partial one that names its failures beats no report — but lane exit
// codes are preserved in this process's exit code so CI keeps its signal.
// Trailing CLI args pass through to report-coverage.mjs (--compare, --base).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCoverageLanes } from "./coverage-lane-heap.mjs";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// ISS-5299: the node lane's c8 merge is the memory-hungry step — it holds the
// whole tmp coverage set in one process after the tests have finished — and it
// OOM'd against Node's default heap once this branch's suite grew, losing the
// entire node-lane measurement. The lane table (and the heap it raises) lives
// in scripts/coverage-lane-heap.mjs so it can be tested; this file is a
// top-level script that runs the whole suite on import.
const lanes = buildCoverageLanes(process.env);

const laneFailures = [];
for (const lane of lanes) {
  const result = spawnSync(pnpm, lane.args, {
    cwd: desktopDir,
    stdio: "inherit",
    env: lane.env,
  });
  if (result.status !== 0) {
    laneFailures.push(lane.name);
  }
}

const report = spawnSync(
  process.execPath,
  ["scripts/report-coverage.mjs", ...process.argv.slice(2)],
  { cwd: desktopDir, stdio: "inherit" }
);

for (const lane of laneFailures) {
  console.error(
    `[run-coverage-lanes] ${lane} lane had test failures — the report above still covers what executed, so read its numbers as a floor rather than a measurement of the whole tree.`
  );
}
if (report.status !== 0) {
  process.exit(report.status ?? 1);
}
process.exit(laneFailures.length > 0 ? 1 : 0);
