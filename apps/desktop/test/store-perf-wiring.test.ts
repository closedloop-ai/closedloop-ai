/**
 * @file store-perf-wiring.test.ts
 * @description ISS-6339 — the PRODUCTION wiring of the store-performance
 * signals, against a real libSQL store opened by `openSqliteAgentDatabase`.
 *
 * The unit test beside this one proves the accumulator counts correctly, which
 * stays green with the accumulator wired to nothing. What actually breaks in the
 * field is the wiring: the adapter hook not installed, the recorder handed to a
 * connection that is then replaced, the sampler never started, the migration
 * sink never passed. Every one of those leaves a correct, fully-tested module
 * emitting nothing — the ISS-7109 shape.
 *
 * So this drives the real path end to end and asserts on what came out of the
 * sink, which is only reachable if every link exists.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  readStoreSizeSample,
  type StorePerfSampler,
} from "../src/main/database/db-host/store-perf-sampler.js";
import type { MigrationStep } from "../src/main/database/migration/migration-runner.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  MigrationStepOutcome,
  SqlStatementFamily,
  type StorePerfDiagnostics,
} from "../src/main/telemetry/telemetry-protocol.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";
import { waitForCondition } from "./wait-for-condition.js";

const tempDirs: string[] = [];

afterEach(async () => {
  nodeTestTimers.reset();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

test("opening the store instruments real reads and reports them with the size gauges", async () => {
  const samples: StorePerfDiagnostics[] = [];
  const db = await openInstrumentedDatabase({
    onStorePerfSample: (sample) => samples.push(sample),
    intervalMs: 5,
  });
  try {
    // A real read on the real client — the statement crosses the same adapter
    // boundary every production read crosses.
    await db.sessions.count();

    await waitForSample(samples);
    const [sample] = samples;
    assert.ok(sample, "a sample must be produced after real statements ran");
    const select = sample.families.find(
      (row) => row.family === SqlStatementFamily.Select
    );
    assert.ok(
      select && select.count > 0,
      `the read was not observed; families=${JSON.stringify(sample.families)}`
    );
    // Slice (b): the store is on disk, so its size is KNOWN and reported.
    assert.ok(
      typeof sample.dbSizeBytes === "number" && sample.dbSizeBytes > 0,
      "dbSizeBytes must be read from the store file"
    );
    // The WAL sidecar may legitimately be absent (checkpointed away), which is a
    // real zero — but it must be reported either way, never omitted silently
    // when the file is there.
    assert.equal(typeof sample.walSizeBytes, "number");
    assert.deepEqual(sample.bucketBoundsMs.length > 0, true);
  } finally {
    await db.close();
  }
});

test("the sampler the store starts is stopped by close, and its emit is the production sink", async () => {
  // ISS-7919: this is a NON-OCCURRENCE assertion, so neither half of it may be
  // decided by waiting. Two guesses had to go, not one.
  //
  // WHEN the sampler fires is decided by advancing the sampler's OWN clock. The
  // old shape slept 40ms against a 5ms sampler, which is asymmetric in both
  // directions: it reddened on scheduler noise under load, and it would have
  // gone GREEN if the sampler leaked but happened not to be scheduled inside
  // that window. A stopped interval fires zero callbacks however far the clock
  // moves, so ticking it is a decision instead of a race.
  //
  // WHEN a fired tick has FINISHED is decided by the sampler's own
  // `whenSamplesSettled()`. Ticking is synchronous but `sampleOnce` awaits a
  // real `stat`, so the emit lands on a later turn — and a fixed count of
  // event-loop turns is just a sleep denominated in turns, wrong on a loaded
  // host in the direction that hides the bug: it reads `samples.length` before
  // a leaked sampler's `stat` came back and calls the not-yet an absence.
  //
  // Only `setInterval` is faked, and the barrier is the production sampler's
  // own signal rather than a stub. The store's real libSQL/Prisma I/O still runs
  // on the real event loop, which is what keeps this an end-to-end wiring test.
  const samples: StorePerfDiagnostics[] = [];
  const startedSamplers: StorePerfSampler[] = [];
  nodeTestTimers.enable(["setInterval"]);
  const db = await openInstrumentedDatabase({
    onStorePerfSample: (sample) => samples.push(sample),
    intervalMs: SAMPLER_INTERVAL_MS,
    onStorePerfSamplerStarted: (sampler) => startedSamplers.push(sampler),
  });
  const sampler = startedSamplers[0];
  assert.ok(
    sampler,
    "opening the store must start a sampler; there is nothing to stop otherwise"
  );
  try {
    await db.sessions.count();
    nodeTestTimers.tick(SAMPLER_INTERVAL_MS);
    await sampler.whenSamplesSettled();
    assert.ok(
      samples.length > 0,
      "the sampler's own interval must produce the sample; a store that wired the sink but never started the timer emits nothing"
    );
    assert.ok(
      samples[0].families.some(
        (row) => row.family === SqlStatementFamily.Select
      )
    );
  } finally {
    await db.close();
  }
  const afterClose = samples.length;
  // The close path itself runs statements after the sampler is stopped
  // (scheduler dispose, queue drain, disconnect), and this adds one more
  // against the torn-down connection. So a sampler that survived close has
  // undrained work waiting and WOULD emit on its next tick — which is what
  // makes the next line able to fail.
  await db.sessions.count().catch(() => undefined);
  nodeTestTimers.tick(SAMPLER_INTERVAL_MS * STOPPED_SAMPLER_PERIODS);
  // Resolves on an already-settled tail when the sampler is stopped, because a
  // stopped sampler started nothing; when it is NOT stopped this awaits all
  // the ticks the line above just fired, `stat` included.
  await sampler.whenSamplesSettled();
  assert.equal(
    samples.length,
    afterClose,
    `close() must stop the sampler; ${STOPPED_SAMPLER_PERIODS} further periods of its own clock emitted a sample, so a tick ran against a torn-down connection`
  );
});

test("every migration executed at boot reports its duration and outcome", async () => {
  const steps: MigrationStep[] = [];
  const db = await openInstrumentedDatabase({
    onMigrationStep: (step) => steps.push(step),
  });
  try {
    assert.ok(
      steps.length > 0,
      "a fresh store applies its whole manifest; zero steps means the sink is unwired"
    );
    for (const step of steps) {
      assert.equal(step.outcome, MigrationStepOutcome.Applied);
      assert.ok(step.name.length > 0);
      assert.ok(Number.isInteger(step.durationMs) && step.durationMs >= 0);
    }
    // Names come from THIS BUILD's manifest, so they are unique and bounded.
    assert.equal(new Set(steps.map((step) => step.name)).size, steps.length);
  } finally {
    await db.close();
  }
});

test("re-opening the same store reports no migration steps", async () => {
  // The second boot has nothing pending, so an implementation that reported a
  // step per manifest ENTRY rather than per EXECUTED migration would fire on
  // every launch and make the duration signal meaningless.
  const dir = await mkdtemp(path.join(tmpdir(), "iss-6339-store-perf-"));
  tempDirs.push(dir);
  const dataDir = path.join(dir, "agent-dashboard.sqlite");
  const first = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
    onMigrationStep: () => undefined,
    onStorePerfSample: () => undefined,
  });
  await first.close();

  const steps: MigrationStep[] = [];
  const second = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered",
    resolveGitPath: () => "/usr/bin/git",
    onMigrationStep: (step) => steps.push(step),
    onStorePerfSample: () => undefined,
  });
  try {
    assert.deepEqual(steps, []);
  } finally {
    await second.close();
  }
});

test("transactional and executeRaw statements land in the histogram too", async () => {
  // The defect this guards: the ISS-5336 spy intercepts only the adapter's own
  // `queryRaw`, so `executeRaw` (PRAGMAs, row-count-only writes) and EVERY
  // statement served by a transaction's own object were invisible. The store's
  // heaviest work — the analytics fan-out, the importer, the backfill — is
  // exactly the transactional work, so a histogram missing it reports an
  // unmeasured path as a quiet one while the emitted message still calls the
  // total "statements the local store ran".
  const samples: StorePerfDiagnostics[] = [];
  const db = await openInstrumentedDatabase({
    onStorePerfSample: (sample) => samples.push(sample),
    intervalMs: 5,
  });
  try {
    await db.prisma.write(async (client) => {
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO "sessions" ("id", "status") VALUES (?1, ?2)',
          "iss-6339-tx",
          "active"
        );
      });
    });
    await waitForSample(samples);
    const families = new Set(
      samples.flatMap((sample) => sample.families.map((row) => row.family))
    );
    assert.ok(
      families.has(SqlStatementFamily.Insert),
      `the transactional INSERT was not observed; saw ${[...families].join(", ")}`
    );
  } finally {
    await db.close();
  }
});

test("the sampler keeps sampling — one tick is not a cadence", async () => {
  // A `setTimeout` where a `setInterval` belongs, or an interval that clears
  // itself after the first fire, satisfies every other assertion in this file:
  // they all need exactly one sample. This is the only case that would redden.
  const samples: StorePerfDiagnostics[] = [];
  const db = await openInstrumentedDatabase({
    onStorePerfSample: (sample) => samples.push(sample),
    intervalMs: 5,
  });
  try {
    await waitForCondition(
      async () => {
        if (samples.length >= 3) {
          return true;
        }
        // New work each round: an empty window drains to null and emits
        // nothing, so a recurring timer with nothing to report would look
        // identical to a one-shot one without this.
        await db.sessions.count();
        return false;
      },
      5000,
      10,
      () => `expected a recurring cadence, saw ${samples.length} sample(s)`
    );
    assert.ok(
      samples.length >= 3,
      `expected a recurring cadence, saw ${samples.length} sample(s)`
    );
  } finally {
    await db.close();
  }
});

test("a size that could not be read is omitted, never reported as zero", async () => {
  // The invariant the gauges rest on: a `stat` that did not resolve leaves the
  // size UNKNOWN, and a zero would read as an empty store — the reassuring
  // wrong number this whole ticket exists to stop.
  const dir = await mkdtemp(path.join(tmpdir(), "iss-6339-store-perf-"));
  tempDirs.push(dir);
  const missing = path.join(dir, "no-such-store.sqlite");

  const sizes = await readStoreSizeSample(missing);

  assert.equal("dbSizeBytes" in sizes, false);
  // The WAL sidecar is the ONE case where absent is a real zero: SQLite deletes
  // it on a clean checkpoint, so "no file" means "no frames", not "unknown".
  assert.equal(sizes.walSizeBytes, 0);
});

type InstrumentedOptions = {
  onStorePerfSample?: (sample: StorePerfDiagnostics) => void;
  onMigrationStep?: (step: MigrationStep) => void;
  intervalMs?: number;
  onStorePerfSamplerStarted?: (sampler: StorePerfSampler) => void;
};

/**
 * Open a real store with the ISS-6339 sinks captured. The sampler is driven
 * through its OWN interval rather than a handle the test could call directly:
 * a store that wired the sink but never started the timer would satisfy a manual
 * call and emit nothing in production.
 */
function openInstrumentedDatabase(options: InstrumentedOptions) {
  return mkdtemp(path.join(tmpdir(), "iss-6339-store-perf-")).then((dir) => {
    tempDirs.push(dir);
    return openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered",
      resolveGitPath: () => "/usr/bin/git",
      onStorePerfSample: options.onStorePerfSample ?? (() => undefined),
      onMigrationStep: options.onMigrationStep ?? (() => undefined),
      ...(options.intervalMs === undefined
        ? {}
        : { storePerfSampleIntervalMs: options.intervalMs }),
      ...(options.onStorePerfSamplerStarted === undefined
        ? {}
        : { onStorePerfSamplerStarted: options.onStorePerfSamplerStarted }),
    });
  });
}

function waitForSample(samples: readonly unknown[]): Promise<void> {
  return waitForCondition(
    () => samples.length > 0,
    5000,
    5,
    "no store-perf sample arrived within 5000ms"
  );
}

/** The sampler cadence the stop test drives, in ms of the sampler's own clock. */
const SAMPLER_INTERVAL_MS = 5;

/**
 * Periods advanced past `close()`. A cleared interval fires zero callbacks no
 * matter how far the clock moves, so more than one would do; 40 is chosen so the
 * failure message can honestly say how much rope a leaked sampler was given.
 */
const STOPPED_SAMPLER_PERIODS = 40;
