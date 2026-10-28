import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolTelemetrySample } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPerfPoolWaitSink,
  PERF_POOL_GAUGE_FILE_NAME,
  PERF_POOL_WAIT_FILE_NAME,
} from "../../lib/perf-pool-wait-sink";

/**
 * ISS-6820 — the API lane's pool-wait tee.
 *
 * The behavior worth pinning is the closed-by-default gate and the fail-open
 * contract: this runs inside a pg pool acquisition, so it must be absent unless
 * a profiling run asked for it and it must never be able to throw out of that
 * acquisition when it is present.
 */
const COUNTERS = {
  poolMax: 10,
  waitingCount: 6,
  inUse: 10,
  idle: 0,
  total: 10,
};

const SAMPLE: PoolTelemetrySample = {
  metric: "db_pool_acquire_wait",
  value: 412,
  saturated: true,
  permitQueued: false,
  ...COUNTERS,
};

describe("createPerfPoolWaitSink", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), "perf-pool-wait-"));
  });

  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("is absent when no run directory is configured", () => {
    expect(createPerfPoolWaitSink(undefined)).toBeNull();
    expect(createPerfPoolWaitSink("")).toBeNull();
    expect(createPerfPoolWaitSink("   ")).toBeNull();
  });

  it("refuses a relative directory rather than resolving it against an unknown cwd", () => {
    // The Next.js server's working directory is not the run directory, so
    // resolving one would scatter evidence somewhere nobody looks and report
    // success.
    expect(createPerfPoolWaitSink(".perf/runs/latest")).toBeNull();
  });

  it("is absent when the directory does not exist", () => {
    expect(createPerfPoolWaitSink(join(profileDir, "missing"))).toBeNull();
  });

  it("writes one JSONL row per sample, carrying a wall clock for correlation", () => {
    const sink = createPerfPoolWaitSink(profileDir);
    expect(sink).not.toBeNull();

    sink?.(SAMPLE);
    sink?.({ ...SAMPLE, value: 900 });

    const lines = readFileSync(
      join(profileDir, PERF_POOL_WAIT_FILE_NAME),
      "utf8"
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "");
    expect(first.metric).toBe(SAMPLE.metric);
    expect(first.value).toBe(SAMPLE.value);
    expect(first.poolMax).toBe(SAMPLE.poolMax);
    expect(first.waitingCount).toBe(SAMPLE.waitingCount);
    expect(first.saturated).toBe(true);
    expect(first.permitQueued).toBe(false);
    expect(typeof first.ts).toBe("number");
    expect(JSON.parse(lines[1] ?? "").value).toBe(900);
  });

  it("truncates a stale file so a rerun measures this run, not this run plus the last", () => {
    writeFileSync(
      join(profileDir, PERF_POOL_WAIT_FILE_NAME),
      '{"metric":"db_pool_acquire_wait","value":99999}\n',
      "utf8"
    );

    const sink = createPerfPoolWaitSink(profileDir);
    sink?.(SAMPLE);

    const lines = readFileSync(
      join(profileDir, PERF_POOL_WAIT_FILE_NAME),
      "utf8"
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").value).toBe(SAMPLE.value);
  });

  it("keeps connection counts out of the duration file", () => {
    // `db_pool_in_use` carries a connection COUNT in `value`. In the duration
    // file it would be summarized under millisecond columns and — the report
    // sorting by p95 — could outrank the waits and read as the worst latency in
    // the lane.
    const sink = createPerfPoolWaitSink(profileDir);

    sink?.(SAMPLE);
    sink?.({ ...COUNTERS, metric: "db_pool_in_use", value: 10 });
    sink?.({ ...COUNTERS, metric: "db_pool_total", value: 10 });

    const waits = readFileSync(
      join(profileDir, PERF_POOL_WAIT_FILE_NAME),
      "utf8"
    )
      .trim()
      .split("\n");
    const gauges = readFileSync(
      join(profileDir, PERF_POOL_GAUGE_FILE_NAME),
      "utf8"
    )
      .trim()
      .split("\n");

    expect(waits).toHaveLength(1);
    expect(JSON.parse(waits[0] ?? "").metric).toBe("db_pool_acquire_wait");
    expect(gauges.map((line) => JSON.parse(line).metric)).toEqual([
      "db_pool_in_use",
      "db_pool_total",
    ]);
  });

  it("keeps a count-only acquire timeout out of the duration file", () => {
    // An acquire timeout is emitted as `{count: 1}` with NO `value`, so a
    // duration analyzer reads it as a malformed line — turning the strongest
    // evidence that the pool is the constraint into evidence that the capture
    // is broken.
    const sink = createPerfPoolWaitSink(profileDir);

    sink?.({
      metric: "db_pool_acquire_timeout",
      count: 1,
      poolMax: 10,
      waitingCount: 12,
      inUse: 10,
      idle: 0,
      total: 10,
    });

    expect(
      readFileSync(join(profileDir, PERF_POOL_WAIT_FILE_NAME), "utf8")
    ).toBe("");
    const gauges = readFileSync(
      join(profileDir, PERF_POOL_GAUGE_FILE_NAME),
      "utf8"
    ).trim();
    expect(JSON.parse(gauges).metric).toBe("db_pool_acquire_timeout");
  });

  it("routes a checkout duration to the duration file", () => {
    const sink = createPerfPoolWaitSink(profileDir);

    sink?.({ ...COUNTERS, metric: "db_pool_checkout_duration", value: 1500 });

    const waits = readFileSync(
      join(profileDir, PERF_POOL_WAIT_FILE_NAME),
      "utf8"
    )
      .trim()
      .split("\n");
    expect(waits).toHaveLength(1);
    expect(JSON.parse(waits[0] ?? "").value).toBe(1500);
  });

  it("swallows a write failure rather than failing the acquisition that raised the sample", () => {
    const sink = createPerfPoolWaitSink(profileDir);
    rmSync(profileDir, { recursive: true, force: true });

    expect(() => sink?.(SAMPLE)).not.toThrow();
  });
});
