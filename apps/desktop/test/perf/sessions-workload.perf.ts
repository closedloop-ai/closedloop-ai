/**
 * ISS-4430 — the DESKTOP SESSIONS profiling workload.
 *
 * One scripted user route over a prepared copy of a real Desktop population,
 * with every step's wall time appended to `workload-marks.jsonl` in the run
 * directory. It is a RUNNER, not a CI test: nothing here gates a merge, and the
 * assertions at the end exist to prove the capture pipeline actually wrote its
 * artifacts — the workload IS the smoke test of the instrumentation.
 *
 * Route: boot → dashboard → sessions → five pages forward → session detail →
 * branches → insights → back to dashboard.
 *
 * Contract with the rest of the system:
 *   - `CLOSEDLOOP_PROFILE_DIR` (absolute) is the run directory. The just target
 *     creates and exports it; this spec writes `manifest.json` and
 *     `workload-marks.jsonl` into it and passes it through to the app so the
 *     env-gated instrumentation turns itself on.
 *   - `CLOSEDLOOP_DESKTOP_USER_DATA_DIR` (absolute) is a sandbox produced by
 *     `apps/desktop/scripts/perf-prepare-dataset.mjs`. It is launched in place
 *     (`keepUserDataDir`) so the population survives the run and the next run
 *     measures the same corpus.
 *
 * Collector isolation matters here as much as it does in the import lane, for a
 * different reason. `launchDesktopApp` inherits the operator's environment, and
 * the app's collector manager does not just import at boot — it WATCHES every
 * collector home for the life of the process. Left unmapped, this lane would
 * ingest the operator's live transcripts while it browsed, growing the very
 * population it is timing, writing those rows into the sandbox, and leaving the
 * next run a different dataset. So every collector home is pointed at an empty
 * directory under the run folder, asserted before launch: this lane profiles
 * BROWSING a fixed corpus, and zero TRANSCRIPT IMPORT during the run is the
 * point. One residual read remains outside the env vars' reach: the pack
 * definition scan (`pack-scan-post-steps.ts` → `getRecentProjectRoots`) walks
 * project roots recorded IN the sandbox DB — real operator paths — looking for
 * definition markdown. It is read-only, writes nothing to operator data, and
 * its cost is part of what this lane measures.
 *
 * A step that cannot complete records its elapsed time under `<step>:timeout`
 * and the route continues, so one wedged surface costs one mark rather than the
 * whole profile.
 *
 * Prerequisites:
 *   - `pnpm -C apps/desktop build`, then a renderer rebuild with
 *     `CLOSEDLOOP_PROFILE_RENDERER_BUILD=1 pnpm -C apps/desktop build:renderer`
 *     (ISS-5278). React ships `<Profiler onRender>` only in its development and
 *     profiling builds, so a stock production renderer captures ZERO render
 *     commits and this spec's `render-commits.jsonl` assertion fails.
 *     `just profile-desktop` runs that rebuild for you.
 *   - `just profile-desktop-prep` (or run the dataset CLI directly)
 * Run:
 *   npx playwright test --config playwright.perf.config.ts \
 *     test/perf/sessions-workload.perf.ts
 */

import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  PROFILING_RENDERER_BUILD_ENABLED_VALUE,
  ProfilingArtifactFile,
  ProfilingEnvVar,
} from "../../src/shared/profiling";
import {
  dismissDesktopOnboardingOverlay,
  gotoNav,
  launchDesktopApp,
  openDetailFromList,
} from "../e2e/helpers/desktop-app";
import {
  appendMark,
  assertCollectorHomesIsolated,
  closeAppForProfileWrite,
  DESKTOP_DB_FILE_NAME,
  DESKTOP_USER_DATA_DIR_ENV,
  describeError,
  PerfLane,
  requireAbsoluteDirEnv,
  resolveCollectorHomes,
  TIMEOUT_STEP_SUFFIX,
  WORKLOAD_MARKS_FILE_NAME,
  writeRunManifest,
} from "./helpers/perf-run";

/** How many pages forward the route walks. */
const PAGINATE_STEP_COUNT = 5;

/**
 * Per-step wait bound. Deliberately larger than the E2E norm: every wait here
 * races an app under a V8 sampler against a multi-thousand-row population, and
 * a step that is merely SLOW is the finding — timing it out early would convert
 * the measurement this workload exists to take into a missing data point.
 * Dogfood run 20260805T152620Z proved 60s censors real values on a large
 * corpus (nav-sessions exceeded it while paginate-1 then measured 43s), so the
 * bound sits far above the worst observed step.
 */
const STEP_WAIT_MS = 180_000;

/**
 * Total runway. The eight-step route plus a real close can sit near the sum of
 * its per-step bounds on a cold, heavily-populated profile.
 */
const WORKLOAD_TIMEOUT_MS = 20 * 60_000;

/**
 * Nav ids passed to `gotoNav`, and the Topbar breadcrumb label each one paints.
 * String literals matching the e2e house convention: the canonical `NavId` /
 * `NAV_ENTRIES` live in the renderer, whose module graph (`@repo/app`,
 * `@repo/navigation`) does not resolve from a Playwright runner process.
 */
const WorkloadNav = {
  Dashboard: { id: "dashboard", label: "Dashboard" },
  Sessions: { id: "sessions", label: "Sessions" },
  Branches: { id: "branches", label: "Branches" },
  Insights: { id: "insights", label: "Insights" },
} as const;

/** Step names as they land in `workload-marks.jsonl`. */
const WorkloadStep = {
  BootToDashboard: "boot-to-dashboard",
  NavSessions: "nav-sessions",
  OpenSessionDetail: "open-session-detail",
  NavBranches: "nav-branches",
  NavInsights: "nav-insights",
  ReturnDashboard: "return-dashboard",
} as const;

/**
 * Every list locator is `:visible`-scoped. The desktop shell keeps peer views
 * MOUNTED but hidden once visited, and several of them render the same
 * `#/sessions/<id>` row links and the same shared pagination control — so an
 * unscoped match can silently resolve against a stale hidden view instead of
 * the surface under measurement.
 */
const VISIBLE_SESSION_ROW_LINK = 'a[href^="#/sessions/"]:visible';
const VISIBLE_NEXT_PAGE_CONTROL = '[aria-label="Go to next page"]:visible';
const VISIBLE_BUSY_REGION = '[aria-busy="true"]:visible';

/** Outcome of one page-forward attempt. */
const PaginateOutcome = {
  Paged: "paged",
  Exhausted: "exhausted",
} as const;
type PaginateOutcome = (typeof PaginateOutcome)[keyof typeof PaginateOutcome];

/** Artifacts the desktop lane must have produced by the time the app is down. */
const REQUIRED_CAPTURE_ARTIFACTS = [
  ProfilingArtifactFile.MainCpuProfile,
  ProfilingArtifactFile.DbHostCpuProfile,
  ProfilingArtifactFile.DbOps,
  ProfilingArtifactFile.Ipc,
  // ISS-5278: required, not optional. This route navigates to Sessions, pages
  // through it five times and opens a detail view, so a run that produced no
  // React Profiler commit did not "legitimately render nothing" — its capture
  // is broken, which is exactly how this lane stayed silently blind.
  ProfilingArtifactFile.RenderCommits,
] as const;

test("desktop sessions workload", async () => {
  test.setTimeout(WORKLOAD_TIMEOUT_MS);

  const runDir = requireAbsoluteDirEnv(
    ProfilingEnvVar.Dir,
    "Set it to the run directory, e.g. .perf/runs/<utc-stamp>-desktop/ (the `just profile-desktop` target creates and exports it)."
  );
  const userDataDir = requireAbsoluteDirEnv(
    DESKTOP_USER_DATA_DIR_ENV,
    "Set it to a sandbox built by `node apps/desktop/scripts/perf-prepare-dataset.mjs`."
  );
  requireSandboxDatabase(userDataDir);

  fs.mkdirSync(runDir, { recursive: true });
  writeRunManifest(runDir, PerfLane.Desktop);

  // Every collector home points at an empty directory this run owns. This lane
  // profiles BROWSING a fixed population, so it wants ZERO import during the
  // run — see the module header for why inheriting the operator's homes would
  // both spoil the measurement and touch live data.
  const collectorHomes = resolveCollectorHomes({ runDir });
  assertCollectorHomesIsolated(collectorHomes, [runDir]);

  const bootStartedAt = performance.now();
  const launched = await launchDesktopApp({
    // In place, and kept: the sandbox IS the population, and a run that deleted
    // it would leave the next run nothing comparable to measure.
    userDataDir,
    keepUserDataDir: true,
    env: {
      ...collectorHomes,
      [ProfilingEnvVar.Dir]: runDir,
      // The launch helper's test default is OTEL_SDK_DISABLED=1, which silences
      // the renderer OTel bridge the render-commit sink taps. Re-enable the SDK
      // but hard-disable egress so everything stays local.
      //
      // ISS-5278: necessary, but it was never sufficient — run 20260805T153238Z
      // set exactly this and still captured nothing. The binding constraint is
      // upstream of OTel entirely: a production React DOM has no
      // `<Profiler onRender>`, so the producer never fires. That one is fixed at
      // BUILD time (see the prerequisites in the module header), because no
      // launch env can put a stripped callback back into the bundle.
      OTEL_SDK_DISABLED: "0",
      CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS: "0",
    },
  });

  try {
    await runSessionsRoute(launched.page, runDir, bootStartedAt);
  } finally {
    await closeAppForProfileWrite(launched);
  }

  assertCaptureArtifacts(runDir);
});

/** The scripted route, in order. Each step records its own mark. */
async function runSessionsRoute(
  page: Page,
  runDir: string,
  bootStartedAt: number
): Promise<void> {
  await measureStep(
    runDir,
    WorkloadStep.BootToDashboard,
    async () => {
      // The signed-out first-launch overlay intercepts pointer events over the
      // Dashboard; neutralize it once, before anything is clicked.
      await dismissDesktopOnboardingOverlay(page);
      // The app's landing route is Sessions (DEFAULT_NAV_ID), so reaching the
      // Dashboard is an explicit navigation — this step measures launch through
      // first Dashboard paint, not launch alone.
      await gotoNav(page, WorkloadNav.Dashboard.id);
      await waitForNavView(page, WorkloadNav.Dashboard.label);
    },
    bootStartedAt
  );

  await measureStep(runDir, WorkloadStep.NavSessions, async () => {
    await gotoNav(page, WorkloadNav.Sessions.id);
    await waitForNavView(page, WorkloadNav.Sessions.label);
    await expect(firstSessionRowLink(page)).toBeVisible({
      timeout: STEP_WAIT_MS,
    });
  });

  await runPaginationSteps(page, runDir);

  await measureStep(runDir, WorkloadStep.OpenSessionDetail, async () => {
    await openDetailFromList(
      page,
      page.locator(VISIBLE_SESSION_ROW_LINK),
      WorkloadNav.Sessions.label
    );
  });

  await measureStep(runDir, WorkloadStep.NavBranches, async () => {
    await gotoNav(page, WorkloadNav.Branches.id);
    await waitForNavView(page, WorkloadNav.Branches.label);
  });

  await measureStep(runDir, WorkloadStep.NavInsights, async () => {
    await gotoNav(page, WorkloadNav.Insights.id);
    // The real Insights surface, not the Labs gate's hold: assert the view's own
    // <h1>, which only the mounted bounded view renders (ISS-5037). The
    // breadcrumb label alone paints while the lazy chunk is still resolving.
    await expect(
      page.getByRole("heading", {
        exact: true,
        level: 1,
        name: WorkloadNav.Insights.label,
      })
    ).toBeVisible({ timeout: STEP_WAIT_MS });
  });

  await measureStep(runDir, WorkloadStep.ReturnDashboard, async () => {
    await gotoNav(page, WorkloadNav.Dashboard.id);
    await waitForNavView(page, WorkloadNav.Dashboard.label);
  });
}

/**
 * Walk forward through the sessions list, one mark per page turn.
 *
 * A list with fewer pages than {@link PAGINATE_STEP_COUNT} is a fact about the
 * dataset, not a failure, and it records NO mark — a fabricated duration for a
 * page turn that never happened would be a lie in the evidence file. A step that
 * genuinely wedges records `<step>:timeout` and abandons pagination: the control
 * that just failed will not recover for step N+1, and the route has five more
 * steps worth measuring.
 */
async function runPaginationSteps(page: Page, runDir: string): Promise<void> {
  for (let index = 1; index <= PAGINATE_STEP_COUNT; index += 1) {
    const step = `paginate-${index}`;
    const startedAt = performance.now();
    try {
      const outcome = await turnToNextSessionsPage(page);
      if (outcome === PaginateOutcome.Exhausted) {
        console.info(
          `[perf] ${step}: sessions list has no further page — dataset is ${index - 1} page turns deep. Stopping pagination.`
        );
        return;
      }
      appendMark(runDir, step, performance.now() - startedAt);
    } catch (error) {
      appendMark(
        runDir,
        `${step}${TIMEOUT_STEP_SUFFIX}`,
        performance.now() - startedAt
      );
      console.warn(`[perf] ${step} did not settle: ${describeError(error)}`);
      return;
    }
  }
}

/**
 * One page turn, settled. Throws when the control never appears or the new page
 * never lands; returns `Exhausted` when the list has no next page.
 */
async function turnToNextSessionsPage(page: Page): Promise<PaginateOutcome> {
  const nextControl = page.locator(VISIBLE_NEXT_PAGE_CONTROL).first();
  await expect(nextControl).toBeVisible({ timeout: STEP_WAIT_MS });

  // On the last page the shared control stays rendered but is marked
  // `aria-disabled` and `pointer-events-none`, so a click would burn the full
  // actionability timeout and report as a hang rather than as end-of-list.
  if ((await nextControl.getAttribute("aria-disabled")) === "true") {
    return PaginateOutcome.Exhausted;
  }

  const previousFirstHref =
    await firstSessionRowLink(page).getAttribute("href");
  await nextControl.click();
  await settleSessionsPage(page, previousFirstHref);
  return PaginateOutcome.Paged;
}

/**
 * Wait for the NEW page of rows, not merely for rows.
 *
 * Two signals, because either alone is satisfiable by the outgoing page: the
 * pagination footer unmounts while the table is loading (the view gates it on
 * its loading label) so its return marks the end of the fetch, and the first
 * row's identity must have changed because the query keeps the previous page's
 * rows on screen throughout. The busy flag clearing is the final confirmation.
 */
async function settleSessionsPage(
  page: Page,
  previousFirstHref: string | null
): Promise<void> {
  await expect(page.locator(VISIBLE_NEXT_PAGE_CONTROL).first()).toBeVisible({
    timeout: STEP_WAIT_MS,
  });
  if (previousFirstHref !== null) {
    await expect(firstSessionRowLink(page)).not.toHaveAttribute(
      "href",
      previousFirstHref,
      { timeout: STEP_WAIT_MS }
    );
  }
  await expect(page.locator(VISIBLE_BUSY_REGION)).toHaveCount(0, {
    timeout: STEP_WAIT_MS,
  });
}

function firstSessionRowLink(page: Page): Locator {
  return page.locator(VISIBLE_SESSION_ROW_LINK).first();
}

/**
 * The Topbar breadcrumb label for a view — present in every data state, so it
 * proves the route resolved and the shell survived without depending on the
 * population. Scoped to `<header>` so a sidebar entry of the same name cannot
 * satisfy it.
 */
async function waitForNavView(page: Page, label: string): Promise<void> {
  await expect(
    page.locator("header").getByText(label, { exact: true })
  ).toBeVisible({ timeout: STEP_WAIT_MS });
}

/**
 * Run one step, record its wall time, and never let its failure end the route.
 * `startedAt` is injectable for the boot step, whose clock starts before the app
 * process exists.
 */
async function measureStep(
  runDir: string,
  step: string,
  run: () => Promise<void>,
  startedAt: number = performance.now()
): Promise<void> {
  try {
    await run();
    appendMark(runDir, step, performance.now() - startedAt);
  } catch (error) {
    appendMark(
      runDir,
      `${step}${TIMEOUT_STEP_SUFFIX}`,
      performance.now() - startedAt
    );
    console.warn(`[perf] ${step} did not settle: ${describeError(error)}`);
  }
}

/**
 * The capture pipeline's own smoke check. A missing or empty artifact means the
 * instrumentation did not run (or did not flush) — the analyzers would otherwise
 * report the lane as "capture failed" with no clue that the WORKLOAD saw it.
 *
 * ISS-5278: `render-commits.jsonl` is in the required set. It used to be
 * excused on the theory that a route might legitimately commit nothing; the real
 * reason both dogfood runs produced none was that a production React DOM has no
 * `<Profiler onRender>` at all, so the lane could never have captured a commit
 * no matter what it rendered. Asserting it is what stops that regressing back
 * into a silent hole.
 */
function assertCaptureArtifacts(runDir: string): void {
  const marksPath = path.join(runDir, WORKLOAD_MARKS_FILE_NAME);
  expect(
    fs.existsSync(marksPath),
    `${WORKLOAD_MARKS_FILE_NAME} should have been written to ${runDir}`
  ).toBe(true);

  for (const fileName of REQUIRED_CAPTURE_ARTIFACTS) {
    const filePath = path.join(runDir, fileName);
    expect(
      fs.existsSync(filePath),
      `${fileName} missing from ${runDir} — the profiling instrumentation did not run. ${captureRemedy(fileName)}`
    ).toBe(true);
    expect(
      fs.statSync(filePath).size,
      `${fileName} is empty — capture started but never flushed. ${captureRemedy(fileName)}`
    ).toBeGreaterThan(0);
  }
}

/**
 * Per-artifact remedy. `render-commits.jsonl` gets its own because the generic
 * "did the run dir reach the app?" advice is an actively misleading answer for
 * it: the run dir plainly DID reach the app whenever the other four artifacts
 * exist, and the actual cause is a renderer built without React's profiling
 * build.
 */
function captureRemedy(fileName: string): string {
  if (fileName === ProfilingArtifactFile.RenderCommits) {
    return (
      "React strips `<Profiler onRender>` from its production build, so the renderer must be built " +
      `with ${ProfilingEnvVar.RendererBuild}=${PROFILING_RENDERER_BUILD_ENABLED_VALUE} ` +
      "(`just profile-desktop` does this for you; a bare `pnpm -C apps/desktop build` does not)."
    );
  }
  return `Confirm ${ProfilingEnvVar.Dir} reached the app.`;
}

function requireSandboxDatabase(userDataDir: string): void {
  const dbPath = path.join(userDataDir, DESKTOP_DB_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No ${DESKTOP_DB_FILE_NAME} in ${userDataDir}. ` +
        `${DESKTOP_USER_DATA_DIR_ENV} must point at a sandbox built by ` +
        "`node apps/desktop/scripts/perf-prepare-dataset.mjs`, not at a bare directory."
    );
  }
}
