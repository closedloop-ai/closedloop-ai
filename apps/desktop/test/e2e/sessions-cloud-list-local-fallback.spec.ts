/**
 * PRD-728 / ISS-9608: launched-app proof for Desktop Sessions cloud-first
 * fallback. The renderer tests pin the composite adapter, but only this lane
 * proves the shipped auth restore, PostHog assignment, HTTP failure, local IPC
 * read, QueryClient, and mounted Sessions table remain connected.
 *
 * Outside the smoke subset deliberately: this regression does not need to gate
 * every main push. Build before running, then use the repository's displayless
 * Playwright harness.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import type { AgentSessionsPageData } from "@repo/api/src/types/agent-session";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import type { SharedAgentSessionsListRequest } from "../../src/shared/shared-agent-sessions-contract.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  drainedCloudReadReadiness,
  gotoNavSettled,
} from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import {
  seedSessionsList,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";
import {
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

// Pinned as a literal because package subpath imports abort the Electron suite
// under Playwright's ESM loader. The feature-flag registry test owns key drift.
const GRIDVIEW_ADOPTION_FLAG_KEY = "gridview-adoption";
const LOCAL_SESSION_ID = "55555555-5555-4555-8555-555555555572";
const LOCAL_SESSION_NAME = "Local fallback session";
const MOUNT_TIMEOUT_MS = 120_000;

test("cloud list failure renders the local fallback through the launched Desktop app", async () => {
  test.setTimeout(300_000);
  const dirs = makeSeededSessionsDirs("prd-728-cloud-local-fallback");
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: failSessionsList,
  });

  try {
    await initializeDesktopProfileSchema(dirs.userDataDir);
    await waitForBranchesSchema(dirs.userDataDir);
    await seedSessionsList(dirs.userDataDir, [
      { name: LOCAL_SESSION_NAME, sessionId: LOCAL_SESSION_ID },
    ]);

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (userDataDir) => {
        seedCloudSessionDetailProfile(userDataDir, server.origin, {
          [GRIDVIEW_ADOPTION_FLAG_KEY]: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: seededSessionsEnv(dirs, { CL_AUTH_API_ORIGIN: server.origin }),
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir: dirs.userDataDir,
    });

    try {
      await expect
        .poll(() =>
          page.evaluate(() => window.desktopApi.getDesktopAuthState())
        )
        .toMatchObject({
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          status: DesktopAuthStatus.Authenticated,
          userId: AUTHENTICATED_USER_ID,
        });
      await expect
        .poll(() =>
          page.evaluate(async (flagKey) => {
            const globalScope: object = window;
            const api: SessionsFallbackBridgeProbe = Reflect.get(
              globalScope,
              "desktopApi"
            );
            const readAssignment = api.getE2eSeededFeatureFlags;
            if (!readAssignment) {
              return false;
            }
            const assignment = await readAssignment();
            return (
              assignment?.resolved === true &&
              assignment.flags[flagKey] === true
            );
          }, GRIDVIEW_ADOPTION_FLAG_KEY)
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(async (sessionId) => {
            const globalScope: object = window;
            const api: SessionsFallbackBridgeProbe = Reflect.get(
              globalScope,
              "desktopApi"
            );
            const pageData = await api.agentSessionsApi.pageData({
              limit: 25,
              offset: 0,
              quality: "all",
            });
            return pageData.list.items.some(
              (session) => session.id === sessionId
            );
          }, LOCAL_SESSION_ID)
        )
        .toBe(true);
      const panel = await gotoNavSettled(page, "sessions");
      await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
      await expect(
        panel.getByRole("link", { name: LOCAL_SESSION_NAME })
      ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
      await expect(panel.getByTestId("read-source-badge")).toHaveCount(0);
      expect(
        server.requests.some(
          (request) =>
            request.method === "GET" &&
            request.pathname === "/agent-sessions" &&
            request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
        )
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

function failSessionsList(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const requestUrl = URL.parse(`http://127.0.0.1${request.url ?? "/"}`);
  if (request.method !== "GET" || requestUrl?.pathname !== "/agent-sessions") {
    return false;
  }
  response.statusCode = 503;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: "cloud list unavailable" }));
  return true;
}

type SessionsFallbackBridgeProbe = {
  agentSessionsApi: {
    pageData: (
      request?: SharedAgentSessionsListRequest
    ) => Promise<AgentSessionsPageData>;
  };
  getE2eSeededFeatureFlags?: () => Promise<DesktopFeatureFlagAssignment | null>;
};
