import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
/**
 * ISS-10929 regression, through the LAUNCHED app: the Dashboard's
 * Me/Organization scope selector is present on an authenticated, online
 * profile, and selecting Organization actually MOVES THE READ.
 *
 * The scope toggle was retired by ISS-10929 and the operator ruled that
 * removal a regression on 2026-09-30, so the control was restored. The only
 * coverage that shipped with the restore was the renderer suite
 * (`__tests__/dashboard-scope-toggle.test.tsx`), which drives mocked insights
 * hooks and asserts the scope argument they were called with. That cannot see
 * the chain the user's click actually travels — `DashboardScopeControl` →
 * `useDashboardScope` → `DesktopInsightsProvider` (whose `availableScopes` is
 * the product of auth + connectivity, not a prop) → `createHttpInsightsReads`
 * → the IPC fetch bridge → the authenticated `/insights/*` routes — and a
 * toggle wired to nothing would still turn those mocks green. whitlockk asked for
 * this on #8213.
 *
 * So this spec never asserts the control's own pressed state. It asserts the
 * SCOPED READ, twice over, from two independent vantage points:
 *
 *   1. the request the app issued — the cloud stand-in records every
 *      `/insights/*` query string, and the `scope` parameter must move from
 *      `me` to `org`;
 *   2. the value that came back — the stand-in serves a DIFFERENT model series
 *      per scope (one model under `me`, two under `org`), so the rendered
 *      Models chart gains a second painted area that the personal-scope read
 *      cannot produce.
 *
 * Either one alone would be weaker than the pair: (1) proves the request
 * carried the scope but not that the answer reached the page, and (2) proves
 * the page re-rendered but not what it asked for. Both are anchored on the
 * one-model presence assertion taken first, so a Dashboard that rendered
 * nothing at all cannot satisfy the "no org read yet" half.
 *
 * Every visible string this spec locates comes from the module the control
 * renders it from (`DASHBOARD_SCOPE_LABEL`, `SCOPE_TOGGLE_OPTIONS`) — no copy
 * of "Scope", "Me" or "Organization" lives here.
 *
 * Outside the smoke subset on purpose (`test/AGENTS.md`): it is a targeted
 * regression on one surface, not a gate every PR must clear.
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
import {
  type AgentsInsightsResponse,
  type DeliveryInsightsResponse,
  InsightsScope,
  type TimeSeries,
  type UtilizationInsightsResponse,
} from "@repo/api/src/types/insights.ts";
import {
  DASHBOARD_SCOPE_LABEL,
  SCOPE_TOGGLE_OPTIONS,
} from "@repo/app/insights/components/overview/dashboard-scope-copy.ts";
import { DashboardTourAnchor } from "@repo/app/insights/components/overview/dashboard-tour-anchors.ts";
import { DESKTOP_SYNCED_SESSIONS_TITLE } from "@repo/app/insights/components/overview/recent-sessions-copy.ts";
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
const CHART_TIMEOUT_MS = 45_000;
const CLOUD_PROFILE_ID = "iss-10929-scope-cloud-profile";
const CLOUD_REQUEST_ORIGIN = "http://127.0.0.1";

const MODELS_ROW = `[data-tour="${DashboardTourAnchor.Models}"]`;
const MODELS_AREA = `${MODELS_ROW} .recharts-area`;

/**
 * The scope-dependent payload. One model under personal scope, two under org,
 * so the org answer is a value the `me` read CANNOT produce — which is what
 * makes the rendered chart evidence of the scoped read rather than of a
 * re-render.
 */
const MODELS_BY_SCOPE: Record<string, readonly string[]> = {
  [InsightsScope.Me]: ["claude-opus-4-5"],
  [InsightsScope.Org]: ["claude-opus-4-5", "gpt-5.4"],
};
const DATES = ["2026-05-14", "2026-05-15", "2026-05-16"] as const;

/** The toggle segment for each scope, named by the control's own option list. */
const ORG_OPTION = scopeOption(InsightsScope.Org);
const ME_OPTION = scopeOption(InsightsScope.Me);

type RecordedInsightsRead = { pathname: string; scope: string | null };

/**
 * The insights sections the TOGGLE drives. `/insights/utilization` is
 * deliberately excluded: `desktop-dashboard-page-viewed.tsx` issues its own
 * org-scoped Utilization read on mount for the session-volume analytics event,
 * so that path carries an `org` scope on every launch whatever the toggle says
 * and cannot witness this control. Delivery and Agents are read only through
 * `first-launch-dashboard.tsx`'s `scope`, which is what the toggle sets.
 */
const TOGGLE_DRIVEN_INSIGHTS_PATHS = [
  "/insights/delivery",
  "/insights/agents",
] as const;

test.describe("Dashboard Me/Organization scope read (ISS-10929)", () => {
  test("selecting Organization moves the insights read to org scope", async () => {
    test.setTimeout(300_000);

    const dirs = makeSeededSessionsDirs("desktop-iss10929-scope");
    const cloud = await startScopedDashboardCloudServer();

    try {
      await initializeDesktopProfileSchema(dirs.userDataDir);
      await waitForBranchesSchema(dirs.userDataDir);

      // Launch 2 — the real Dashboard, signed in and online, reading the cloud.
      const { page, pageErrors, cleanup } = await launchCloudDashboard(
        dirs,
        cloud.origin,
        true
      );
      try {
        await openCloudDashboard(page);

        // PRESENCE FIRST. The personal-scope answer is on screen: exactly one
        // painted model area. Every absence assertion below is graded against
        // this, so a Dashboard that rendered nothing cannot satisfy them.
        await expect(page.locator(MODELS_AREA)).toHaveCount(
          MODELS_BY_SCOPE[InsightsScope.Me].length,
          { timeout: CHART_TIMEOUT_MS }
        );

        // The restored control is mounted, located through the label the
        // control itself renders.
        const scopeGroup = page.getByRole("radiogroup", {
          name: DASHBOARD_SCOPE_LABEL,
        });
        await expect(scopeGroup).toBeVisible();
        const meSegment = scopeGroup.getByRole("radio", {
          exact: true,
          name: ME_OPTION.label,
        });
        const orgSegment = scopeGroup.getByRole("radio", {
          exact: true,
          name: ORG_OPTION.label,
        });
        await expect(meSegment).toBeVisible();
        await expect(orgSegment).toBeVisible();

        // What the app ASKED for so far: personal scope, and no org read yet.
        // One query, both halves — the `me` term is what proves the reads are
        // being recorded at all.
        const beforeClick = insightsScopes(cloud.reads);
        expect(beforeClick).toContain(InsightsScope.Me);
        expect(beforeClick).not.toContain(InsightsScope.Org);

        await orgSegment.click();

        // 1. The REQUEST moved. Not the toggle's pressed state — the query
        //    string the shipped read path put on the wire.
        await expect
          .poll(() => insightsScopes(cloud.reads), {
            timeout: READ_TIMEOUT_MS,
          })
          .toContain(InsightsScope.Org);

        // 2. The ANSWER arrived and rendered: the second model area exists
        //    only in the org payload, so a control wired to nothing — or one
        //    whose scope is clamped back to `me` — cannot reach this count.
        await expect(page.locator(MODELS_AREA)).toHaveCount(
          MODELS_BY_SCOPE[InsightsScope.Org].length,
          { timeout: CHART_TIMEOUT_MS }
        );

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("dashboard-scope-organization-read.png"),
        });
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await cloud.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/** The control's own segment for a scope — never a literal spelled here. */
function scopeOption(scope: InsightsScope): { label: string; value: string } {
  const option = SCOPE_TOGGLE_OPTIONS.find(
    (candidate) => candidate.value === scope
  );
  if (!option) {
    throw new Error(`SCOPE_TOGGLE_OPTIONS has no segment for "${scope}".`);
  }
  return option;
}

/** The `scope` parameter of every toggle-driven insights read so far. */
function insightsScopes(reads: RecordedInsightsRead[]): string[] {
  return reads
    .filter((read) =>
      TOGGLE_DRIVEN_INSIGHTS_PATHS.some((path) => path === read.pathname)
    )
    .map((read) => read.scope ?? "");
}

/**
 * Open the Dashboard on the CLOUD read source.
 *
 * The mode is witnessed first so every assertion is graded against the mode it
 * is written for: the scope toggle is offered only when the insights source
 * advertises `org`, which on desktop means authenticated AND online. The
 * Recent Sessions card's cloud-only title is that witness (ISS-10929 retired
 * the read-source pill this would otherwise gate on).
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
  await expect(
    page.getByText(DESKTOP_SYNCED_SESSIONS_TITLE, { exact: true })
  ).toBeVisible({ timeout: READ_TIMEOUT_MS });
}

/** The signed-in profile, pointed at one cloud stand-in, on a coherent consent record. */
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
            name: "ISS-10929 Scope Cloud E2E",
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

type ScopedDashboardCloudServer = {
  close: () => Promise<void>;
  origin: string;
  /** Every `/insights/*` read, in arrival order, with its `scope` parameter. */
  reads: RecordedInsightsRead[];
};

/**
 * A bounded stand-in for the authenticated cloud routes the Dashboard reads,
 * which answers the Agents section DIFFERENTLY per scope and records the scope
 * of every insights read. The session mint is delegated to
 * `routeDesktopSessionRefresh` rather than copied, so one origin mints the
 * session for the shared access token.
 */
async function startScopedDashboardCloudServer(): Promise<ScopedDashboardCloudServer> {
  const reads: RecordedInsightsRead[] = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", CLOUD_REQUEST_ORIGIN);
    if (requestUrl.pathname.startsWith("/insights/")) {
      reads.push({
        pathname: requestUrl.pathname,
        scope: requestUrl.searchParams.get("scope"),
      });
    }
    routeDashboardRequest(request, response, requestUrl);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The scoped dashboard cloud stand-in did not bind.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    reads,
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
  requestUrl: URL
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (request.method !== "GET") {
    writeCloudNotFound(response);
    return;
  }
  const pathname = requestUrl.pathname;
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
    writeCloudResult(response, utilizationInsights());
    return;
  }
  if (pathname === "/insights/agents") {
    writeCloudResult(
      response,
      agentsInsights(requestUrl.searchParams.get("scope"))
    );
    return;
  }
  writeCloudNotFound(response);
}

function workspaceSessions(): AgentSessionListResponse {
  return {
    items: [sessionListRow({ name: "ISS-10929 scope seed" })],
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

function utilizationInsights(): UtilizationInsightsResponse {
  return {
    charts: { eventActivity: EMPTY_TIME_SERIES, reviewQueue: [] },
    kpis: [],
  };
}

/**
 * The Agents payload for the requested scope. An unrecognised scope falls back
 * to the personal series, so a read that lost its scope parameter renders the
 * `me` answer and the org assertion fails — rather than passing on a default.
 */
function agentsInsights(scope: string | null): AgentsInsightsResponse {
  const models =
    MODELS_BY_SCOPE[scope ?? ""] ?? MODELS_BY_SCOPE[InsightsScope.Me];
  return {
    charts: {
      modelBreakdown: [],
      modelUsageOverTime: {
        series: models.map((model) => ({ key: model, label: model })),
        points: DATES.map((date, dayIndex) => ({
          date,
          values: Object.fromEntries(
            models.map((model, index) => [
              model,
              Number(((models.length - index) * (dayIndex + 2)).toFixed(2)),
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
