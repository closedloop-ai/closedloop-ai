/**
 * @file soak-runner.ts
 * @description Stage-0 soak-and-crash harness for the desktop→cloud sync
 * pipeline, run against a CLONE of a real 2.1 GB production database snapshot
 * (2,938 pending session-outbox rows). Launches the REAL built Electron app
 * (dist/main/index.js) against an isolated profile, mocks the cloud at the
 * HTTP/socket boundary only (see mock-cloud-server.ts), and measures per-cycle
 * invariants:
 *
 *   1. no-OOM        — no heap-death signatures in captured output; app alive.
 *   2. monotonic     — session-outbox depth never increases between samples and
 *                      reaches 0 within the drain budget.
 *   3. no-dup/no-loss — cloud-received (deduped, chunk-assembled) session-id
 *                      set covers the baseline outbox set exactly once; raw
 *                      receive counts are recorded so re-send waste is
 *                      measured, not hidden. Membership is asserted against
 *                      baseline ∪ local corpus (ISS-6098): backfill enumerates
 *                      sessions independently of the outbox by design, so a
 *                      delivered id outside the baseline but present locally is
 *                      expected; one present in NEITHER is still a fail.
 *   4. reads-answer  — the production Sessions page-data IPC
 *                      (window.desktopApi.agentSessionsApi.pageData) answers
 *                      within a deadline throughout the drain, AND answers with
 *                      real content: a zero-row list, or a total below the
 *                      population established at cycle start, is a failure
 *                      rather than an `ok` (ISS-6100). This is the DESKTOP's
 *                      LOCAL read — evidence about local read responsiveness
 *                      during sync, not about the cloud.
 *   5. content-intact / read-back-complete (ISS-6099) — the CONTENT of every
 *                      delivered payload is retained (bounded: counts + digests,
 *                      never the 2.1 GB corpus), chunk sequences are asserted
 *                      post-reassembly rather than by arrival count, a session
 *                      the local DB says has events must not arrive with zero,
 *                      and the cloud is asked at end of cycle to return
 *                      everything it was given. Before this the whole battery
 *                      measured correctly-identified ENVELOPES arriving.
 *
 * Modes: clean (no injection), dbkill (one random mid-drain SIGKILL of the
 * db-host utility process per cycle — ISS-5715 supervisor must recover),
 * appkill (one random mid-drain SIGKILL of the whole app + relaunch against
 * the same profile — boot-recovery path).
 *
 * NOT a Playwright spec on purpose: cycles run far beyond spec timeouts and
 * need process-level control. Run with:
 *
 *   pnpm -C apps/desktop exec tsx test/soak/soak-runner.ts \
 *     --cycles 10 --mode clean --out /tmp/soak-clean.jsonl
 *
 * The app must be built first (`pnpm -C apps/desktop prebuild && pnpm -C
 * apps/desktop build`). Never point this at a live profile: the snapshot path
 * is cloned per cycle with APFS clonefile (`cp -c`) and deleted afterwards.
 *
 * This module is the CLI and the battery loop only. The cycle itself lives in
 * soak-cycle.ts (phases) and soak-cycle-record.ts (scoring); the Electron
 * lifecycle in soak-app.ts; read-only SQLite probes in soak-db.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { isolatedHarnessHomes } from "../helpers/isolated-harness-homes";
import { startMockCloudServer } from "./mock-cloud-server";
import { bootstrapAuthBlobs, MAIN_JS } from "./soak-app";
import { runCycle } from "./soak-cycle";
import { log } from "./soak-support";
import type { Mode, SoakOptions } from "./soak-types";

/** The compute target id baked into the snapshot's outbox sourceKey. */
const SNAPSHOT_COMPUTE_TARGET_ID = "019d271f-12d1-73ae-924b-479c5f3f2395";
const DEFAULT_SNAPSHOT = "/private/tmp/cl-goal/agent-dashboard.baseline.sqlite";
const DEFAULT_DRAIN_BUDGET_MS = 40 * 60_000;
/**
 * Cycle-start load gate. Default 25 per the Stage-0 brief; overridable via
 * --load-gate because sibling agent lanes can hold the box above 25 for hours,
 * starving the battery entirely. Every cycle records loadAvgStart/End in its
 * JSONL row, so high-load cycles are always identifiable — crash-recovery
 * pass/fail is load-robust, but discount sessions/min from gated-up cycles.
 */
const DEFAULT_LOAD_GATE_MAX = 25;

function parseArgs(): SoakOptions {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const mode = (get("--mode") ?? "clean") as Mode;
  if (!["clean", "dbkill", "appkill"].includes(mode)) {
    throw new Error(`invalid --mode ${mode}`);
  }
  return {
    cycles: Number(get("--cycles") ?? "1"),
    mode,
    out: get("--out") ?? `/private/tmp/cl-goal/soak-${mode}.jsonl`,
    snapshot: get("--snapshot") ?? DEFAULT_SNAPSHOT,
    drainBudgetMs:
      Number(get("--drain-budget-min") ?? "0") * 60_000 ||
      DEFAULT_DRAIN_BUDGET_MS,
    workRoot: get("--work-root") ?? "/private/tmp/cl-goal/soak-work",
    loadGateMax: Number(get("--load-gate") ?? "0") || DEFAULT_LOAD_GATE_MAX,
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(
      `built app missing at ${MAIN_JS} — run prebuild+build first`
    );
  }
  if (!fs.existsSync(options.snapshot)) {
    throw new Error(`snapshot missing at ${options.snapshot}`);
  }
  fs.mkdirSync(options.workRoot, { recursive: true });
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  const homes = isolatedHarnessHomes(path.join(options.workRoot, "homes"));
  const mock = await startMockCloudServer({
    computeTargetId: SNAPSHOT_COMPUTE_TARGET_ID,
  });
  log(
    `mock cloud up: api=${mock.apiOrigin} relay=${mock.relayOrigin} target=${SNAPSHOT_COMPUTE_TARGET_ID}`
  );
  let failedCycles = 0;
  try {
    const auth = await bootstrapAuthBlobs(options.workRoot, homes);
    for (let cycle = 1; cycle <= options.cycles; cycle++) {
      const record = await runCycle(cycle, options, mock, auth, homes);
      fs.appendFileSync(options.out, `${JSON.stringify(record)}\n`, "utf8");
      const verdict = record.failReasons.length === 0 ? "PASS" : "FAIL";
      if (verdict === "FAIL") {
        failedCycles += 1;
      }
      log(
        `cycle ${cycle}/${options.cycles} ${verdict} drain=${record.drainCompleted} synced=${record.syncedSessionCount}/${record.baselineSessionCount} content=${record.content.deliveredSessions} readback=${record.content.readBackSessions} dur=${Math.round(record.durationMs / 1000)}s reasons=[${record.failReasons.join("; ")}]`
      );
    }
  } finally {
    await mock.close().catch(() => undefined);
  }
  reportBatteryVerdict(options.cycles, failedCycles);
}

/**
 * The battery's exit status. The whole battery always runs — a failed cycle
 * never short-circuits the remaining ones, because the point of a soak is the
 * distribution across cycles — but a battery containing ANY failed cycle exits
 * nonzero so a shell or CI job using this harness as the regression gate sees
 * the failure instead of a clean status 0.
 */
function reportBatteryVerdict(cycles: number, failedCycles: number): void {
  if (failedCycles === 0) {
    log(`battery PASS: ${cycles}/${cycles} cycles recorded no fail reasons`);
    return;
  }
  log(`battery FAIL: ${failedCycles}/${cycles} cycles recorded fail reasons`);
  process.exitCode = 1;
}

main().catch((error) => {
  log(
    `FATAL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  );
  process.exitCode = 1;
});
