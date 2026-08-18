/**
 * @file wal-probe-health-monitored.test.ts
 * @description ISS-4818 — a malformed WAL-frame probe row must reach the
 * MONITORED server diagnostic path, not be swallowed.
 *
 * ISS-4723 PR1 / ISS-4819 fixed the correctness half: a bad depth read yields
 * `null` and the checkpoint cadence takes the explicit unknown fallback instead
 * of reading the failure as an empty WAL (which would silently disable the
 * ceiling backstop). But it degraded SILENTLY, so a store whose depth read is
 * chronically broken ran with that backstop off and nothing said so.
 *
 * These tests walk the whole route end to end:
 *   producer   — `createDesktopPrisma` tallies the anomaly at the boundary that
 *                knows the actionable detail, and does NOT change the graceful
 *                fallback;
 *   transport  — the tally reads back as a clone-safe plain object, so it can
 *                cross the db-host method proxy;
 *   consumer   — the FEA-1999 store-integrity probe classifies it into a bounded,
 *                content-free issue and PUBLISHES it to the sink the production
 *                wiring points at `Observability.storeIntegrityResult`, the
 *                already-monitored event that owns the
 *                detected / persistent / recovered emit cadence.
 *
 * Deterministic throughout: an injected clock drives the cadence's time floor, an
 * injected probe drives the failure branch, and the publish assertion
 * synchronizes on the probe's own `emit` rather than a timed wait.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WAL_TRUNCATE_INTERVAL_MS } from "../src/main/database/connection-pragmas.js";
import {
  createStoreIntegrityProbe,
  type StoreIntegrityReader,
} from "../src/main/database/database-integrity/store-integrity-probe.js";
import type {
  CreateDesktopPrismaOptions,
  WalProbeHealth,
} from "../src/main/database/prisma-client.js";
import {
  type StoreIntegrityDiagnostics,
  WalProbeAnomalyReason,
} from "../src/main/telemetry/telemetry-protocol.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const noopWrite = () => Promise.resolve();

/**
 * Issue ONE write against a store whose depth probe behaves as `probeWalFrames`
 * says, resolving only once the maintenance pass that write triggered has fully
 * settled (the cadence's own completion signal — a fixed microtask flush would be
 * a bounded poll that can land short and flake). The clock is pinned one interval
 * ahead so the time floor is open while the write floor is short: exactly the
 * hold-vs-force branch that consults the depth probe.
 */
async function probeOnce(
  probeWalFrames: CreateDesktopPrismaOptions["probeWalFrames"]
): Promise<{ health: WalProbeHealth; truncates: number }> {
  let settle: (() => void) | null = null;
  let truncates = 0;
  const opened = await openTestPrisma(undefined, {
    now: () => WAL_TRUNCATE_INTERVAL_MS,
    probeWalFrames,
    onWalTruncate: () => {
      truncates += 1;
    },
    onWalMaintenanceSettled: () => {
      const resolve = settle;
      settle = null;
      resolve?.();
    },
  });
  try {
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    await opened.prisma.write(noopWrite);
    await settled;
    return { health: opened.prisma.readWalProbeHealth(), truncates };
  } finally {
    await opened.close();
  }
}

/** A reader that reports only WAL-probe health (the other checks stay clean). */
function walHealthReader(
  readWalProbeHealth?: () => Promise<WalProbeHealth>
): StoreIntegrityReader {
  return {
    runStoreIntegrityCheck: () =>
      Promise.resolve({ quickRows: [{ quick_check: "ok" }], indexRows: [] }),
    ...(readWalProbeHealth ? { readWalProbeHealth } : {}),
  };
}

/** A probe whose reader reports the given health, plus the diagnostics it runs. */
function runWithHealth(
  health: WalProbeHealth,
  log?: (message: string) => void
): Promise<StoreIntegrityDiagnostics> {
  return createStoreIntegrityProbe(
    walHealthReader(() => Promise.resolve(health)),
    { emit: () => undefined, ...(log ? { log } : {}) }
  ).runOnce();
}

test("a malformed depth row is TALLIED at the boundary, and the graceful fallback is unchanged", async () => {
  // A non-numeric depth: the read completed but produced no usable frame count.
  const { health, truncates } = await probeOnce(() => Number.NaN);

  assert.equal(health.measurable, true);
  assert.equal(health.probes, 1);
  assert.equal(health.anomalies, 1);
  assert.equal(health.lastAnomalyReason, WalProbeAnomalyReason.MalformedRow);
  // The ISS-4723 / ISS-4819 behavior is untouched: an UNKNOWN depth still falls
  // back to the base timer TRUNCATE rather than assuming the WAL is small. This
  // change is observability ONLY.
  assert.equal(truncates, 1);
});

test("a THROWING depth probe is tallied with its own distinct reason", async () => {
  const { health, truncates } = await probeOnce(() => {
    throw new Error("stat exploded");
  });

  assert.equal(health.anomalies, 1);
  // The two failure modes point at different root causes, so they must not be
  // collapsed into one reason.
  assert.equal(health.lastAnomalyReason, WalProbeAnomalyReason.ProbeThrew);
  assert.equal(truncates, 1);
});

test("a HEALTHY depth read tallies an attempt and NO anomaly", async () => {
  const { health } = await probeOnce(() => 0);

  assert.equal(health.probes, 1);
  // The counter must increment only inside the branch whose precondition held —
  // a successful read must never inflate the anomaly signal.
  assert.equal(health.anomalies, 0);
  assert.equal(health.lastAnomalyReason, null);
});

test("a tallied anomaly is PUBLISHED to the monitored sink as a bounded issue", async () => {
  // The regression this ticket exists for: prove the anomaly reaches the sink the
  // production wiring hands to `emit` (Observability.storeIntegrityResult) rather
  // than dying inside the cadence. Synchronize on that emit itself.
  const emitted: StoreIntegrityDiagnostics[] = [];
  let published: (() => void) | null = null;
  const firstEmit = new Promise<void>((resolve) => {
    published = resolve;
  });
  const probe = createStoreIntegrityProbe(
    walHealthReader(() =>
      Promise.resolve({
        measurable: true,
        probes: 12,
        anomalies: 4,
        lastAnomalyReason: WalProbeAnomalyReason.MalformedRow,
      })
    ),
    {
      emit: (diagnostics) => {
        emitted.push(diagnostics);
        const resolve = published;
        published = null;
        resolve?.();
      },
      initialDelayMs: 0,
      intervalMs: 60_000,
    }
  );

  probe.start();
  try {
    await firstEmit;
  } finally {
    probe.stop();
  }

  assert.equal(emitted.length, 1);
  const diagnostics = emitted[0];
  assert.ok(diagnostics.checksRun.includes("wal_frame_probe"));
  // A chronically failing probe is NOT a healthy store — it means the WAL ceiling
  // backstop has been running blind.
  assert.equal(diagnostics.healthy, false);
  const walIssues = diagnostics.issues.filter(
    (issue) => issue.check === "wal_frame_probe"
  );
  assert.equal(walIssues.length, 1);
  assert.equal(walIssues[0]?.category, "wal_probe_failure");
  // The bounded failure-mode enum rides the identifier slot; the `-wal` path is a
  // user filesystem path and must never leave the machine.
  assert.equal(walIssues[0]?.object, WalProbeAnomalyReason.MalformedRow);
});

test("an UNMEASURABLE store (no -wal sidecar) is not reported as an anomaly", async () => {
  const diagnostics = await runWithHealth({
    measurable: false,
    probes: 0,
    anomalies: 0,
    lastAnomalyReason: null,
  });

  // An in-memory / remote store has no depth to measure; an unknown depth is the
  // CORRECT answer there. Reporting it would fire a permanent false alert.
  assert.ok(diagnostics.checksRun.includes("wal_frame_probe"));
  assert.equal(diagnostics.healthy, true);
  assert.equal(
    diagnostics.issues.filter((issue) => issue.check === "wal_frame_probe")
      .length,
    0
  );
});

test("a clean probe tally runs the check and raises nothing", async () => {
  const diagnostics = await runWithHealth({
    measurable: true,
    probes: 40,
    anomalies: 0,
    lastAnomalyReason: null,
  });

  assert.ok(diagnostics.checksRun.includes("wal_frame_probe"));
  assert.equal(diagnostics.healthy, true);
});

test("a reader without the health method skips the check instead of failing", async () => {
  const diagnostics = await createStoreIntegrityProbe(walHealthReader(), {
    emit: () => undefined,
  }).runOnce();

  // Version-skew safety: a reader that does not implement the method simply does
  // not run the check.
  assert.equal(diagnostics.healthy, true);
  assert.ok(!diagnostics.checksRun.includes("wal_frame_probe"));
});

test("a THROWING health read degrades to a skipped check, never a failed probe run", async () => {
  const logs: string[] = [];
  const diagnostics = await createStoreIntegrityProbe(
    walHealthReader(() => Promise.reject(new Error("proxy down"))),
    { emit: () => undefined, log: (m) => logs.push(m) }
  ).runOnce();

  // The WAL-health read is a diagnostic add-on: it must never take down the
  // quick_check / index-presence signal it rides alongside.
  assert.equal(diagnostics.healthy, true);
  assert.ok(!diagnostics.checksRun.includes("wal_frame_probe"));
  assert.ok(logs.some((m) => m.includes("wal frame probe health read failed")));
});

test("readWalProbeHealth reports the WINDOW since the last read, so health can RECOVER", async () => {
  // The reviewed defect: a monotonic lifetime tally read as a point-in-time
  // verdict. One transient anomaly made `anomalies > 0` true forever, so every
  // later probe run pushed a wal_probe_failure, `store.integrity.recovered`
  // could never fire (for the WAL check OR for a real quick_check/index failure
  // riding the same `healthy`), and `failure_persistent` fired on every
  // heartbeat for a probe that was working again.
  let frames = Number.NaN;
  let settle: (() => void) | null = null;
  // The depth probe only runs when the cadence's time floor is open, so the
  // clock advances a full interval per write — otherwise the second write would
  // skip the probe entirely and prove nothing about recovery.
  let clock = WAL_TRUNCATE_INTERVAL_MS;
  const opened = await openTestPrisma(undefined, {
    now: () => clock,
    probeWalFrames: () => frames,
    onWalMaintenanceSettled: () => {
      const resolve = settle;
      settle = null;
      resolve?.();
    },
  });
  try {
    const writeAndSettle = async (): Promise<void> => {
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      await opened.prisma.write(noopWrite);
      await settled;
    };

    await writeAndSettle();
    const first = opened.prisma.readWalProbeHealth();
    assert.equal(first.anomalies, 1);
    assert.equal(first.lastAnomalyReason, WalProbeAnomalyReason.MalformedRow);

    // The probe recovers. The second window saw a clean attempt and nothing else.
    frames = 0;
    clock += WAL_TRUNCATE_INTERVAL_MS;
    await writeAndSettle();
    const second = opened.prisma.readWalProbeHealth();
    assert.equal(second.probes, 1);
    assert.equal(second.anomalies, 0);
    // A recovered window must not ship a stale reason to telemetry either.
    assert.equal(second.lastAnomalyReason, null);

    // And that second window classifies as a CLEAN store, which is what lets the
    // recovered transition fire.
    const diagnostics = await runWithHealth(second);
    assert.equal(diagnostics.healthy, true);
    assert.deepEqual(
      diagnostics.issues.filter((issue) => issue.check === "wal_frame_probe"),
      []
    );
  } finally {
    await opened.close();
  }
});

test("a MALFORMED health payload from the db host omits the check from checksRun", async () => {
  // The read crosses the dynamic db-host method proxy, so a version-skewed host
  // can resolve null or a shape this build cannot act on. Recording the check as
  // run before validating would report a clean WAL check that never happened.
  const logged: string[] = [];
  for (const malformed of [
    null,
    undefined,
    { measurable: true },
    {
      measurable: true,
      probes: 1,
      anomalies: 1,
      lastAnomalyReason: "../../etc",
    },
  ]) {
    const diagnostics = await createStoreIntegrityProbe(
      walHealthReader(() =>
        Promise.resolve(malformed as unknown as WalProbeHealth)
      ),
      {
        emit: () => undefined,
        log: (message) => logged.push(message),
      }
    ).runOnce();

    assert.equal(diagnostics.checksRun.includes("wal_frame_probe"), false);
    assert.deepEqual(
      diagnostics.issues.filter((issue) => issue.check === "wal_frame_probe"),
      []
    );
  }
  // Each rejection is logged, so a host that is chronically failing the parse is
  // visible rather than silently absent.
  assert.equal(logged.length, 4);
});
