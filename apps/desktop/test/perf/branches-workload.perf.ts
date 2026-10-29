/**
 * ISS-4656 capture-only Desktop Branches workload.
 *
 * Measures one settled Branches navigation followed by one unchanged Dashboard
 * control on a fresh clone of the same frozen, sync-off Desktop corpus. This
 * deliberately excludes the Sessions route: the general browse workload waits
 * up to three minutes for a session row that some valid corpora do not contain,
 * which makes that route unsuitable for the interleaved ISS-4656 experiment
 * cadence.
 *
 * This is a profiling runner, not an E2E gate. It uses the same displayless
 * launch helper and artifact contract as sessions-workload.perf.ts. Raw
 * captures remain under ignored .perf/.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  ProfilingArtifactFile,
  ProfilingEnvVar,
} from "../../src/shared/profiling";
import {
  gotoNav,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "../e2e/helpers/desktop-app";
import { sortColumnByOptionsMenu } from "../e2e/helpers/grid-column-sort";
import {
  appendMark,
  appendPhase,
  assertCollectorHomesIsolated,
  closeAppForProfileWrite,
  DESKTOP_USER_DATA_DIR_ENV,
  PerfLane,
  PerfSurface,
  requireAbsoluteDirEnv,
  requireSandboxDatabase,
  resolveCollectorHomes,
  WORKLOAD_MARKS_FILE_NAME,
  WORKLOAD_PHASES_FILE_NAME,
  writeRunManifest,
} from "./helpers/perf-run";

const WORKLOAD_TIMEOUT_MS = 5 * 60_000;
const DB_HOST_READY_TIMEOUT_MS = 2 * 60_000;
const STEP_WAIT_MS = 60_000;
const REPRESENTATIVE_SAMPLE_COUNT = 20;
const BRANCHES_LOADING_COPY = "Loading branches…";
const NO_BRANCHES_COPY = "No branches yet";
const NO_MATCHES_COPY = "No matching branches";
// Twin of `SHARED_BRANCHES_IPC_CHANNELS.pageData`. The production contract
// imports `@repo/api`, which the standalone Playwright runner cannot resolve.
const BRANCHES_PAGE_DATA_CHANNEL = "desktop:shared-branches:page-data";
const POSITIVE_RESPONSE_BYTES_PATTERN = /"responseBytes":[1-9]\d*/;

const WorkloadStep = {
  NavBranches: "iss-4656-nav-branches",
  PageDataSamples: "iss-9541-page-data-samples",
  RenderSamples: "iss-9541-render-samples",
  DashboardControl: "iss-4656-dashboard-control",
} as const;

const REQUIRED_CAPTURE_ARTIFACTS = [
  ProfilingArtifactFile.MainCpuProfile,
  ProfilingArtifactFile.DbHostCpuProfile,
  ProfilingArtifactFile.DbOps,
  ProfilingArtifactFile.Ipc,
  ProfilingArtifactFile.RenderCommits,
] as const;

test("ISS-4656 Desktop Branches workload", async () => {
  test.setTimeout(WORKLOAD_TIMEOUT_MS);

  const runDir = requireAbsoluteDirEnv(
    ProfilingEnvVar.Dir,
    "Set CLOSEDLOOP_PROFILE_DIR to an ignored .perf run directory."
  );
  const userDataDir = requireAbsoluteDirEnv(
    DESKTOP_USER_DATA_DIR_ENV,
    "Set CLOSEDLOOP_DESKTOP_USER_DATA_DIR to a fresh perf-prepare-dataset sandbox."
  );
  requireSandboxDatabase(userDataDir);
  fs.mkdirSync(runDir, { recursive: true });
  writeRunManifest(runDir, PerfLane.Desktop);

  const collectorHomes = resolveCollectorHomes({ runDir });
  assertCollectorHomesIsolated(collectorHomes, [runDir]);
  const launched = await launchDesktopApp({
    userDataDir,
    keepUserDataDir: true,
    env: {
      ...collectorHomes,
      [ProfilingEnvVar.Dir]: runDir,
      OTEL_SDK_DISABLED: "0",
      CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS: "0",
    },
  });

  try {
    await gotoNav(launched.page, "dashboard");
    await waitForHeader(launched.page, "Dashboard");
    await waitForLocalAgentComponentList(
      launched.page,
      DB_HOST_READY_TIMEOUT_MS
    );
    await measureStep(
      runDir,
      WorkloadStep.NavBranches,
      PerfSurface.Branches,
      async () => {
        await gotoNav(launched.page, "branches");
        await waitForBranchesSettled(launched.page);
      }
    );
    await measureStep(
      runDir,
      WorkloadStep.PageDataSamples,
      PerfSurface.Branches,
      async () => {
        for (let index = 0; index < REPRESENTATIVE_SAMPLE_COUNT; index += 1) {
          const response = await invokePageData(launched.page);
          expect(response.items).toBe(response.total);
        }
      }
    );
    await measureStep(
      runDir,
      WorkloadStep.RenderSamples,
      PerfSurface.Branches,
      async () => {
        for (let index = 0; index < REPRESENTATIVE_SAMPLE_COUNT; index += 1) {
          await sortColumnByOptionsMenu(
            launched.page,
            launched.page,
            "Status",
            index % 2 === 0 ? "ascending" : "descending"
          );
        }
      }
    );
    await measureStep(
      runDir,
      WorkloadStep.DashboardControl,
      PerfSurface.Dashboard,
      async () => {
        await gotoNav(launched.page, "dashboard");
        await waitForHeader(launched.page, "Dashboard");
      }
    );
  } finally {
    await closeAppForProfileWrite(launched);
  }

  assertCaptureArtifacts(runDir);
  assertBranchesPageDataCaptured(runDir);
});

function invokePageData(page: Page) {
  return page.evaluate(async () => {
    const response = await window.desktopApi.branchesApi.pageData({});
    return {
      items: response.list.items.length,
      total: response.list.total,
    };
  });
}

async function waitForBranchesSettled(page: Page): Promise<void> {
  await waitForHeader(page, "Branches");
  await expect(page.getByText("Active branches", { exact: true })).toBeVisible({
    timeout: STEP_WAIT_MS,
  });
  await expect(
    page.getByText(BRANCHES_LOADING_COPY, { exact: true })
  ).toHaveCount(0, { timeout: STEP_WAIT_MS });
  await expect(
    page
      .getByRole("grid")
      .or(page.getByRole("table"))
      .or(page.getByText(NO_BRANCHES_COPY, { exact: true }))
      .or(page.getByText(NO_MATCHES_COPY, { exact: true }))
  ).toBeVisible({ timeout: STEP_WAIT_MS });
}

async function waitForHeader(page: Page, label: string): Promise<void> {
  await expect(
    page.locator("header").getByText(label, { exact: true })
  ).toBeVisible({ timeout: STEP_WAIT_MS });
}

async function measureStep(
  runDir: string,
  step: string,
  surface: PerfSurface,
  work: () => Promise<void>
): Promise<void> {
  const startedAt = performance.now();
  const startedAtEpochMs = Date.now();
  await work();
  const ms = performance.now() - startedAt;
  appendMark(runDir, step, ms);
  appendPhase(runDir, {
    surface,
    step,
    ms,
    startedAtEpochMs,
    endedAtEpochMs: Date.now(),
  });
}

function assertCaptureArtifacts(runDir: string): void {
  for (const fileName of [
    WORKLOAD_MARKS_FILE_NAME,
    WORKLOAD_PHASES_FILE_NAME,
    ...REQUIRED_CAPTURE_ARTIFACTS,
  ]) {
    const filePath = path.join(runDir, fileName);
    expect(fs.existsSync(filePath), `${fileName} missing from ${runDir}`).toBe(
      true
    );
    expect(fs.statSync(filePath).size, `${fileName} is empty`).toBeGreaterThan(
      0
    );
  }
}

function assertBranchesPageDataCaptured(runDir: string): void {
  const ipcPath = path.join(runDir, ProfilingArtifactFile.Ipc);
  const capturedPageData = fs
    .readFileSync(ipcPath, "utf8")
    .split("\n")
    .filter(
      (line) =>
        line.includes(`"channel":"${BRANCHES_PAGE_DATA_CHANNEL}"`) &&
        POSITIVE_RESPONSE_BYTES_PATTERN.test(line)
    );
  expect(
    capturedPageData.length,
    `${BRANCHES_PAGE_DATA_CHANNEL} response bytes missing from ${ipcPath}`
  ).toBeGreaterThanOrEqual(REPRESENTATIVE_SAMPLE_COUNT);
}
