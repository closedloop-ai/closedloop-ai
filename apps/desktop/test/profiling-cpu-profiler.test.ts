import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  startCpuProfiler,
  stopCpuProfiler,
} from "../src/main/profiling/cpu-profiler.js";

const STOP_FAILURE_LOG = /cpu-profiler stop failed/;

let workDir = "";

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "profiling-cpu-"));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Burn a little CPU so the profiler has samples to attribute. */
function busyWork(): number {
  let total = 0;
  for (let index = 0; index < 2_000_000; index += 1) {
    total += Math.sqrt(index);
  }
  return total;
}

describe("cpu profiler", () => {
  test("stop is a no-op when no profile was started", async () => {
    const outFile = path.join(workDir, "never-started.cpuprofile");

    await stopCpuProfiler(outFile);

    assert.equal(
      existsSync(outFile),
      false,
      "must not write an artifact for a profile that never ran"
    );
  });

  test("writes a parseable .cpuprofile over the start/stop lifecycle", async () => {
    const outFile = path.join(workDir, "run.cpuprofile");

    startCpuProfiler();
    busyWork();
    await stopCpuProfiler(outFile);

    assert.ok(existsSync(outFile), "expected the profile to be written");
    const profile = JSON.parse(readFileSync(outFile, "utf8"));
    // The V8 CPU-profile shape DevTools and `scripts/perf/analyze-cpuprofile.ts`
    // both consume.
    assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
    assert.ok(Array.isArray(profile.samples));
    assert.ok(Array.isArray(profile.timeDeltas));
    assert.equal(typeof profile.startTime, "number");
    assert.ok(profile.endTime >= profile.startTime);
  });

  test("a second stop after the lifecycle completed writes nothing", async () => {
    const outFile = path.join(workDir, "second-stop.cpuprofile");

    // The previous test already ran the lifecycle to completion, so the module
    // holds no session: a stray stop on the quit path must stay inert rather
    // than throw or truncate an artifact.
    await stopCpuProfiler(outFile);

    assert.equal(existsSync(outFile), false);
  });

  test("a failed write is swallowed and reported through the logger", async () => {
    const logged: string[] = [];
    startCpuProfiler((message) => logged.push(message));
    busyWork();

    // A directory that does not exist makes the write fail; the caller must not
    // see it.
    await stopCpuProfiler(
      path.join(workDir, "missing-dir", "out.cpuprofile"),
      (message) => logged.push(message)
    );

    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", STOP_FAILURE_LOG);
  });
});
