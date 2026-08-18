/**
 * ISS-4430 — the DESKTOP BOOT-IMPORT profiling workload.
 *
 * Measures the first-launch experience: an app with transcripts on disk and an
 * EMPTY local store, from launch until the Sessions list stops growing. It is a
 * RUNNER, not a CI test.
 *
 * Two isolation guarantees, both asserted before the app starts:
 *
 *   1. Every collector's home is remapped into paths this run owns.
 *      `launchDesktopApp` inherits the operator's environment, and every
 *      harness collector resolves its home from `os.homedir()` unless told
 *      otherwise — so without an explicit override this workload would import
 *      the operator's LIVE Claude/Codex/Copilot/Cursor/OpenCode transcripts,
 *      producing a number that describes their machine rather than the dataset.
 *   2. The app launches against a fresh user-data directory inside the run
 *      folder, never the dataset sandbox. The sandbox's snapshot is already
 *      populated (the prep CLI always writes one), and a boot import against a
 *      populated store measures nothing; putting the fresh profile in the run
 *      directory also leaves the operator's dataset byte-identical afterwards.
 *
 * Completion is detected on the session count read straight from the local
 * store, not from the rendered list — see {@link measureImportCompletion} for
 * why the UI's page-granular numbers could declare a still-working import done.
 *
 * Contract with the rest of the system:
 *   - `CLOSEDLOOP_PROFILE_DIR` (absolute) — the run directory. This spec writes
 *     `manifest.json`, `workload-marks.jsonl` (the measured steps —
 *     `boot-to-sessions` and `import-completion`), and `import-progress.jsonl`
 *     (the per-poll count curve behind that number, unregistered so the report
 *     never aggregates it) into it, and passes it to the app so the env-gated
 *     instrumentation turns on.
 *   - `CLOSEDLOOP_DESKTOP_USER_DATA_DIR` (absolute) — a sandbox built with
 *     `node apps/desktop/scripts/perf-prepare-dataset.mjs --with-transcripts <n>`.
 *     Transcripts are read from it; nothing is written back to it.
 *
 * Prerequisites:
 *   - `pnpm -C apps/desktop build`
 *   - a `--with-transcripts` dataset
 * Run:
 *   npx playwright test --config playwright.perf.config.ts \
 *     test/perf/import-workload.perf.ts
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_BOOT_IMPORT_WATCHDOG_MS } from "../../src/main/collectors/engine/boot-import-watchdog";
import {
  ProfilingArtifactFile,
  ProfilingEnvVar,
} from "../../src/shared/profiling";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
} from "../e2e/helpers/desktop-app";
import {
  appendJsonlRow,
  appendMark,
  assertCollectorHomesIsolated,
  closeAppForProfileWrite,
  DESKTOP_DB_FILE_NAME,
  DESKTOP_SETTINGS_FILE_NAME,
  DESKTOP_USER_DATA_DIR_ENV,
  PerfLane,
  requireAbsoluteDirEnv,
  resolveCollectorHomes,
  TIMEOUT_STEP_SUFFIX,
  WORKLOAD_MARKS_FILE_NAME,
  writeRunManifest,
} from "./helpers/perf-run";

/** The completion step this lane records into `workload-marks.jsonl`. */
const IMPORT_COMPLETION_STEP = "import-completion";

/**
 * The per-poll count curve.
 *
 * Deliberately NOT `workload-marks.jsonl`. That file is registered in
 * `PERF_LANE_ARTIFACTS` and every distinct `step` key in it is judged against
 * `ImportCompletionMax`, so per-poll step names would fan a single slow import
 * out into one finding per poll — dozens of rows all restating what
 * `import-completion` already says. Progress is EVIDENCE, not a threshold
 * subject: this file is unregistered, the report never reads it, and a human
 * reads it for the curve behind the completion number.
 */
const IMPORT_PROGRESS_FILE_NAME = "import-progress.jsonl";

/** What the dataset CLI's `--with-transcripts` mode produces. */
const SANDBOX_CLAUDE_PROJECTS_PATH = path.join("claude", "projects");

/** The fresh, empty profile the app boots against, under the run directory. */
const IMPORT_USER_DATA_DIR_NAME = "import-userdata";

/**
 * Sampling cadence for the progress read. This is a measurement interval, not a
 * sleep standing in for a wait: the quantity being measured is how long the
 * population takes to stop growing, so it has to be sampled over time.
 */
const IMPORT_POLL_INTERVAL_MS = 5000;

/** Consecutive identical counts that count as "the import has settled". */
const IMPORT_STABLE_POLL_COUNT = 3;

/** Bound for the one post-launch UI check. */
const BOOT_WAIT_MS = 120_000;

/**
 * The app's own bound on a first-launch import. Imported rather than restated so
 * this workload can never outlive, or give up before, the lifecycle it measures.
 */
const IMPORT_WATCHDOG_MS = DEFAULT_BOOT_IMPORT_WATCHDOG_MS;

/** Watchdog plus room for launch, the final poll, and the profile write. */
const WORKLOAD_TIMEOUT_MS = IMPORT_WATCHDOG_MS + 10 * 60_000;

const SESSIONS_NAV_ID = "sessions";
const SESSIONS_NAV_LABEL = "Sessions";

/** The launch step recorded alongside `import-completion`. */
const BOOT_TO_SESSIONS_STEP = "boot-to-sessions";

/** A run of consecutive polls that all read the same session count. */
type StableWindow = {
  count: number;
  /** Elapsed-since-launch of the FIRST sample in the run. */
  startedAtMs: number;
  samples: number;
};

test("desktop boot-import workload", async () => {
  test.setTimeout(WORKLOAD_TIMEOUT_MS);

  const runDir = requireAbsoluteDirEnv(
    ProfilingEnvVar.Dir,
    "Set it to the run directory, e.g. .perf/runs/<utc-stamp>-desktop-import/ (the `just profile-desktop-import` target creates and exports it)."
  );
  const sandboxDir = requireAbsoluteDirEnv(
    DESKTOP_USER_DATA_DIR_ENV,
    "Set it to a sandbox built by `node apps/desktop/scripts/perf-prepare-dataset.mjs --with-transcripts <n>`."
  );
  requireSandboxTranscripts(sandboxDir);

  fs.mkdirSync(runDir, { recursive: true });
  writeRunManifest(runDir, PerfLane.DesktopImport);

  // Transcripts come from the sandbox where the dataset CLI put them; every
  // other collector resolves to an empty directory under the run folder.
  const collectorHomes = resolveCollectorHomes({
    runDir,
    transcriptSourceDir: sandboxDir,
  });
  assertCollectorHomesIsolated(collectorHomes, [sandboxDir, runDir]);

  const userDataDir = createEmptyImportProfile(sandboxDir, runDir);

  const launchedAt = performance.now();
  const launched = await launchDesktopApp({
    userDataDir,
    // The profile is the run's own evidence of what got imported; keep it
    // beside the artifacts instead of deleting it on teardown.
    keepUserDataDir: true,
    env: { ...collectorHomes, [ProfilingEnvVar.Dir]: runDir },
  });

  try {
    await waitForSessionsSurface(launched.page, runDir, launchedAt);
    await measureImportCompletion(launched.page, runDir, launchedAt);
  } finally {
    await closeAppForProfileWrite(launched);
  }

  assertCaptureArtifacts(runDir);
});

/**
 * Poll the local store until the session count stops changing, recording each
 * sample, then record when that steady state BEGAN.
 *
 * Why the count is read from SQLite and not from the rendered list: the desktop
 * Sessions view exposes no precise total. It passes no `readout` to
 * `TablePaginationFooter` — deliberately, because the list "has no settled total
 * it could state honestly" (`SessionsView.tsx`) — so the only numbers the UI
 * offers are the current page's row count, which saturates at the page size of
 * 25, and the highest page number in the pagination window. That makes UI
 * polling PAGE-granular: three identical samples five seconds apart prove only
 * that no page BOUNDARY was crossed in ten seconds, which an importer adding
 * twenty rows a minute satisfies while still working. It would have declared
 * such an import complete early and understated the very number this lane
 * exists to measure. `SELECT COUNT(*) FROM sessions` is row-granular and is the
 * same count the app's own pagination total uses (`session-count.ts`).
 *
 * Stability — not an "import finished" event — remains the signal on purpose:
 * the boot-import lifecycle can also end in its own degraded *timed out* state
 * while collectors keep filling the store in the background, and this workload
 * wants the time until the population stops changing either way.
 */
async function measureImportCompletion(
  page: Page,
  runDir: string,
  launchedAt: number
): Promise<void> {
  const dbPath = path.join(
    runDir,
    IMPORT_USER_DATA_DIR_NAME,
    DESKTOP_DB_FILE_NAME
  );
  let window: StableWindow | null = null;
  let pollIndex = 0;

  while (performance.now() - launchedAt < IMPORT_WATCHDOG_MS) {
    pollIndex += 1;
    const sessions = readSessionCount(dbPath);
    const elapsedMs = performance.now() - launchedAt;
    appendJsonlRow(runDir, IMPORT_PROGRESS_FILE_NAME, {
      poll: pollIndex,
      elapsedMs,
      sessions,
      ts: Date.now(),
    });
    console.info(
      `[perf] poll ${pollIndex} @ ${Math.round(elapsedMs)}ms — ${sessions ?? "db unavailable"} sessions`
    );

    window = advanceStableWindow(window, sessions, elapsedMs);

    if (window && window.samples >= IMPORT_STABLE_POLL_COUNT) {
      // The FIRST sample of the stable window, not this one: the two later polls
      // only CONFIRM a steady state that already existed, so charging their
      // detection delay to the import would overstate it by up to two intervals.
      appendMark(runDir, IMPORT_COMPLETION_STEP, window.startedAtMs);
      console.info(
        `[perf] import settled at ${Math.round(window.startedAtMs)}ms with ${window.count} sessions.`
      );
      return;
    }

    await page.waitForTimeout(IMPORT_POLL_INTERVAL_MS);
  }

  // The population never settled inside the app's own bound. Record the elapsed
  // time under the timeout name rather than a completion the run did not see.
  appendMark(
    runDir,
    `${IMPORT_COMPLETION_STEP}${TIMEOUT_STEP_SUFFIX}`,
    performance.now() - launchedAt
  );
  console.warn(
    `[perf] the session count was still changing after ${IMPORT_WATCHDOG_MS}ms (the app's own boot-import bound).`
  );
}

/**
 * Extend the current run of identical counts, or start a new one.
 *
 * A `null` count (the store not created yet, or momentarily unreadable) breaks
 * the run rather than extending it — "unknown" is not evidence of steadiness.
 * So does a count of zero: this lane requires a `--with-transcripts` dataset, so
 * three zeroes mean the importer has not produced anything yet, and treating
 * that as completion would report an import that imported nothing.
 */
function advanceStableWindow(
  current: StableWindow | null,
  count: number | null,
  elapsedMs: number
): StableWindow | null {
  if (count === null || count === 0) {
    return null;
  }
  if (current && current.count === count) {
    return { ...current, samples: current.samples + 1 };
  }
  return { count, startedAtMs: elapsedMs, samples: 1 };
}

/**
 * Row count of the desktop store's `sessions` table, or `null` when it cannot be
 * read yet.
 *
 * Opened READ-ONLY and closed every poll, so the importer's own writer
 * connection is never contended for and nothing this workload does can alter
 * what it is measuring. Reading a WAL database mid-write is exactly what WAL is
 * for — the reader sees the last committed snapshot.
 *
 * Every failure returns `null` rather than throwing: for the first seconds of a
 * first launch the file genuinely does not exist yet, and a measurement harness
 * must not turn "not yet" into a crashed run.
 */
function readSessionCount(dbPath: string): number | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    const count = row?.count;
    // node:sqlite can surface a COUNT as a bigint.
    if (typeof count === "number" || typeof count === "bigint") {
      return Number(count);
    }
    return null;
  } catch {
    // Table not created yet, or a transient lock/IO error. Both are "unknown".
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Drive the renderer to the Sessions surface once, and record how long the app
 * took to get there.
 *
 * Two jobs. It proves the app is genuinely alive before the measurement loop
 * starts reading a database — otherwise a renderer that crashed at boot would
 * still produce a plausible-looking import curve from whatever the main process
 * managed to write. And it puts the launch cost in `workload-marks.jsonl` beside
 * `import-completion`, where the report can see it, since a slow first paint is
 * part of the first-launch experience this lane exists to characterize.
 */
async function waitForSessionsSurface(
  page: Page,
  runDir: string,
  launchedAt: number
): Promise<void> {
  await dismissDesktopOnboardingOverlay(page);
  await gotoNav(page, SESSIONS_NAV_ID);
  await expect(
    page.locator("header").getByText(SESSIONS_NAV_LABEL, { exact: true })
  ).toBeVisible({ timeout: BOOT_WAIT_MS });
  appendMark(runDir, BOOT_TO_SESSIONS_STEP, performance.now() - launchedAt);
}

/**
 * A fresh, EMPTY user-data directory carrying only the sandbox's sanitized
 * settings (cloud sync off, credentials already stripped by the dataset CLI), so
 * the boot import starts from nothing and still cannot phone home.
 */
function createEmptyImportProfile(sandboxDir: string, runDir: string): string {
  const userDataDir = path.join(runDir, IMPORT_USER_DATA_DIR_NAME);
  if (fs.existsSync(userDataDir)) {
    // A re-run of the same run directory must measure a first launch, not a
    // resume against the previous attempt's store.
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  const sandboxSettings = path.join(sandboxDir, DESKTOP_SETTINGS_FILE_NAME);
  if (fs.existsSync(sandboxSettings)) {
    fs.copyFileSync(
      sandboxSettings,
      path.join(userDataDir, DESKTOP_SETTINGS_FILE_NAME)
    );
  }
  return userDataDir;
}

/**
 * The import lane's capture smoke check. The db-host profile and the per-op
 * timings are the two artifacts that describe an import — a main-process profile
 * is captured too, but this lane's findings do not rest on it.
 */
function assertCaptureArtifacts(runDir: string): void {
  const marksPath = path.join(runDir, WORKLOAD_MARKS_FILE_NAME);
  expect(
    fs.existsSync(marksPath),
    `${WORKLOAD_MARKS_FILE_NAME} should have been written to ${runDir}`
  ).toBe(true);

  for (const fileName of [
    ProfilingArtifactFile.DbHostCpuProfile,
    ProfilingArtifactFile.DbOps,
  ]) {
    const filePath = path.join(runDir, fileName);
    expect(
      fs.existsSync(filePath),
      `${fileName} missing from ${runDir} — the profiling instrumentation did not run. Confirm ${ProfilingEnvVar.Dir} reached the app.`
    ).toBe(true);
    expect(
      fs.statSync(filePath).size,
      `${fileName} is empty — capture started but never flushed.`
    ).toBeGreaterThan(0);
  }
}

function requireSandboxTranscripts(sandboxDir: string): void {
  const projectsDir = path.join(sandboxDir, SANDBOX_CLAUDE_PROJECTS_PATH);
  if (!fs.existsSync(projectsDir)) {
    throw new Error(
      `No transcripts at ${projectsDir}. The import lane needs a dataset built with ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs --with-transcripts <n>`; " +
        "a sandbox without transcripts has nothing to import."
    );
  }
}
