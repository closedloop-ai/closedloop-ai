/**
 * ISS-4430 — the DESKTOP BOOT-IMPORT profiling workload.
 *
 * Measures a launch with transcripts on disk, from launch until the Sessions
 * list stops growing. It is a RUNNER, not a CI test.
 *
 * TWO store shapes, selected by {@link IMPORT_STORE_SHAPE_ENV} (ISS-7286).
 * `empty` (the default) is the first-launch experience the lane was built for.
 * `populated` seeds the profile with the sandbox's own snapshot first, because
 * the symptom ISS-6003 reported — per-session imports hitting the app's 120s
 * bound — was seen on a multi-gigabyte POPULATED store, and an empty-store run
 * cannot reproduce or refute it. The two shapes ask different questions of the
 * same importer and share everything else, so they are one runner rather than
 * two copies of the isolation guarantees below.
 *
 * Two isolation guarantees, both asserted before the app starts:
 *
 *   1. Every collector's home is remapped into paths this run owns.
 *      `launchDesktopApp` inherits the operator's environment, and every
 *      harness collector resolves its home from `os.homedir()` unless told
 *      otherwise — so without an explicit override this workload would import
 *      the operator's LIVE Claude/Codex/Copilot/Cursor/OpenCode transcripts,
 *      producing a number that describes their machine rather than the dataset.
 *   2. The app launches against a user-data directory inside the run folder,
 *      never the dataset sandbox itself — so the operator's dataset is
 *      byte-identical afterwards even in the `populated` shape, which COPIES the
 *      sandbox's snapshot into the run directory rather than booting against it.
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
 *   - `CLOSEDLOOP_PERF_IMPORT_STORE` (optional) — `empty` (default) or
 *     `populated`; see the store-shape note above.
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
import { z } from "zod";
import { DEFAULT_BOOT_IMPORT_WATCHDOG_MS } from "../../src/main/collectors/engine/boot-import-watchdog";
import {
  ProfilingArtifactFile,
  ProfilingEnvVar,
} from "../../src/shared/profiling";
import { gotoNav, launchDesktopApp } from "../e2e/helpers/desktop-app";
import {
  BOOT_TO_SESSIONS_STEP,
  IMPORT_COMPLETION_STEP,
  importNeverSettledMessage,
  resolveSettleAtMs,
  surfaceWaitFailureMessage,
} from "./helpers/import-lane";
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

/** The fresh profile the app boots against, under the run directory. */
const IMPORT_USER_DATA_DIR_NAME = "import-userdata";

/** Selects which local-store shape this run measures (ISS-7286). */
const IMPORT_STORE_SHAPE_ENV = "CLOSEDLOOP_PERF_IMPORT_STORE";

/**
 * The two shapes. `Empty` is the first-launch case; `Populated` seeds the
 * sandbox's snapshot so the importer meets a store that already holds most of
 * what the transcripts describe — the shape ISS-6003's symptom was reported on.
 */
const ImportStoreShape = {
  Empty: "empty",
  Populated: "populated",
} as const;
type ImportStoreShape =
  (typeof ImportStoreShape)[keyof typeof ImportStoreShape];

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
 * The interval at which the app re-checks whether its first-launch import is
 * wedged. Imported rather than restated so this workload can never outlive, or
 * give up before, the lifecycle it measures.
 *
 * ISS-8058: this stopped being a DEADLINE the import has to beat. The watchdog
 * now re-arms while sources are still landing, so a healthy import of any size
 * never turns `timedOut` however long it runs. That only widens the degraded
 * case {@link measureImportCompletion} already tolerates — an unobservable
 * terminal flag — and the timeout still names that rather than blaming the
 * importer.
 */
const IMPORT_WATCHDOG_MS = DEFAULT_BOOT_IMPORT_WATCHDOG_MS;

/**
 * How long this lane watches, measured from launch.
 *
 * NOT the same clock as the app's bound, which is why it is not the same number.
 * `BootImportLifecycle` arms its timer when the collector manager STARTS —
 * after Electron boot, runtime init and this lane's surface wait — so a lane
 * bound of exactly {@link IMPORT_WATCHDOG_MS} from launch always expires first
 * and makes the app's `timedOut` unobservable, which is the degraded case
 * {@link measureImportCompletion} says it tolerates. The surface wait is the
 * largest term in that gap and the only one this lane bounds, so it is the
 * slack. That makes this a heuristic, and the run does not have to be right
 * about it: if the lifecycle still never turns terminal the timeout names
 * exactly that rather than blaming the importer.
 */
const IMPORT_OBSERVATION_MS = IMPORT_WATCHDOG_MS + BOOT_WAIT_MS;

/** Observation window plus room for launch, the final poll, and the profile write. */
const WORKLOAD_TIMEOUT_MS = IMPORT_OBSERVATION_MS + 10 * 60_000;

const SESSIONS_NAV_ID = "sessions";
const SESSIONS_NAV_LABEL = "Sessions";

/** The preload bridge this lane reads the boot-import lifecycle through. */
type RuntimeStatusWindow = Window & {
  desktopApi?: { getRuntimeStatus?: () => Promise<unknown> };
};

/**
 * Only the two terminal booleans off `desktop:get-runtime-status`.
 *
 * Validated rather than trusted: the status crosses a process boundary and is
 * `null` until the Agent Dashboard runtime is up, and a hand-rolled property
 * check would read a partially-shaped payload as a settled import. Deliberately
 * NOT the full `DesktopIngestProgressReport` — pinning fields this lane never
 * reads would fail the parse on an additive change to a contract it does not own.
 */
const BOOT_IMPORT_STATUS_SCHEMA = z.object({
  ingest: z.object({ complete: z.boolean(), timedOut: z.boolean() }),
});

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

  const storeShape = resolveImportStoreShape();
  fs.mkdirSync(runDir, { recursive: true });
  writeRunManifest(runDir, PerfLane.DesktopImport, { storeShape });

  // Transcripts come from the sandbox where the dataset CLI put them; every
  // other collector resolves to an empty directory under the run folder.
  const collectorHomes = resolveCollectorHomes({
    runDir,
    transcriptSourceDir: sandboxDir,
  });
  assertCollectorHomesIsolated(collectorHomes, [sandboxDir, runDir]);

  const userDataDir = createImportProfile(sandboxDir, runDir, storeShape);
  console.info(`[perf] measuring the ${storeShape} local-store shape.`);

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
    await measureImportCompletion(
      launched.page,
      runDir,
      launchedAt,
      storeShape
    );
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
 *
 * ISS-7286: stability alone is not SUFFICIENT, though, so the lifecycle gates
 * it. A count that has not moved is ambiguous between "the import finished" and
 * "the import has not started", and the ambiguity is not hypothetical — the
 * first populated-shape run declared completion at 6.9s against an untouched
 * 2,127-row store whose collectors had not yet written anything. The empty shape
 * was only ever protected from the same reading by the count being zero. So a
 * stable window may close only once the app itself reports its boot import
 * ENDED, `complete` or `timedOut`; which of the two it was stays out of the
 * number, exactly as before.
 */
async function measureImportCompletion(
  page: Page,
  runDir: string,
  launchedAt: number,
  storeShape: ImportStoreShape
): Promise<void> {
  const dbPath = path.join(
    runDir,
    IMPORT_USER_DATA_DIR_NAME,
    DESKTOP_DB_FILE_NAME
  );
  let window: StableWindow | null = null;
  let pollIndex = 0;
  let previousCount: number | null = null;
  let firstCountChangeAtMs: number | null = null;
  let bootImportEnded = false;

  while (performance.now() - launchedAt < IMPORT_OBSERVATION_MS) {
    pollIndex += 1;
    const sessions = readSessionCount(dbPath);
    bootImportEnded = await hasBootImportEnded(page);
    const elapsedMs = performance.now() - launchedAt;
    appendJsonlRow(runDir, IMPORT_PROGRESS_FILE_NAME, {
      poll: pollIndex,
      elapsedMs,
      sessions,
      bootImportEnded,
      storeShape,
      ts: Date.now(),
    });
    console.info(
      `[perf] poll ${pollIndex} @ ${Math.round(elapsedMs)}ms — ${sessions ?? "db unavailable"} sessions, boot import ${bootImportEnded ? "ended" : "running"}`
    );

    if (
      firstCountChangeAtMs === null &&
      previousCount !== null &&
      sessions !== null &&
      sessions !== previousCount
    ) {
      firstCountChangeAtMs = elapsedMs;
    }
    previousCount = sessions ?? previousCount;
    window = advanceStableWindow(window, sessions, elapsedMs);

    if (
      window &&
      window.samples >= IMPORT_STABLE_POLL_COUNT &&
      bootImportEnded
    ) {
      // The window's FIRST sample, not this one: the two later polls only
      // CONFIRM a steady state that already existed, so charging their detection
      // delay to the import would overstate it by up to two intervals. What
      // `resolveSettleAtMs` guards is the opposite error — a window that was
      // already open before the count ever moved.
      const settledAtMs = resolveSettleAtMs({
        stableWindowStartedAtMs: window.startedAtMs,
        firstCountChangeAtMs,
        observedAtMs: elapsedMs,
      });
      appendMark(runDir, IMPORT_COMPLETION_STEP, settledAtMs);
      console.info(
        `[perf] import settled at ${Math.round(settledAtMs)}ms with ${window.count} sessions${firstCountChangeAtMs === null ? " (the count never moved; timed from the app's own boot-import end)" : ""}.`
      );
      return;
    }

    await page.waitForTimeout(IMPORT_POLL_INTERVAL_MS);
  }

  // The loop gave up. Record the elapsed time under the timeout name rather than
  // a completion the run did not see.
  const observedMs = performance.now() - launchedAt;
  appendMark(
    runDir,
    `${IMPORT_COMPLETION_STEP}${TIMEOUT_STEP_SUFFIX}`,
    observedMs
  );
  console.warn(
    `[perf] ${importNeverSettledMessage({
      observedMs,
      countStillChanging: !(
        window && window.samples >= IMPORT_STABLE_POLL_COUNT
      ),
      bootImportEnded,
    })}`
  );
}

/**
 * The app's own boot-import lifecycle, read through the same IPC the renderer's
 * import splash reads (`desktop:get-runtime-status` → `ingest`).
 *
 * ENDED means terminal either way: `complete` (every harness settled) or
 * `timedOut` (the watchdog gave up on a wedged harness). Both are answers; only
 * "still running" is not.
 *
 * Fails CLOSED — an unreadable or not-yet-shaped status reads as still running.
 * The alternative would let a renderer that has not finished wiring its bridge
 * satisfy the very gate that exists to stop a premature completion.
 */
async function hasBootImportEnded(page: Page): Promise<boolean> {
  const raw = await page
    .evaluate(
      () =>
        (window as RuntimeStatusWindow).desktopApi?.getRuntimeStatus?.() ?? null
    )
    .catch(() => null);
  const parsed = BOOT_IMPORT_STATUS_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  return parsed.data.ingest.complete || parsed.data.ingest.timedOut;
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
  const sessionsHeader = page
    .locator("header")
    .getByText(SESSIONS_NAV_LABEL, { exact: true });
  try {
    await gotoNav(page, SESSIONS_NAV_ID);
    await expect(sessionsHeader).toBeVisible({ timeout: BOOT_WAIT_MS });
  } catch (cause) {
    throw new Error(await describeSurfaceWaitFailure(page), { cause });
  }
  appendMark(runDir, BOOT_TO_SESSIONS_STEP, performance.now() - launchedAt);
}

/**
 * Read what is actually on screen and turn it into a failure that names the
 * surface wait rather than the import.
 *
 * The probe is a non-waiting read: the waiting already happened and failed, and
 * a diagnosis that re-waits would add its own timeout to a run that is already
 * over.
 */
async function describeSurfaceWaitFailure(page: Page): Promise<string> {
  const headings = await page
    .getByRole("heading")
    .allInnerTexts()
    .catch(() => []);
  return surfaceWaitFailureMessage({ headings }, BOOT_WAIT_MS);
}

/**
 * A fresh user-data directory carrying the sandbox's sanitized settings (cloud
 * sync off, credentials already stripped by the dataset CLI), so the import
 * cannot phone home in either shape.
 *
 * In the `populated` shape the sandbox's snapshot is COPIED in, never opened in
 * place: the app migrates and writes the store it boots against, and the dataset
 * is meant to be reusable across runs.
 */
function createImportProfile(
  sandboxDir: string,
  runDir: string,
  storeShape: ImportStoreShape
): string {
  const userDataDir = path.join(runDir, IMPORT_USER_DATA_DIR_NAME);
  if (fs.existsSync(userDataDir)) {
    // A re-run of the same run directory must measure the requested shape, not
    // a resume against the previous attempt's store.
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
  if (storeShape === ImportStoreShape.Populated) {
    seedPopulatedStore(sandboxDir, userDataDir);
  }
  return userDataDir;
}

/**
 * Copy the dataset's store snapshot into the profile.
 *
 * The snapshot is a `VACUUM INTO` product, so it is a single self-contained file
 * with nothing left in a `-wal`; copying the one file is the whole store.
 */
function seedPopulatedStore(sandboxDir: string, userDataDir: string): void {
  const snapshot = path.join(sandboxDir, DESKTOP_DB_FILE_NAME);
  if (!fs.existsSync(snapshot)) {
    throw new Error(
      `No store snapshot at ${snapshot}. The ${ImportStoreShape.Populated} shape measures an import against an existing store, so it needs the snapshot the dataset CLI writes; rebuild the sandbox with \`node apps/desktop/scripts/perf-prepare-dataset.mjs\`.`
    );
  }
  fs.copyFileSync(snapshot, path.join(userDataDir, DESKTOP_DB_FILE_NAME));
}

/**
 * Which shape this run measures.
 *
 * An unrecognized value FAILS rather than falling back to the default: a typo
 * that silently measured the other shape would produce a real-looking number
 * describing the wrong question, which is the failure mode this lane exists to
 * stop being the answer to.
 */
function resolveImportStoreShape(): ImportStoreShape {
  const raw = process.env[IMPORT_STORE_SHAPE_ENV];
  if (raw === undefined || raw === "") {
    return ImportStoreShape.Empty;
  }
  const known = Object.values(ImportStoreShape).find((shape) => shape === raw);
  if (!known) {
    throw new Error(
      `${IMPORT_STORE_SHAPE_ENV}=${raw} is not a store shape. Use ${Object.values(ImportStoreShape).join(" or ")}.`
    );
  }
  return known;
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
