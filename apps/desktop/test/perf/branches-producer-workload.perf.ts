/** ISS-4656 E2: direct legacy-versus-server Desktop page-data workload. */

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
import {
  appendMark,
  appendPhase,
  assertCollectorHomesIsolated,
  closeAppForProfileWrite,
  DESKTOP_DB_FILE_NAME,
  DESKTOP_USER_DATA_DIR_ENV,
  PerfLane,
  PerfSurface,
  requireAbsoluteDirEnv,
  resolveCollectorHomes,
  WORKLOAD_MARKS_FILE_NAME,
  WORKLOAD_PHASES_FILE_NAME,
  writeRunManifest,
} from "./helpers/perf-run";

const WORKLOAD_TIMEOUT_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 60_000;
const BRANCHES_PAGE_DATA_CHANNEL = "desktop:shared-branches:page-data";

test("ISS-4656 Desktop Branches producer workload", async () => {
  test.setTimeout(WORKLOAD_TIMEOUT_MS);
  const runDir = requireAbsoluteDirEnv(ProfilingEnvVar.Dir, "Set profile dir");
  const userDataDir = requireAbsoluteDirEnv(
    DESKTOP_USER_DATA_DIR_ENV,
    "Set a fresh prepared Desktop sandbox"
  );
  requireDatabase(userDataDir);
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
    await waitForLocalAgentComponentList(launched.page, STEP_TIMEOUT_MS);
    await measure(runDir, "iss-4656-producer-server-page", async () => {
      const response = await invokePageData(launched.page, {
        pageMode: "server",
        limit: 20,
        offset: 0,
        sortKey: "lastActivity",
        sortDir: "desc",
      });
      expect(response.items).toBeLessThanOrEqual(20);
      expect(response.capability).toBe("server_pagination_v1");
    });
    await measure(runDir, "iss-4656-producer-legacy-complete", async () => {
      const response = await invokePageData(launched.page, {});
      expect(response.items).toBe(response.total);
      expect(response.capability).toBeNull();
    });
    await measure(runDir, "iss-4656-producer-dashboard-control", async () => {
      await gotoNav(launched.page, "dashboard");
      await waitForHeader(launched.page, "Dashboard");
    });
  } finally {
    await closeAppForProfileWrite(launched);
  }

  assertArtifacts(runDir);
});

function invokePageData(page: Page, request: Record<string, unknown>) {
  return page.evaluate(async (query) => {
    const api = (
      globalThis as unknown as {
        desktopApi: {
          branchesApi: {
            pageData: (value: unknown) => Promise<{
              list: {
                items: unknown[];
                total: number;
                pageInfo?: { capability?: string };
              };
            }>;
          };
        };
      }
    ).desktopApi;
    const response = await api.branchesApi.pageData(query);
    return {
      items: response.list.items.length,
      total: response.list.total,
      capability: response.list.pageInfo?.capability ?? null,
    };
  }, request);
}

async function waitForHeader(page: Page, label: string): Promise<void> {
  await expect(
    page.locator("header").getByText(label, { exact: true })
  ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

async function measure(
  runDir: string,
  step: string,
  work: () => Promise<void>
): Promise<void> {
  const startedAt = performance.now();
  const startedAtEpochMs = Date.now();
  await work();
  const ms = performance.now() - startedAt;
  appendMark(runDir, step, ms);
  appendPhase(runDir, {
    surface: step.includes("dashboard")
      ? PerfSurface.Dashboard
      : PerfSurface.Branches,
    step,
    ms,
    startedAtEpochMs,
    endedAtEpochMs: Date.now(),
  });
}

function assertArtifacts(runDir: string): void {
  for (const fileName of [
    WORKLOAD_MARKS_FILE_NAME,
    WORKLOAD_PHASES_FILE_NAME,
    ProfilingArtifactFile.DbOps,
    ProfilingArtifactFile.Ipc,
  ]) {
    const filePath = path.join(runDir, fileName);
    expect(fs.existsSync(filePath), `${fileName} missing`).toBe(true);
    expect(fs.statSync(filePath).size, `${fileName} empty`).toBeGreaterThan(0);
  }
  const pageDataRows = fs
    .readFileSync(path.join(runDir, ProfilingArtifactFile.Ipc), "utf8")
    .split("\n")
    .filter((line) =>
      line.includes(`"channel":"${BRANCHES_PAGE_DATA_CHANNEL}"`)
    );
  expect(pageDataRows).toHaveLength(2);
}

function requireDatabase(userDataDir: string): void {
  const dbPath = path.join(userDataDir, DESKTOP_DB_FILE_NAME);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No ${DESKTOP_DB_FILE_NAME} in ${userDataDir}`);
  }
}
