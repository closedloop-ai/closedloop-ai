/**
 * @file soak-cycle.ts
 * @description One measured soak cycle, as five phases: seed the profile,
 * launch, drain (with optional crash injection), tear down, assemble the
 * record. `runCycle` is only their sequence; each phase is a helper below, so
 * the phase boundaries — and the invariant that the record is built from
 * post-teardown state — stay readable.
 */

import fs from "node:fs";
import path from "node:path";
import { type MockCloudServer, readBackFromCloud } from "./mock-cloud-server";
import {
  establishSoakPageReadPopulation,
  findDbHostPids,
  isAppAlive,
  launchSoakApp,
  probePageRead,
  seedProfile,
  waitForAuthenticated,
  waitForHello,
} from "./soak-app";
import { buildCycleRecord } from "./soak-cycle-record";
import {
  baselineOutboxIds,
  localSessionIds,
  outboxDepths,
  sessionIdsWithEvents,
} from "./soak-db";
import { newPageReadStats } from "./soak-page-read";
import { loadAvg1, loadGate, log, sleep } from "./soak-support";
import type {
  AuthBlobs,
  CycleContext,
  CycleRecord,
  CycleState,
  CycleWorkspace,
  LaunchedSoakApp,
  Mode,
  OutboxDepths,
  SoakOptions,
} from "./soak-types";

const OUTBOX_POLL_MS = 5000;
/**
 * After a dbkill, a fresh db-host holder must appear within this window or the
 * cycle records `db_host_not_restarted_within_60s` — keep the constant and that
 * reason string in step.
 */
const DB_HOST_RECOVERY_DEADLINE_MS = 60_000;
const DB_HOST_RECOVERY_POLL_MS = 2000;
/** Settle time between an appkill SIGKILL and the relaunch. */
const APPKILL_RELAUNCH_SETTLE_MS = 3000;
/** Settle time after the drain loop so in-flight acks land before final reads. */
const FINAL_ACK_SETTLE_MS = 2000;
/** Grace period between `app.close()` and the fallback SIGKILL. */
const APP_CLOSE_GRACE_MS = 1000;
/** How often the drain loop emits a progress line. */
const DRAIN_PROGRESS_LOG_MS = 60_000;

export async function runCycle(
  cycleIndex: number,
  options: SoakOptions,
  mock: MockCloudServer,
  auth: AuthBlobs,
  homes: Record<string, string>
): Promise<CycleRecord> {
  const loadAvgStart = await loadGate(options.loadGateMax);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const workspace = await prepareCycleWorkspace(
    cycleIndex,
    options,
    mock,
    auth
  );
  log(
    `cycle ${cycleIndex} (${options.mode}): baseline outbox=${workspace.startDepths.pending} invocation=${workspace.startDepths.invocationPending} load=${loadAvgStart.toFixed(1)}`
  );

  const context: CycleContext = {
    cycleIndex,
    options,
    mock,
    homes,
    workspace,
    startMs,
  };
  const state = newCycleState(
    await launchSoakApp(
      workspace.userDataDir,
      mock,
      homes,
      workspace.stdioLogPath
    ),
    workspace.startDepths.pending
  );

  await runDrainPhase(context, state);

  // Let in-flight acks land, then read final state.
  await sleep(FINAL_ACK_SETTLE_MS);
  const endDepths = await readFinalDepths(workspace.dbPath, state.notes);
  const readBack = await quiesceThenReadBack(
    () => shutdownSoakApp(state.launched),
    () => readBackFromCloud(mock, state.notes)
  );

  const record = buildCycleRecord(context, state, {
    startedAt,
    loadAvgStart,
    endDepths,
    readBack,
  });
  preserveCycleArtifacts(context);
  fs.rmSync(workspace.userDataDir, { recursive: true, force: true });
  return record;
}

/**
 * Take the cycle's two post-drain cloud observations without racing them.
 *
 * The cycle is scored from a PAIR: the read-back corpus, and `mock.stats()`,
 * which `buildCycleRecord` reads afterwards. Both must describe the same
 * moment. The read-back used to be taken while the app was STILL RUNNING, so a
 * POST landing in the window between them appeared in `syncedSet` but not in
 * the corpus — and the completeness check then failed a perfectly good cycle
 * with `read_back_incomplete`. An oracle that reddens on healthy runs is as
 * useless as one that cannot fail at all.
 *
 * Quiescing the SENDER first removes the window: once the app is down, nothing
 * can POST, so the corpus and the stats cannot disagree. The mock is untouched
 * by the shutdown and the profile is deleted later, so the read-back is still
 * taken inside the cycle and a failure is still attributable to it.
 */
export async function quiesceThenReadBack<T>(
  quiesce: () => Promise<void>,
  readBack: () => Promise<T>
): Promise<T> {
  await quiesce();
  return await readBack();
}

/**
 * Phase 1 — seed a throwaway profile from the snapshot clone and read the
 * pre-drain baseline off it. No app is running yet, so every read here is of
 * the untouched clone.
 */
async function prepareCycleWorkspace(
  cycleIndex: number,
  options: SoakOptions,
  mock: MockCloudServer,
  auth: AuthBlobs
): Promise<CycleWorkspace> {
  const userDataDir = path.join(options.workRoot, `cycle-${cycleIndex}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  mock.resetStats();
  seedProfile(userDataDir, options.snapshot, mock, auth);
  const dbPath = path.join(userDataDir, "agent-dashboard.sqlite");
  // Created before the launch so the app's output streams straight to disk from
  // its first byte — the artifact must outlive the profile AND be complete.
  const artifactsDir = path.join(options.workRoot, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const stdioLogPath = path.join(
    artifactsDir,
    `cycle-${cycleIndex}-${options.mode}-stdio.log`
  );
  fs.rmSync(stdioLogPath, { force: true });
  const baseline = await baselineOutboxIds(dbPath);
  // ISS-6098 / ISS-6099: the wider local populations the oracle reconciles
  // against. Read here, on the untouched clone before any app runs, so they are
  // a pre-drain fact like the baseline itself.
  const localIds = await localSessionIds(dbPath);
  const withEvents = await sessionIdsWithEvents(dbPath);
  const startDepths = await outboxDepths(dbPath);
  return {
    userDataDir,
    dbPath,
    artifactsDir,
    stdioLogPath,
    baseline,
    localSessionIds: localIds,
    localSessionsWithEvents: withEvents,
    startDepths,
  };
}

function newCycleState(
  launched: LaunchedSoakApp,
  startDepth: number
): CycleState {
  return {
    launched,
    oomHitSets: [launched.oomHits],
    pageReads: newPageReadStats(),
    monotonicViolations: [],
    notes: [],
    failReasons: [],
    dbHostKills: 0,
    dbHostRecovered: null,
    appKills: 0,
    appRelaunched: null,
    unexpectedAppExit: false,
    drainCompleted: false,
    lastDepth: startDepth,
  };
}

/**
 * Phase 2+3 — wait for the app to reach the cloud, then poll the drain to
 * completion. Anything thrown by either step is recorded as `harness_error` and
 * swallowed, so a cycle that fails to instrument still yields a measurable
 * record instead of aborting the battery.
 */
async function runDrainPhase(
  context: CycleContext,
  state: CycleState
): Promise<void> {
  try {
    await waitForAuthenticated(state.launched.page);
    await waitForHello(context.mock);
    state.notes.push("auth+hello ok");
    // ISS-6100: establish the population every later page read is graded
    // against, from an idle read before the drain poll starts. A degenerate
    // establishing read is recorded rather than silently grading against
    // nothing for the rest of the cycle.
    const expectedTotal = await establishSoakPageReadPopulation(
      state.launched.page,
      state.pageReads
    );
    if (expectedTotal === null) {
      state.failReasons.push("page_read_population_not_established");
    } else {
      state.notes.push(`page-read population established at ${expectedTotal}`);
    }
    await pollDrainToCompletion(context, state);
  } catch (error) {
    state.failReasons.push(`harness_error: ${String(error).slice(0, 300)}`);
    // The message alone cost a whole diagnosis pass on cycle 1; keep the frame.
    state.notes.push(
      `harness_error stack: ${(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1200)}`
    );
  }
}

/**
 * The drain poll loop. Exits on: outbox empty (`drainCompleted`), the app dying
 * when no kill was injected, or the drain budget expiring — each of which is a
 * distinct recorded outcome, never a silent stop.
 */
async function pollDrainToCompletion(
  context: CycleContext,
  state: CycleState
): Promise<void> {
  const { options, workspace, startMs } = context;
  const injectAtDepth = planInjectionDepth(
    options.mode,
    workspace.startDepths.pending
  );
  let injected = false;
  const budgetDeadline = startMs + options.drainBudgetMs;
  let lastProgressLogMs = Date.now();

  for (;;) {
    await sleep(OUTBOX_POLL_MS);
    if (Date.now() - lastProgressLogMs >= DRAIN_PROGRESS_LOG_MS) {
      lastProgressLogMs = Date.now();
      logDrainProgress(context, state);
    }

    const depths = await readDepthsOrNote(workspace.dbPath, state.notes);
    if (!depths) {
      if (Date.now() > budgetDeadline) {
        state.failReasons.push("drain_budget_exceeded");
        break;
      }
      continue;
    }

    const alive = await sampleDrainState(context, state, depths);
    if (!alive) {
      break;
    }

    if (!injected && injectAtDepth >= 0 && depths.pending <= injectAtDepth) {
      injected = true;
      await injectCrash(context, state, depths.pending);
    }

    if (depths.pending === 0) {
      state.drainCompleted = true;
      break;
    }
    if (Date.now() > budgetDeadline) {
      state.failReasons.push("drain_budget_exceeded");
      break;
    }
  }
}

/**
 * Injection planning: fire once somewhere in the middle of the drain. `-1`
 * means never, which is what keeps `clean` cycles injection-free.
 */
function planInjectionDepth(mode: Mode, startDepth: number): number {
  if (mode === "clean") {
    return -1;
  }
  return Math.floor(startDepth * (0.25 + Math.random() * 0.5));
}

/**
 * One poll sample: checks liveness, records the depth against the monotonic
 * invariant, and — while the app is alive — takes a page-read sample.
 *
 * Returns false for a dead app, in EVERY mode, which is the caller's signal to
 * stop the loop; the fail reason is already recorded by then. The intentional
 * appkill gap is never visible here: `injectAppKill` runs after this sampler
 * within the same loop iteration and awaits the replacement app's launch and
 * authentication before returning, so `state.launched` is always the live
 * handle by the next sample. A dead process observed here is therefore either a
 * pre-injection death or the RELAUNCHED app exiting — both unexpected, and
 * exempting appkill mode let the second one pass as a recovered cycle.
 */
export async function sampleDrainState(
  context: CycleContext,
  state: CycleState,
  depths: OutboxDepths
): Promise<boolean> {
  if (!isAppAlive(state.launched)) {
    state.unexpectedAppExit = true;
    state.failReasons.push("app_exited_unexpectedly");
    return false;
  }
  if (depths.pending > state.lastDepth) {
    state.monotonicViolations.push({
      atMs: Date.now() - context.startMs,
      from: state.lastDepth,
      to: depths.pending,
    });
  }
  state.lastDepth = depths.pending;

  await probePageRead(state.launched.page, state.pageReads);
  return true;
}

function logDrainProgress(context: CycleContext, state: CycleState): void {
  const stats = context.mock.stats();
  log(
    `cycle ${context.cycleIndex}: depth=${state.lastDepth} synced=${stats.syncedSessionIds.length} raw=${stats.rawSessionReceives} reads(ok=${state.pageReads.ok} err=${state.pageReads.errors} to=${state.pageReads.timeouts}) load=${loadAvg1().toFixed(1)}`
  );
}

/**
 * A failed outbox poll is transient by assumption (the db-host may be mid
 * restart), so it is noted and retried rather than ending the cycle. The caller
 * owns the budget check that turns repeated failure into an exit.
 */
async function readDepthsOrNote(
  dbPath: string,
  notes: string[]
): Promise<OutboxDepths | null> {
  try {
    return await outboxDepths(dbPath);
  } catch (error) {
    notes.push(`outbox poll failed: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/** Mid-drain crash injection; a no-op in `clean` mode, which never calls it. */
async function injectCrash(
  context: CycleContext,
  state: CycleState,
  depthAtInjection: number
): Promise<void> {
  if (context.options.mode === "dbkill") {
    await injectDbHostKill(context, state, depthAtInjection);
    return;
  }
  if (context.options.mode === "appkill") {
    await injectAppKill(context, state, depthAtInjection);
  }
}

/** ISS-5715: the supervisor must bring a fresh db-host back on its own. */
async function injectDbHostKill(
  context: CycleContext,
  state: CycleState,
  depthAtInjection: number
): Promise<void> {
  const appPid = state.launched.child.pid;
  const pids = findDbHostPids(context.workspace.userDataDir, appPid);
  if (pids.length === 0) {
    state.notes.push("dbkill: no db-host pid found at injection point");
    state.failReasons.push("dbkill_target_not_found");
    return;
  }
  for (const pid of pids) {
    process.kill(pid, "SIGKILL");
  }
  state.dbHostKills += pids.length;
  log(
    `cycle ${context.cycleIndex}: SIGKILLed db-host pid(s) ${pids.join(",")} at depth ${depthAtInjection}`
  );
  // Set false before the wait so a throw mid-recovery records a FAILED recovery
  // rather than an unknown one.
  state.dbHostRecovered = false;
  state.dbHostRecovered = await waitForDbHostRestart(
    context.workspace.userDataDir,
    appPid,
    pids
  );
  if (!state.dbHostRecovered) {
    state.failReasons.push("db_host_not_restarted_within_60s");
  }
}

/** True once a db-host holder that is NOT one of the killed pids appears. */
async function waitForDbHostRestart(
  userDataDir: string,
  appPid: number | undefined,
  killedPids: number[]
): Promise<boolean> {
  const recoveryDeadline = Date.now() + DB_HOST_RECOVERY_DEADLINE_MS;
  while (Date.now() < recoveryDeadline) {
    await sleep(DB_HOST_RECOVERY_POLL_MS);
    const fresh = findDbHostPids(userDataDir, appPid).filter(
      (pid) => !killedPids.includes(pid)
    );
    if (fresh.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * SIGKILL the whole app and relaunch against the SAME profile, exercising the
 * boot-recovery path. `appRelaunched` is set false before the relaunch so a
 * throw from the relaunch or its auth wait is recorded as a failed recovery
 * rather than an unknown one.
 */
async function injectAppKill(
  context: CycleContext,
  state: CycleState,
  depthAtInjection: number
): Promise<void> {
  const pid = state.launched.child.pid;
  log(
    `cycle ${context.cycleIndex}: SIGKILLing whole app pid ${pid} at depth ${depthAtInjection}`
  );
  if (pid) {
    process.kill(pid, "SIGKILL");
  }
  state.appKills += 1;
  await sleep(APPKILL_RELAUNCH_SETTLE_MS);
  state.appRelaunched = false;
  state.launched = await launchSoakApp(
    context.workspace.userDataDir,
    context.mock,
    context.homes,
    context.workspace.stdioLogPath
  );
  state.oomHitSets.push(state.launched.oomHits);
  await waitForAuthenticated(state.launched.page);
  state.appRelaunched = true;
  state.notes.push("app relaunched after SIGKILL");
}

/** Sentinel depths (-1) mark a final read the harness could not take. */
async function readFinalDepths(
  dbPath: string,
  notes: string[]
): Promise<OutboxDepths> {
  try {
    return await outboxDepths(dbPath);
  } catch (error) {
    notes.push(`final outbox read failed: ${String(error).slice(0, 200)}`);
    return { pending: -1, deadLettered: -1, invocationPending: -1 };
  }
}

/** Phase 4 — close the app, then SIGKILL whatever ignored the close. */
async function shutdownSoakApp(launched: LaunchedSoakApp): Promise<void> {
  try {
    const child = launched.child;
    await launched.app.close().catch(() => undefined);
    await sleep(APP_CLOSE_GRACE_MS);
    if (child.exitCode === null && child.pid) {
      process.kill(child.pid, "SIGKILL");
    }
  } catch {
    // already dead
  }
}

/**
 * Preserve the app's own log (failure signatures live there) before the 2 GB
 * profile is deleted. The stdio log needs no copy — it was streamed to the
 * artifacts dir in full while the cycle ran.
 */
function preserveCycleArtifacts(context: CycleContext): void {
  const { workspace, cycleIndex, options } = context;
  const mainLog = path.join(workspace.userDataDir, "logs", "main.log");
  if (fs.existsSync(mainLog)) {
    fs.copyFileSync(
      mainLog,
      path.join(
        workspace.artifactsDir,
        `cycle-${cycleIndex}-${options.mode}-main.log`
      )
    );
  }
}
