import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
/**
 * ISS-6002 regression, through the launched app: the Dashboard must not read a
 * pre-readiness zero as an empty install.
 *
 * The shipped bug was an ORDERING bug between two independent main-process
 * answers, and the renderer suite cannot reach it — those tests inject the
 * readiness hook and the session read as separate mocks, so they never exercise
 * the IPC → source-gate sequencing that produced it. Here the whole chain is
 * real: the `ipcMain` handlers, the preload bridge, the readiness probe and its
 * 500ms self-poll, the read gate, the react-query session poll, and the mounted
 * Dashboard. Only the SOURCE is held down (see
 * `helpers/local-session-source-gate-preload.cjs`), because the window it holds
 * open is a boot race that closes on its own within seconds.
 *
 * The dashboard skeleton must remain while a successful session read is still
 * a pre-readiness zero, then resolve once the source proves it can serve rows.
 * PR #7531 retires the synthetic 75% progress cards; the readiness contract
 * remains on the dashboard body.
 *
 * The second describe is the ISS-6972 companion: the zero is allowed, but a
 * CLOUD zero may not be called an empty Mac. Same surface, same empty state, the
 * other half of the question — ISS-6002 owns whether the count may be shown,
 * ISS-6972 owns what it may be called — so it rides this spec rather than a
 * parallel one.
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
import { expect, test } from "@playwright/test";
import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session.ts";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  TimeSeries,
  UtilizationInsightsResponse,
} from "@repo/api/src/types/insights.ts";
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
  launchDesktopApp,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { openSeedClient } from "./helpers/desktop-seed-core";
import {
  readLocalSessionSourceGateStats,
  releaseLocalSessionSource,
} from "./helpers/local-session-source-gate";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";

const EMPTY_STATE_TEXT = "No agent sessions yet";
const ZERO_SESSIONS_TEXT = /0 sessions/;
const READ_TIMEOUT_MS = 30_000;

test.describe("Dashboard pre-readiness zero (ISS-6002)", () => {
  test("holds the loading treatment until the local source can serve rows", async () => {
    const dirs = makeSeededSessionsDirs("desktop-iss6002");
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: seededSessionsEnv(dirs),
        localSessionSourceGate: true,
        userDataDir: dirs.userDataDir,
      });
      cleanup = launched.cleanup;
      const { app, page, pageErrors } = launched;

      await gotoNav(page, "dashboard");
      await expect(
        page.getByRole("heading", {
          exact: true,
          level: 1,
          name: DASHBOARD_HEADING,
        })
      ).toBeVisible({ timeout: READ_TIMEOUT_MS });

      const dashboardSkeletons = page
        .getByTestId("desktop-content-viewport")
        .locator('[data-slot="skeleton"]');
      await expect(dashboardSkeletons.first()).toBeVisible({
        timeout: READ_TIMEOUT_MS,
      });

      await expect
        .poll(
          async () =>
            (await readLocalSessionSourceGateStats(app))
              .heldZeroSessionListReads,
          {
            message:
              "session-list read should complete with total 0 before releasing the held source",
            timeout: READ_TIMEOUT_MS,
          }
        )
        .toBeGreaterThan(0);

      // A completed zero read must not resolve the body before source readiness.
      await expect(dashboardSkeletons.first()).toBeVisible();
      await expect(page.getByText(EMPTY_STATE_TEXT)).toHaveCount(0);
      await expect(page.getByText(ZERO_SESSIONS_TEXT)).toHaveCount(0);

      // The source comes up. The count is now worth something — and on this
      // deliberately empty profile it is a real zero, so the page resolves to
      // the empty state instead of holding the skeleton forever.
      const heldProbes = await releaseLocalSessionSource(app);
      expect(heldProbes).toBeGreaterThan(0);

      await expect(page.getByText(EMPTY_STATE_TEXT)).toBeVisible({
        timeout: READ_TIMEOUT_MS,
      });
      await expect(dashboardSkeletons).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await cleanup?.();
      } finally {
        cleanupSeededSessionsDirs(dirs);
      }
    }
  });
});

/**
 * ISS-6972 regression, through the launched app: a device reading an EMPTY cloud
 * workspace over a POPULATED local database must not be told this Mac is empty.
 *
 * The shipped defect, reproduced on stage: a freshly signed-in device read a
 * workspace holding nothing yet and rendered "No agent sessions yet … computed
 * locally, nothing uploaded" over a local store holding 219 sessions. The count
 * was honestly zero; the sentence was about a store the page had not read.
 *
 * The renderer suite (`dashboard/__tests__/dashboard-cloud-unproven-zero.test.tsx`)
 * mocks the mode provider and every data hook, so it pins the copy but cannot
 * fail for the way this reaches a user: the mode is not a prop, it is the product
 * of auth restore + connectivity + the persisted consent record, and the zero
 * comes from the cloud transport rather than the local store. Everything in that
 * chain is real here — the shipped auth restore, the persisted consent answer,
 * the cloud IPC transport, the shared HTTP source and the mounted Dashboard —
 * and the only thing held down is the cloud itself, a bounded local stand-in that
 * answers the session list with an honest empty workspace.
 *
 * Non-vacuity: the read-source badge is asserted to read `cloud` BEFORE the copy
 * is graded, so a launch that silently fell back to Local mode (an incoherent
 * consent seed, an auth restore that never landed) fails on the mode rather than
 * passing on a local empty state that says the same words for the right reason.
 * And the local store is seeded and verified non-empty, so this is the shipped
 * scenario — a cloud zero standing over local rows — not an empty machine.
 */
test.describe("Dashboard cloud empty state (ISS-6972)", () => {
  test("names the workspace, not this Mac, when the cloud is empty", async () => {
    test.setTimeout(240_000);

    // Empty harness homes: the boot collectors must ingest nothing, so the only
    // rows the local store holds are the ones seeded below.
    const dirs = makeSeededSessionsDirs("desktop-iss6972");
    const server = await startEmptyWorkspaceCloudServer();

    try {
      await initializeDesktopProfileSchema(dirs.userDataDir);
      await waitForBranchesSchema(dirs.userDataDir);

      // Seed the local store while the app is DOWN (no cross-process WAL
      // contention). These rows are the half of the defect the copy lied about.
      await seedSessionsList(dirs.userDataDir, LOCAL_SESSION_SEEDS);
      await expectLocalSessionsSeeded(dirs.userDataDir);

      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          seedDashboardStorage: true,
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: CLOUD_PROFILE_ID,
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              // A COHERENT consent record, bound to the org this device signs into
              // — the third term of the read-source rule. Seeded with its level,
              // because the settings migration re-derives both from the
              // connectivity flags when `dataSyncLevel` is absent, which would put
              // this launch back on the local store and grade the wrong copy.
              dataSyncLevel: "full",
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  id: CLOUD_PROFILE_ID,
                  name: "ISS-6972 Cloud E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
              syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
              syncObservabilityTier: "full",
            });
          },
          cloudReadReadiness: drainedCloudReadReadiness(),
          env: seededSessionsEnv(dirs, {
            CL_AUTH_API_ORIGIN: server.origin,
          }),
          userDataDir: dirs.userDataDir,
        }
      );

      try {
        await expect
          .poll(
            () => page.evaluate(() => window.desktopApi.getDesktopAuthState()),
            { timeout: READ_TIMEOUT_MS }
          )
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

        // The empty surface has RESOLVED, gated on the one card whose copy does
        // NOT vary by read source.
        //
        // ISS-10929 retired the Local/Cloud pill this used to read, and its
        // first replacement was wrong in a way worth recording:
        // the Recent Sessions card's synced title is drawn by the POPULATED body
        // (`first-launch-dashboard.tsx`), and this case is the EMPTY one —
        // `DashboardBody` returns `DashboardEmptySurface` instead, whose Recent
        // Sessions card is titled plain "Recent Sessions". That witness can
        // never resolve here, which is why it worked for the two populated
        // specs fixed alongside it and not for this one.
        //
        // Nothing cloud-only stands in its place, ON PURPOSE. In the empty
        // state the only copy that varies by read source is the very copy this
        // case exists to grade, so a "mode gate" drawn from it would restate
        // the answer instead of gating it. What remains is honest and
        // sufficient: the authenticated-org poll above is the INPUT
        // `DesktopAppCoreMode.Cloud` is derived from, this is the proof the
        // surface finished drawing, and the three assertions below are the
        // verdict.
        const resolvedEmptySurface = page.getByText(ACTIVITY_EMPTY_TITLE, {
          exact: true,
        });
        await expect(resolvedEmptySurface).toBeVisible({
          timeout: READ_TIMEOUT_MS,
        });
        await expect(resolvedEmptySurface).toHaveCount(1);

        // The zero is shown — ISS-4429 settled that a confirmed cloud zero is not
        // withheld. What it is CALLED is this spec's subject.
        await expect(page.getByText(WORKSPACE_EMPTY_TEXT)).toBeVisible({
          timeout: READ_TIMEOUT_MS,
        });
        // The regression: the shipped build titled this "No agent sessions yet"
        // and closed it with a claim only a local read can make — over the rows
        // seeded above.
        await expect(page.getByText(EMPTY_STATE_TEXT)).toHaveCount(0);
        await expect(page.getByText(LOCAL_EMPTY_CLAIM)).toHaveCount(0);
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      cleanupSeededSessionsDirs(dirs);
    }
  });
});

/**
 * `DashboardEmptySurface`'s Event Activity card, whose empty title is the same
 * on BOTH read sources — so waiting on it proves the surface rendered without
 * pre-judging which arm it drew.
 */
const ACTIVITY_EMPTY_TITLE = "No activity yet";
/** The workspace-scoped title only a cloud read may show (`DashboardEmptySurface`). */
const WORKSPACE_EMPTY_TEXT = "No sessions in this workspace yet";
/** The sentence only a LOCAL read may close with (`DashboardEmptySurface`). */
const LOCAL_EMPTY_CLAIM = /computed locally, nothing uploaded/;
const CLOUD_PROFILE_ID = "iss-6972-cloud-profile";
const CLOUD_REQUEST_ORIGIN = "http://127.0.0.1";

/**
 * A populated local store. Three rows rather than the defect report's 219: the
 * claim under test is "this Mac holds sessions the workspace has not seen", and
 * one row proves that as well as two hundred do.
 */
const LOCAL_SESSION_SEEDS = [
  { sessionId: "iss-6972-local-session-1", name: "ISS-6972 local seed 1" },
  { sessionId: "iss-6972-local-session-2", name: "ISS-6972 local seed 2" },
  { sessionId: "iss-6972-local-session-3", name: "ISS-6972 local seed 3" },
];

/**
 * Prove the seed landed before the launch that reads past it.
 *
 * Without this the spec's central fixture is unverified: a silently-empty local
 * store renders the SAME cloud copy, so every assertion below would still pass
 * while the "over a populated local database" half of the regression went
 * untested.
 */
async function expectLocalSessionsSeeded(userDataDir: string): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    const result = await client.execute(
      "SELECT COUNT(*) AS total FROM sessions"
    );
    expect(result.rows[0]?.total).toBe(LOCAL_SESSION_SEEDS.length);
  } finally {
    client.close();
  }
}

type EmptyWorkspaceCloudServer = {
  close: () => Promise<void>;
  origin: string;
};

/**
 * A bounded stand-in for the authenticated cloud routes the Dashboard reads,
 * every one of them answering an EMPTY workspace.
 *
 * Deliberately NOT folded into `startAuthenticatedBranchCloudServer`: that
 * fixture owns the Branch payloads, and the ONE thing both need — minting the
 * first-party session — is delegated to its exported
 * `routeDesktopSessionRefresh` rather than copied.
 */
async function startEmptyWorkspaceCloudServer(): Promise<EmptyWorkspaceCloudServer> {
  const server = createServer((request, response) => {
    routeEmptyWorkspaceRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The empty-workspace cloud stand-in did not bind.");
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

function routeEmptyWorkspaceRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  const pathname = new URL(request.url ?? "/", CLOUD_REQUEST_ORIGIN).pathname;
  if (request.method !== "GET") {
    writeCloudNotFound(response);
    return;
  }
  if (pathname === "/agent-sessions") {
    writeCloudResult(response, emptyWorkspaceSessions());
    return;
  }
  // The three insights sections must all RESOLVE, or the dashboard holds its
  // loading treatment and never renders an empty state at all.
  if (pathname === "/insights/delivery") {
    writeCloudResult(response, emptyDeliveryInsights());
    return;
  }
  if (pathname === "/insights/utilization") {
    writeCloudResult(response, emptyUtilizationInsights());
    return;
  }
  if (pathname === "/insights/agents") {
    writeCloudResult(response, emptyAgentsInsights());
    return;
  }
  writeCloudNotFound(response);
}

/** The honest empty workspace — the exact answer the shipped build mislabeled. */
function emptyWorkspaceSessions(): AgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

const EMPTY_TIME_SERIES: TimeSeries = { points: [], series: [] };

function emptyDeliveryInsights(): DeliveryInsightsResponse {
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

function emptyUtilizationInsights(): UtilizationInsightsResponse {
  return {
    charts: { eventActivity: EMPTY_TIME_SERIES, reviewQueue: [] },
    kpis: [],
  };
}

function emptyAgentsInsights(): AgentsInsightsResponse {
  return {
    charts: { modelBreakdown: [], modelUsageOverTime: EMPTY_TIME_SERIES },
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
