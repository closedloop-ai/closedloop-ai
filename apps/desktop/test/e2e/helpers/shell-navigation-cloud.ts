/**
 * The authenticated launch the v2 shell-sidebar specs share (ISS-9734, ISS-8361):
 * a first-party desktop session plus a stand-in cloud that answers the
 * navigation projection, so a v2 row is a LINK rather than the honest
 * "Unavailable" button a signed-out launch renders.
 *
 * TWO origins have to point at that stand-in, and they are set in different
 * places: the SETTINGS `apiOrigin` routes the data reads, while the first-party
 * session refresh reads the `CL_AUTH_API_ORIGIN` env override
 * (`src/shared/contracts.ts`). Seeding only the first leaves main refreshing
 * against production, and the app then renders a perfectly healthy shell whose
 * every row is an honest "Unavailable" — a signed-out failure that looks like a
 * sidebar bug.
 *
 * The rendered gate reads the `mergeE2eFeatureFlagAssignment` half of
 * `seedDesktopFeatureFlags`, which stands in for the PostHog assignment
 * `DesktopFeatureFlagProvider` resolves. There is no desktop registry entry to
 * add beside it (ISS-8024's local-registry cutover is retired) and no desktop
 * Labs toggle to pair with the key.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { Page } from "@playwright/test";
import type { DesktopSessionRecord } from "../../../src/main/session/desktop-session-store.js";
import { launchAuthenticatedDesktopApp } from "./authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectNotFound,
  rejectUnauthorized,
  routeDesktopSessionRefresh,
  seedAuthenticatedDesktopSession,
  writeApiResult,
} from "./branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./desktop-app";

/** Every destination this shell can offer, granted, so each row is a live link. */
const GRANTED_DESTINATION_STATUS = "ready";

/** Strips the leading `#` from the renderer's hash route. */
const LEADING_HASH = /^#/;

export type NavigationCloudServer = {
  readonly origin: string;
  readonly server: Server;
};

export type ShellSidebarLaunch = {
  readonly apiOrigin: string;
  readonly flags: Record<string, boolean>;
  /** Names the seeded profile, so a spec's launches are told apart in logs. */
  readonly profileId: string;
  readonly profileName: string;
  readonly userDataDir: string;
  /** Opt in only the first real subject; later launches restore their persisted session. */
  readonly sameProcessSessionSeed?: DesktopSessionRecord;
};

/** The renderer's current hash route, without the `#` or a query string. */
export async function currentHashRoute(page: Page): Promise<string> {
  const hash = await page.evaluate(() => globalThis.location.hash);
  return hash.replace(LEADING_HASH, "").split("?")[0];
}

/** Mint the first-party session a later {@link launchShellSidebarApp} reuses. */
export async function seedShellSidebarSession(
  userDataDir: string
): Promise<void> {
  const seedLaunch = await launchAuthenticatedDesktopApp({ userDataDir });
  try {
    await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
  } finally {
    await seedLaunch.cleanup();
  }
}

export async function launchShellSidebarApp({
  apiOrigin,
  flags,
  profileId,
  profileName,
  sameProcessSessionSeed,
  userDataDir,
}: ShellSidebarLaunch) {
  return await launchAuthenticatedDesktopApp({
    sameProcessSessionSeed,
    // The session-refresh origin, which the seeded settings below do NOT carry.
    env: { CL_AUTH_API_ORIGIN: apiOrigin },
    beforeLaunch: (launchUserDataDir) => {
      seedDesktopSettings(launchUserDataDir, {
        activeConfigId: profileId,
        apiOrigin,
        cloudConnectionEnabled: true,
        savedConfigs: [
          {
            apiOrigin,
            gatewayId: AUTHENTICATED_GATEWAY_ID,
            id: profileId,
            name: profileName,
            relayOrigin: "http://127.0.0.1:9",
            webAppOrigin: "http://127.0.0.1:3000",
          },
        ],
      });
      seedDesktopFeatureFlags(launchUserDataDir, flags);
    },
    cloudReadReadiness: drainedCloudReadReadiness(),
    userDataDir,
  });
}

/**
 * A stand-in cloud that mints the first-party session and answers the navigation
 * projection, granting exactly the destinations the shell asked about — so a
 * row that is a link here is one this shell requested and the server answered
 * for, never one the fixture volunteered.
 */
export async function startNavigationCloudServer(
  options: {
    extraRoutes?: (
      request: IncomingMessage,
      response: ServerResponse
    ) => boolean;
    staffIdentity?: boolean;
    featureFlags?: Record<string, boolean>;
  } = {}
): Promise<NavigationCloudServer> {
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    if (options.staffIdentity && routeStaffIdentity(request, response)) {
      return;
    }
    if (
      options.featureFlags &&
      routeFeatureFlags(request, response, options.featureFlags)
    ) {
      return;
    }
    if (options.extraRoutes?.(request, response)) {
      return;
    }
    if (!routeNavigationViewModel(request, response)) {
      rejectNotFound(response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Navigation view-model stand-in did not bind.");
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function routeFeatureFlags(
  request: IncomingMessage,
  response: ServerResponse,
  flags: Record<string, boolean>
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/desktop/feature-flags") {
    return false;
  }
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  writeApiResult(response, {
    userId: AUTHENTICATED_USER_ID,
    resolved: true,
    flags,
  });
  return true;
}

function routeStaffIdentity(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/desktop/identity") {
    return false;
  }
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  writeApiResult(response, {
    userId: AUTHENTICATED_USER_ID,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    email: "ada@closedloop.ai",
    firstName: "Ada",
    lastName: null,
    organizationName: null,
  });
  return true;
}

function routeNavigationViewModel(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" || url.pathname !== "/navigation/view-model") {
    return false;
  }
  // Granted only against the session's own bearer, so a row that is a link in
  // these specs is one the shell asked for as the signed-in user — never one a
  // stand-in volunteered to a request that carried no credential.
  if (
    request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
  ) {
    rejectUnauthorized(response);
    return true;
  }
  const destinations: Record<string, { status: string }> = {};
  for (const id of url.searchParams.getAll("destinations")) {
    destinations[id] = { status: GRANTED_DESTINATION_STATUS };
  }
  writeApiResult(response, {
    destinations,
    organizationId: "org-e2e",
    projectionStatus: "ready",
    standing: "member",
  });
  return true;
}
