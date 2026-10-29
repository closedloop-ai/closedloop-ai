import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
/**
 * ISS-9993 regression, through the launched app: a Dashboard row whose data
 * series is absent once its section settles is DROPPED on the desktop host,
 * and Recent Sessions follows the rows that remain.
 *
 * The rule lives in `visibleDashboardRows` (`dashboard-row-sections.ts`) and
 * both hosts call it. The desktop half of the change is only reachable in
 * CLOUD mode: the local engine always returns both series, so Local mode draws
 * every row on every payload. In Cloud mode the `/insights/agents` route never
 * computes `autonomyTrend`, and an older `/insights/utilization` route omits
 * `activityHeatmap`; the desktop overlays (`overlayLocalAutonomyTrend`,
 * `overlayLocalActivityHeatmap`) splice the local series in only when the
 * local store holds turn buckets. This profile holds none, so the payload the
 * body renders is exactly what the cloud stand-in serves.
 *
 * The shipped desktop shell filtered `frustration` and `agent-pipeline` by
 * hand and mapped every other row: the autonomy card shimmered a skeleton that
 * never resolved, the activity card drew "No activity in range yet" for a
 * series the route had not sent, and Recent Sessions was hard-wired under the
 * activity row. The renderer suite pins each of those against mocked hooks;
 * this spec pins them through the shipped auth restore, the cloud IPC
 * transport, the overlays and the mounted Dashboard, because the mode is not a
 * prop — it is the product of auth + connectivity + the consent record.
 *
 * Two authenticated launches against the SAME session and local store, so the
 * only thing that differs between them is the Utilization payload:
 *   1. heatmap ABSENT — the `activity` and `autonomy` rows are gone (no card, no
 *      skeleton, no grid slot) and Recent Sessions sits under `stats`;
 *   2. heatmap PRESENT — the `activity` row is back and Recent Sessions moved
 *      under it. This is what makes launch 1 a targeted drop and not a broken
 *      dashboard.
 * `autonomy` is absent in BOTH launches: the cloud never sends it and the local
 * store cannot fill it. The `models` row's painted areas prove the Agents
 * section — the one the autonomy row reads — has settled, so its absence is the
 * rule and not a row that had not loaded yet.
 *
 * Launch 1 also replays the tour. This profile is signed in but has no
 * program assignment. `useDashboardTourSteps` returns the canonical resolver
 * for every profile since ISS-10195, and that resolver keeps a beat only while
 * its anchor has area. The walk pins that the ACTIVITY beat is nowhere in the
 * run, by walking the beats that remain: the canonical list is stats → impact →
 * activity → sessions → models → prs, and on this page `impact` (rendered under
 * the stats row) and `sessions` (Recent Sessions, re-anchored under stats) both
 * have area while `activity` has none. So `Next` from stats reaches impact, not
 * models — the adjacency the legacy four-beat list had and the canonical one
 * does not.
 *
 * The web half of the pair is `e2e/dashboard-absent-series-rows.spec.ts`.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors.ts";
import {
  DESKTOP_RECENT_SESSIONS_TITLE,
  DESKTOP_SYNCED_SESSIONS_DESCRIPTION,
  DESKTOP_SYNCED_SESSIONS_TITLE,
  WEB_RECENT_SESSIONS_TITLE,
} from "@repo/app/insights/components/overview/recent-sessions-copy.ts";
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
const CLOUD_PROFILE_ID = "iss-9993-cloud-profile";
const CLOUD_REQUEST_ORIGIN = "http://127.0.0.1";

const STATS_ROW = `[data-tour="${DashboardTourAnchor.Stats}"]`;
const ACTIVITY_ROW = `[data-tour="${DashboardTourAnchor.Activity}"]`;
const AUTONOMY_ROW = `[data-tour="${DashboardTourAnchor.Autonomy}"]`;
const MODELS_ROW = `[data-tour="${DashboardTourAnchor.Models}"]`;
const SESSIONS_CARD = `[data-tour="${DashboardTourAnchor.Sessions}"]`;
/**
 * Recent Sessions renders inside a LATER SIBLING of the row it is anchored
 * under, within that row's `Reveal` wrapper (`DashboardBody`): the `mt-5`
 * spacer is the sibling and the anchored card is its child. The selector reads
 * that placement off the DOM the shell actually emits.
 */
const SESSIONS_UNDER_STATS = `${STATS_ROW} ~ * ${SESSIONS_CARD}`;
const SESSIONS_UNDER_ACTIVITY = `${ACTIVITY_ROW} ~ * ${SESSIONS_CARD}`;

/** The heatmap's own empty copy — the card the shipped build drew. */
const HEATMAP_EMPTY_COPY = "No activity in range yet";
/** Two models, so the settled-section anchor draws a deterministic band count. */
const MODELS = ["claude-opus-4-5", "gpt-5.4"] as const;
const DATES = ["2026-05-14", "2026-05-15", "2026-05-16"] as const;

test.describe("Dashboard absent-series rows (ISS-9993)", () => {
  test("drops the activity and autonomy rows the cloud did not send, and re-anchors Recent Sessions", async () => {
    test.setTimeout(300_000);

    // Empty harness homes: the boot collectors ingest nothing, so the local
    // store holds no turn buckets for either overlay to splice in.
    const dirs = makeSeededSessionsDirs("desktop-iss9993");
    const absent = await startDashboardCloudServer({ heatmap: false });
    const present = await startDashboardCloudServer({ heatmap: true });

    try {
      await initializeDesktopProfileSchema(dirs.userDataDir);
      await waitForBranchesSchema(dirs.userDataDir);

      // Launch 2 — heatmap ABSENT.
      const dropped = await launchCloudDashboard(dirs, absent.origin, true);
      try {
        await openCloudDashboard(dropped.page);

        // The rows do not exist: no card, no skeleton, no grid slot.
        await expect(dropped.page.locator(ACTIVITY_ROW)).toHaveCount(0);
        await expect(dropped.page.locator(AUTONOMY_ROW)).toHaveCount(0);
        // And the activity row did not degrade to the heatmap's own empty
        // state — the card the shipped build drew for a series it never had.
        await expect(dropped.page.getByText(HEATMAP_EMPTY_COPY)).toHaveCount(0);
        // Recent Sessions followed the rows: under `stats`, not under a row
        // that is not there — which would have dropped the card with it.
        await expect(dropped.page.locator(SESSIONS_CARD)).toHaveCount(1);
        await expect(dropped.page.locator(SESSIONS_UNDER_STATS)).toHaveCount(1);

        // The tour's skipped beat is NOT walked here any more, and this is a
        // coverage REDUCTION rather than a retired contract — say so rather
        // than let the gap go unrecorded. The walk opened the run by pressing
        // the header Tour control, which ISS-10929 retired; this profile marks
        // the tour seen and this is its second launch, so the first-launch arm
        // — now the tour's only door — cannot supply a run here. The contract
        // itself still holds and keeps direct coverage one layer down, over the
        // resolver that decides it: `resolveDashboardTourSteps` "drops the step
        // for an absent anchor rather than skipping it at render", and the
        // rendered indicator "shows five dots, not six with a gap, when
        // `activity` is absent" (packages/app/onboarding/components/
        // dashboard-tour/__tests__/resolve-dashboard-tour-steps.test.tsx).
        // ISS-11134 tracks restoring an end-to-end walk if a replay affordance
        // returns.

        expect(dropped.pageErrors).toEqual([]);
      } finally {
        await dropped.cleanup();
      }

      // Launch 3 — heatmap PRESENT, same session, same (empty) local store.
      const kept = await launchCloudDashboard(dirs, present.origin);
      try {
        await openCloudDashboard(kept.page);

        await expect(kept.page.locator(ACTIVITY_ROW)).toHaveCount(1);
        await expect(kept.page.locator(SESSIONS_UNDER_ACTIVITY)).toHaveCount(1);
        await expect(kept.page.locator(SESSIONS_UNDER_STATS)).toHaveCount(0);
        // Still absent: the cloud never sends it, and there is no local
        // series to fill it. Launch 2's drop was the rule, not a broken page.
        await expect(kept.page.locator(AUTONOMY_ROW)).toHaveCount(0);

        await kept.page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-absent-series-rows.png"),
        });
        expect(kept.pageErrors).toEqual([]);
      } finally {
        await kept.cleanup();
      }
    } finally {
      await absent.close();
      await present.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * Launch the signed-in profile against one cloud stand-in, on a coherent
 * consent record so the read source resolves to the cloud (ISS-6972's seed,
 * for the same reason: an incoherent one falls back to the local store and the
 * Local engine's always-present series would render every row).
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
            name: "ISS-9993 Cloud E2E",
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

/**
 * Open the Dashboard reading the CLOUD, and settle it on the Agents section.
 *
 * The cloud mode is asserted first so every row assertion is graded
 * against the mode it is written for. `ROW_SECTIONS` maps both `models` and
 * `autonomy` to `InsightsSection.Agents`, so a painted model chart proves that
 * section has resolved — the missing autonomy row is then a dropped row, not a
 * still-loading skeleton. Recharts animates areas in, so this gates on a
 * retrying count before anything else is read.
 */
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
  // ISS-9996: authenticated Cloud mode reads the workspace, not this device.
  const sessions = page.locator(SESSIONS_CARD);
  await expect(
    sessions.getByText(DESKTOP_SYNCED_SESSIONS_TITLE, { exact: true })
  ).toBeVisible();
  await expect(
    sessions.getByText(DESKTOP_SYNCED_SESSIONS_DESCRIPTION, { exact: true })
  ).toBeVisible();
  await expect(
    sessions.getByText(DESKTOP_RECENT_SESSIONS_TITLE, { exact: true })
  ).toHaveCount(0);
  await expect(
    sessions.getByText(WEB_RECENT_SESSIONS_TITLE, { exact: true })
  ).toHaveCount(0);
}

type DashboardCloudServer = {
  close: () => Promise<void>;
  origin: string;
};

/**
 * A bounded stand-in for the authenticated cloud routes the Dashboard reads.
 * `heatmap` is the ONE thing the two launches disagree on. The session mint is
 * delegated to `routeDesktopSessionRefresh` rather than copied, so one origin
 * mints the session for the shared access token.
 */
async function startDashboardCloudServer({
  heatmap,
}: {
  heatmap: boolean;
}): Promise<DashboardCloudServer> {
  const server = createServer((request, response) => {
    routeDashboardRequest(request, response, heatmap);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The dashboard cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, rejectClose) => {
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

function routeDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  heatmap: boolean
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  const pathname = new URL(request.url ?? "/", CLOUD_REQUEST_ORIGIN).pathname;
  if (request.method !== "GET") {
    writeCloudNotFound(response);
    return;
  }
  // A non-zero total, or the body short-circuits to its empty state and no row
  // renders at all.
  if (pathname === "/agent-sessions") {
    writeCloudResult(response, workspaceSessions());
    return;
  }
  // All three sections must RESOLVE, or the body holds its loading treatment.
  if (pathname === "/insights/delivery") {
    writeCloudResult(response, deliveryInsights());
    return;
  }
  if (pathname === "/insights/utilization") {
    writeCloudResult(response, utilizationInsights(heatmap));
    return;
  }
  if (pathname === "/insights/agents") {
    writeCloudResult(response, agentsInsights());
    return;
  }
  writeCloudNotFound(response);
}

function workspaceSessions(): AgentSessionListResponse {
  return {
    items: [sessionListRow({ name: "ISS-9993 cloud seed" })],
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

/**
 * The Utilization payload, with or without the heatmap. Without it is what an
 * older cloud route returns (the field is additive); with it, one bucket is
 * enough — `EventActivityHeatmap` draws when it has at least one cell.
 */
function utilizationInsights(heatmap: boolean): UtilizationInsightsResponse {
  return {
    charts: {
      eventActivity: EMPTY_TIME_SERIES,
      reviewQueue: [],
      ...(heatmap ? { activityHeatmap: activityHeatmap() } : {}),
    },
    kpis: [],
  };
}

function activityHeatmap(): ActivityHeatmap {
  return {
    days: [...DATES],
    cells: [{ day: DATES[0], hour: 9, human: 3, agent: 1 }],
  };
}

/** The cloud Agents payload: never an `autonomyTrend`, with a models series. */
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
