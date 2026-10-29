import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
/**
 * ISS-10414 regression, through the LAUNCHED app: when a range change leaves
 * one insights section still answering for the previous key, the widgets fed by
 * that section say so on the desktop host too — and stop captioning themselves
 * with the range the reader just selected.
 *
 * Why the launched app and not another mocked-hook render (review thread): the
 * defect is a property of the real TanStack query. `placeholderData:
 * keepPreviousData` re-renders every section with the LAST key's payload the
 * instant the selection changes and reports it as settled success, so nothing
 * is "loading", no skeleton draws, and the row paints last range's numbers
 * under this range's caption. Handing `stale` in as a boolean asserts the
 * render given the flag; only a held HTTP response proves the shipped query
 * raises it — and on desktop the query is reached through auth restore, the
 * cloud IPC transport and the local overlays, none of which a renderer suite
 * exercises.
 *
 * Cloud mode for the same reason `dashboard-absent-series-rows.spec.ts` uses
 * it: the Local engine answers from the local store with no HTTP round trip to
 * hold, so there is no previous-key window to observe.
 *
 * The web half of the pair is `e2e/dashboard-stale-section-disclosure.spec.ts`.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { createServer, type ServerResponse } from "node:http";
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { expect, type Page, test } from "@playwright/test";
import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import type {
  ActivityHeatmap,
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights.ts";
import {
  ROW_UPDATING_DESCRIPTION,
  ROW_UPDATING_LABEL,
} from "@repo/app/insights/components/overview/dashboard-refreshing.tsx";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors.ts";
import { DESKTOP_SYNCED_SESSIONS_TITLE } from "@repo/app/insights/components/overview/recent-sessions-copy.ts";
import { DATE_RANGE_LABELS } from "@repo/app/shared/lib/format-utils.ts";
import { sessionListRow } from "../../../../e2e/helpers/sessions-list-fixtures";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  routeDesktopSessionRefresh,
} from "./helpers/branch-details-authenticated-cloud";
import { DASHBOARD_HEADING } from "./helpers/dashboard-header-copy";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";

const READ_TIMEOUT_MS = 30_000;
const CLOUD_PROFILE_ID = "iss-10414-cloud-profile";
const CLOUD_REQUEST_ORIGIN = "http://127.0.0.1";

const ACTIVITY_ROW = `[data-tour="${DashboardTourAnchor.Activity}"]`;
const MODELS_ROW = `[data-tour="${DashboardTourAnchor.Models}"]`;

/** The heatmap's caption, which asserts a window: `<period> · hourly turn density`. */
const SEVEN_DAY_CAPTION = `${DATE_RANGE_LABELS["7d"]} · hourly turn density`;
const NINETY_DAY_CAPTION = `${DATE_RANGE_LABELS["90d"]} · hourly turn density`;

const MODELS = ["claude-opus-4-5", "gpt-5.4"] as const;
const WEEK_DATES = ["2026-05-14", "2026-05-15", "2026-05-16"] as const;
const QUARTER_DATES = ["2026-03-02", "2026-03-03", "2026-03-04"] as const;
const DATES = WEEK_DATES;

test.describe("Dashboard stale-section disclosure (ISS-10414)", () => {
  test("discloses the row whose section still answers for the previous range, and withdraws the selected-period caption", async () => {
    test.setTimeout(300_000);

    // Empty harness homes: the boot collectors ingest nothing, so the local
    // store holds no turn buckets for the heatmap overlay to splice in and the
    // rendered cells are exactly what the cloud stand-in served.
    const dirs = makeSeededSessionsDirs("desktop-iss10414");
    const cloud = await startDashboardCloudServer();

    try {
      await initializeDesktopProfileSchema(dirs.userDataDir);
      await waitForBranchesSchema(dirs.userDataDir);

      const launched = await launchCloudDashboard(dirs, cloud.origin, true);
      try {
        const { page } = launched;
        await openCloudDashboard(page);

        // Settled at the default 7d selection: the caption claims 7d and
        // nothing says "Updating". The positive control for both assertions
        // below — the caption DOES render here, and the chip does NOT.
        await expect(
          page.locator(ACTIVITY_ROW).getByText(SEVEN_DAY_CAPTION)
        ).toBeVisible({ timeout: READ_TIMEOUT_MS });
        await expect(
          page.locator(ACTIVITY_ROW).getByText(ROW_UPDATING_LABEL, {
            exact: true,
          })
        ).toHaveCount(0);

        // Hold Utilization, then change the range. Delivery and Agents answer
        // for 90d; Utilization does not, so the heatmap keeps drawing 7d cells.
        cloud.holdUtilization(InsightsPeriod.Quarter);
        await page.getByLabel(DATE_RANGE_LABELS["90d"]).click();
        await expect(page.getByLabel(DATE_RANGE_LABELS["90d"])).toHaveAttribute(
          "data-state",
          "on"
        );

        // The row says so, and its live region says WHICH data, so a
        // screen-reader user is not left with strictly less than a sighted one.
        await expect(
          page.locator(ACTIVITY_ROW).getByText(ROW_UPDATING_LABEL, {
            exact: true,
          })
        ).toBeVisible({ timeout: READ_TIMEOUT_MS });
        await expect(
          page.locator(ACTIVITY_ROW).getByText(ROW_UPDATING_DESCRIPTION)
        ).toHaveCount(1);

        // The held read was the one the production query key actually names.
        const keys = cloud.requestedUtilizationKeys();
        expect(
          keys.filter((key) => key.startsWith(`${InsightsPeriod.Quarter}:`))
        ).not.toHaveLength(0);
        expect(
          keys.filter((key) => key.startsWith(`${InsightsPeriod.Week}:`))
        ).not.toHaveLength(0);
        expect(keys.filter((key) => key.includes(":null"))).toHaveLength(0);

        // And it claims NEITHER window: not the 90d the reader selected (the
        // filed lie), and not the 7d the cells came from.
        await expect(
          page.locator(ACTIVITY_ROW).getByText(NINETY_DAY_CAPTION)
        ).toHaveCount(0);
        await expect(
          page.locator(ACTIVITY_ROW).getByText(SEVEN_DAY_CAPTION)
        ).toHaveCount(0);

        // Disclosed, not deleted: the previous range's heatmap stays drawn.
        await expect(
          page.locator(ACTIVITY_ROW).getByText("Event Activity")
        ).toBeVisible();

        // Scoped to the section that is actually behind: Models reads Agents,
        // which answered, so it carries no disclosure.
        await expect(
          page.locator(MODELS_ROW).getByText(ROW_UPDATING_LABEL, {
            exact: true,
          })
        ).toHaveCount(0);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-stale-section.png"),
        });

        // Released, the disclosure clears and the caption claims the selection.
        await cloud.releaseUtilization();
        await expect(
          page.locator(ACTIVITY_ROW).getByText(NINETY_DAY_CAPTION)
        ).toBeVisible({ timeout: READ_TIMEOUT_MS });
        await expect(
          page.locator(ACTIVITY_ROW).getByText(ROW_UPDATING_LABEL, {
            exact: true,
          })
        ).toHaveCount(0);

        expect(launched.pageErrors).toEqual([]);
      } finally {
        await launched.cleanup();
      }
    } finally {
      await cloud.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * Launch the signed-in profile against the cloud stand-in, on a coherent
 * consent record so the read source resolves to the cloud (ISS-6972's seed):
 * an incoherent one falls back to the local store, whose answers arrive with
 * no HTTP round trip to hold.
 */
function launchCloudDashboard(
  dirs: ReturnType<typeof makeSeededSessionsDirs>,
  apiOrigin: string,
  seedDashboardStorage = false
) {
  return launchAuthenticatedDesktopApp({
    seedDashboardStorage,
    sameProcessSessionSeed: seedDashboardStorage
      ? createAuthenticatedDesktopSessionRecord()
      : undefined,
    beforeLaunch: (launchUserDataDir) => {
      seedDesktopSettings(launchUserDataDir, {
        activeConfigId: CLOUD_PROFILE_ID,
        apiOrigin,
        cloudConnectionEnabled: true,
        dataSyncLevel: "full",
        savedConfigs: [
          {
            apiOrigin,
            gatewayId: AUTHENTICATED_GATEWAY_ID,
            id: CLOUD_PROFILE_ID,
            name: "ISS-10414 Cloud E2E",
            relayOrigin: "http://127.0.0.1:9",
            webAppOrigin: "http://127.0.0.1:3000",
          },
        ],
        syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
        syncObservabilityTier: "full",
      });
    },
    cloudReadReadiness: drainedCloudReadReadiness(),
    env: seededSessionsEnv(dirs, { CL_AUTH_API_ORIGIN: apiOrigin }),
    userDataDir: dirs.userDataDir,
  });
}

/** Open the Dashboard reading the CLOUD, settled on the Agents section. */
async function openCloudDashboard(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDesktopAuthState()), {
      timeout: READ_TIMEOUT_MS,
    })
    .toMatchObject({
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: AUTHENTICATED_USER_ID,
    });

  await gotoNav(page, "dashboard");
  await expect(
    page.getByRole("heading", {
      exact: true,
      level: 1,
      name: DASHBOARD_HEADING,
    })
  ).toBeVisible({ timeout: READ_TIMEOUT_MS });
  // ISS-10929 retired the dashboard's Local/Cloud read-source pill, which this
  // used to gate on. The cloud mode is now witnessed by the Recent Sessions
  // card's own cloud-only title — copy a local read never draws — so the rows
  // below are still graded against the mode they are written for.
  await expect(
    page.getByText(DESKTOP_SYNCED_SESSIONS_TITLE, { exact: true })
  ).toBeVisible({ timeout: READ_TIMEOUT_MS });
  await expect(page.locator(`${MODELS_ROW} .recharts-area`)).toHaveCount(
    MODELS.length,
    { timeout: 45_000 }
  );
}

type DashboardCloudServer = {
  close: () => Promise<void>;
  origin: string;
  /** Park ONLY the `/insights/utilization` read at this exact production key. */
  holdUtilization: (period: string) => void;
  /** Answer everything parked, and stop parking. */
  releaseUtilization: () => Promise<void>;
  /** Every `period:scope` key the renderer actually asked for, in order. */
  requestedUtilizationKeys: () => string[];
};

/**
 * A bounded stand-in for the authenticated cloud routes the Dashboard reads,
 * with ONE route that can be held open. The session mint is delegated to
 * `routeDesktopSessionRefresh` rather than copied.
 */
async function startDashboardCloudServer(): Promise<DashboardCloudServer> {
  let heldPeriod: string | null = null;
  const parked: ServerResponse[] = [];
  const requestedKeys: string[] = [];
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    const requestUrl = new URL(request.url ?? "/", CLOUD_REQUEST_ORIGIN);
    const pathname = requestUrl.pathname;
    if (request.method !== "GET") {
      writeCloudNotFound(response);
      return;
    }
    if (pathname === "/insights/utilization") {
      // Keyed on the PRODUCTION request key, not the pathname: a regression
      // that dropped `period` or `scope` used to be parked here too, so the
      // stale assertions passed while the dashboard fetched the wrong slice
      // (review thread, 2026-09-17).
      const period = requestUrl.searchParams.get("period");
      const scope = requestUrl.searchParams.get("scope");
      const key = `${period}:${scope}`;
      requestedKeys.push(key);
      // BOTH parameters must be present AND the period must be the held one.
      // A regression that drops either is therefore answered, not parked.
      if (heldPeriod !== null && period === heldPeriod && scope !== null) {
        parked.push(response);
        return;
      }
      writeCloudResult(response, utilizationInsights(period ?? ""));
      return;
    }
    // A non-zero total, or the body short-circuits to its empty state and no
    // row renders at all.
    if (pathname === "/agent-sessions") {
      writeCloudResult(response, workspaceSessions());
      return;
    }
    // Both other sections must RESOLVE — an erroring one replaces the whole
    // body with its degraded treatment and no row renders to read.
    if (pathname === "/insights/delivery") {
      writeCloudResult(response, deliveryInsights());
      return;
    }
    if (pathname === "/insights/agents") {
      writeCloudResult(response, agentsInsights());
      return;
    }
    writeCloudNotFound(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The dashboard cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    holdUtilization: (period) => {
      heldPeriod = period;
    },
    releaseUtilization: () => {
      const period = heldPeriod ?? "";
      heldPeriod = null;
      for (const response of parked.splice(0, parked.length)) {
        writeCloudResult(response, utilizationInsights(period));
      }
      return Promise.resolve();
    },
    requestedUtilizationKeys: () => [...requestedKeys],
    close: () =>
      new Promise<void>((resolve, rejectClose) => {
        // Nothing may stay parked, or `server.close` never fires its callback.
        for (const response of parked.splice(0, parked.length)) {
          writeCloudNotFound(response);
        }
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function workspaceSessions(): AgentSessionListResponse {
  return {
    items: [sessionListRow({ name: "ISS-10414 cloud seed" })],
    total: 1,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

const EMPTY_TIME_SERIES: TimeSeries = { points: [], series: [] };

function deliveryInsights(): DeliveryInsightsResponse {
  return {
    charts: {
      branchesWithoutPr: [],
      branchLifespan: [],
      meanTimeToMerge: [],
      prByRepo: [],
      prByState: [],
      prTrend: EMPTY_TIME_SERIES,
    },
    kpis: [],
  };
}

function utilizationInsights(period: string): UtilizationInsightsResponse {
  return {
    charts: {
      eventActivity: EMPTY_TIME_SERIES,
      reviewQueue: [],
      activityHeatmap: activityHeatmap(period),
    },
    kpis: [],
  };
}

/**
 * DISJOINT per period (review thread, 2026-09-17): one fixture for every key let
 * a request that dropped `period` draw the identical grid and pass every
 * assertion below.
 */
function activityHeatmap(period: string): ActivityHeatmap {
  const days = period === InsightsPeriod.Quarter ? QUARTER_DATES : WEEK_DATES;
  return {
    days: [...days],
    cells: [{ day: days[0], hour: 9, human: 3, agent: 1 }],
  };
}

function agentsInsights(): AgentsInsightsResponse {
  return {
    charts: {
      modelBreakdown: [],
      modelUsageOverTime: {
        series: MODELS.map((model) => ({ key: model, label: model })),
        points: DATES.map((date, dayIndex) => ({
          date,
          values: Object.fromEntries(
            MODELS.map((model, index) => [
              model,
              Number(((MODELS.length - index) * (dayIndex + 2)).toFixed(2)),
            ])
          ),
        })),
      },
    },
    kpis: [],
  };
}

function writeCloudResult(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data, success: true }));
}

function writeCloudNotFound(response: ServerResponse): void {
  response.statusCode = 404;
  writeCloudResult(response, { error: "not found" });
}
