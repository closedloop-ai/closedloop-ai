/**
 * ISS-9701 — the launched-app regression for stale-token recovery on the
 * DESKTOP adapter.
 *
 * The recovery is one behavior spread across four processes' worth of seams:
 * the renderer's shared `useApiClient` sees the 401 and retries, but the
 * credential it retries with is not its own — `getToken()` here resolves an
 * opaque sentinel and the real access token never leaves the main process. What
 * makes the retry mean anything on desktop is the cloud-API bridge reporting the
 * rejection to `DesktopSessionManager`, which drops the refused token so the
 * next read mints a new one. Every unit suite covering this stubs one end or the
 * other: the bridge suite hands `onUnauthorized` a counter, the renderer suite
 * hands `getToken` a fake, and the wiring suite reads the composition root as
 * source. None of them runs the chain, so all three stay green against an app
 * that recovers nothing.
 *
 * This spec launches the real Electron app, restores a real session through the
 * production refresh lane, and points it at a cloud that refuses the first
 * access token exactly the way an aged-out one is refused. What it asserts is
 * the DATA outcome, not the absence of an error: the surface renders the state
 * it could only have reached by a successful retry, the cloud saw the second
 * request carry a DIFFERENT bearer than the first, and the whole recovery cost
 * exactly one extra token mint.
 *
 * WHICH SURFACE, and why it moved (ISS-10195). This drove Settings → Account's
 * GitHub row. Retiring the workspace-experience gate made Settings the v2 panel
 * modal and left the legacy Account tab mounted by nothing, so that row is not
 * reachable — no v2 panel owns `account` (ISS-10286). The subject here was never
 * GitHub: it is the token re-mint chain, and the read only had to be one whose
 * rendered result is unreachable without a successful authenticated call. Settings
 * v2 → Connected Devices is exactly that — its body mounts only on a capability
 * read that RESOLVED, so the sync-policy section below cannot appear over a
 * refused token. Every ISS-9701 assertion is carried over unchanged; only the
 * route the refusal lands on, and the element that proves recovery, moved.
 *
 * The web twin is `apps/app/app/(authenticated)/components/__tests__/
 * workspace-auth-guard-stale-token.test.tsx`, which asserts the same recovery
 * against the session-expired card. Neither stands in for the other: the card is
 * an `apps/app` surface the desktop renderer never mounts, and the token
 * substitution proved here has no web analogue — the web shell carries the real
 * Clerk JWT itself (`apps/desktop/AGENTS.md`, "Cross-surface work covers both
 * adapters").
 *
 * WHAT THIS SPEC DOES NOT COVER, deliberately. The burst it produces is
 * CONCURRENT — the surface's reads all leave together — so the manager's
 * pre-existing single-flight refresh already collapses it, and the mint count
 * below stays at two whether or not invalidation is scoped to the refused token.
 * The ORDERING case, where a 401 lands after another request has already
 * refreshed, cannot be forced from here: making it deterministic means holding
 * one of the surface's reads open until another completes, and which read feeds
 * which element is an incidental property of the renderer, not a contract — the
 * attempt deadlocks on the panel's own capability query. That ordering is covered
 * deterministically where the seam is addressable instead:
 * `desktop-session-manager.test.ts` ("a late 401 for a superseded token…") for
 * this process, and
 * `packages/app/shared/api/__tests__/use-api-client-stale-token-retry.test.tsx`
 * for the renderer's own recovery.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// `.ts` extension deliberately: a RUNTIME import of a `@repo/*` subpath
// resolves without one inside the app but not under the spec loader, and a bad
// resolution aborts the whole suite at load time (`apps/desktop/test/AGENTS.md`).
import { SettingsPanelId } from "@repo/api/src/types/settings-panel.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
} from "./helpers/branch-details-authenticated-cloud";
import {
  openSettingsPanel,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  memberSettingsViewModel,
  SETTINGS_DEVICE_PANELS_FLAG_KEY,
} from "./helpers/settings-v2-connected-devices-cloud";

const LABEL = "desktop-stale-token-recovery";
const WEB_APP_ORIGIN = "http://127.0.0.1:3000";
const SESSION_REFRESH_PATH = "/desktop/session/refresh";
const VIEW_MODEL_PATH = "/settings/view-model";
const BROWSER_SESSIONS_PATH = "/settings/browser-sessions";
const COMPUTE_TARGETS_PATH = "/compute-targets";
const API_KEY_IDENTITY_PATH = "/me";
const SOCKET_HANDSHAKE_PATH = "/socket.io/";
/**
 * The Connected Devices panel BODY, which the shell mounts only when the
 * capability read resolved Ready. Over a refused token the shell renders its
 * CapabilityError screen instead and this element does not exist — which is what
 * makes it a statement about recovery rather than about the page loading.
 */
const SYNC_SECTION_SELECTOR = "[data-this-device-sync-policy]";
const MOUNT_TIMEOUT_MS = 45_000;
const TOKEN_EXPIRY = "2027-08-07T00:00:00.000Z";
const UNAUTHORIZED_STATUS = 401;

type StaleTokenCloudServer = {
  close: () => Promise<void>;
  origin: string;
  /** Bearers presented to first-party session routes, in request order. */
  statusBearers: string[];
  /** How many times the production refresh lane minted an access token. */
  refreshCount: () => number;
  refusedAttempts: () => number;
};

test("ISS-9701: a refused access token is re-minted and the read recovers", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), `${LABEL}-claude-`));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${LABEL}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${LABEL}-udd-`));
  const server = await startStaleTokenCloudServer();

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: `${LABEL}-profile`,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: `${LABEL}-profile`,
              name: "Stale Token Recovery E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: WEB_APP_ORIGIN,
            },
          ],
        });
        // The Connected Devices panel is registered only behind this key, so
        // without it the shell resolves the deep link to `unknown` and the
        // marker below could never appear — flag-off, not token-refused.
        seedDesktopFeatureFlags(launchUserDataDir, {
          [SETTINGS_DEVICE_PANELS_FLAG_KEY]: true,
        });
      },
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
      const shell = await openSettingsPanel(page, {
        panel: SettingsPanelId.ConnectedDevices,
        timeoutMs: MOUNT_TIMEOUT_MS,
      });

      // THE OUTCOME. The cloud refused the token this panel's capability read
      // first carried, and the shell mounts a panel BODY only for a capability
      // read that resolved Ready — so the only way this section exists is a
      // retry that carried a different token, minted because the bridge
      // reported the rejection.
      await expect(shell.locator(SYNC_SECTION_SELECTOR)).toBeVisible({
        timeout: MOUNT_TIMEOUT_MS,
      });

      // Anti-vacuity: the refused token really did go out, more than once, so
      // the badge above was reached THROUGH the rejection rather than around
      // it. A surface that somehow read this route only once would make every
      // assertion below a statement about nothing.
      const refusedAttempts = server.refusedAttempts();
      expect(refusedAttempts).toBeGreaterThan(1);

      // ...and the surface recovered by re-minting, not by re-sending. Exactly
      // two credentials were ever presented: the one that was refused and the
      // one that replaced it.
      expect(server.statusBearers.at(-1)).not.toBe(server.statusBearers[0]);
      expect(new Set(server.statusBearers).size).toBe(2);

      // The cost of that recovery. Every rejected request in the burst shares
      // one mint on top of the one the restore lane already performed at boot.
      expect(server.refreshCount()).toBe(2);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

/**
 * A cloud that refuses the FIRST access token it ever minted, and accepts every
 * later one — the shape of a token that aged out while the app held it.
 *
 * The refusal is keyed on the token rather than on a request ordinal on purpose:
 * an ordinal would answer 401 to whatever arrived first and 200 to whatever
 * arrived second, which is satisfied by an app that re-sent the same refused
 * credential. Only the token identity can tell recovery from repetition.
 *
 * It refuses that token on EVERY first-party session route rather than on one, which
 * is what keeps `refusedAttempts` a real count: the Connected Devices panel
 * issues its reads concurrently, so the refused credential goes out several
 * times and the single-flight refresh collapses them into one mint. A
 * single-route refusal would present the refused token exactly once and make
 * that assertion unfalsifiable.
 *
 * This mints its own tokens instead of delegating to `routeDesktopSessionRefresh`
 * (the shared fixture), which returns one FIXED access token — under that helper
 * a re-mint is indistinguishable from a re-send.
 */
function startStaleTokenCloudServer(): Promise<StaleTokenCloudServer> {
  const statusBearers: string[] = [];
  let minted = 0;
  let refusedToken: string | null = null;

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    if (request.method === "POST" && pathname === SESSION_REFRESH_PATH) {
      minted += 1;
      const accessToken = `stale-token-recovery-access-${minted}`;
      // The first token the app ever holds is the one that will be refused.
      refusedToken ??= accessToken;
      writeJson(response, {
        accessToken,
        accessTokenExpiresAt: TOKEN_EXPIRY,
        refreshToken: `stale-token-recovery-refresh-${minted}`,
        refreshTokenExpiresAt: TOKEN_EXPIRY,
        userId: AUTHENTICATED_USER_ID,
        organizationId: AUTHENTICATED_ORGANIZATION_ID,
      });
      return;
    }

    const bearer = bearerOf(request);
    // ISS-9701: API-key identity reads and anonymous socket handshakes are not
    // session-token attempts; their HTTP behavior remains unchanged below.
    if (
      request.method !== "GET" ||
      (pathname !== API_KEY_IDENTITY_PATH && pathname !== SOCKET_HANDSHAKE_PATH)
    ) {
      statusBearers.push(bearer);
    }
    if (bearer === refusedToken) {
      refuse(response);
      return;
    }

    if (request.method === "GET" && pathname === VIEW_MODEL_PATH) {
      writeJson(response, { success: true, data: memberSettingsViewModel() });
      return;
    }
    if (request.method === "GET" && pathname === BROWSER_SESSIONS_PATH) {
      writeJson(response, {
        success: true,
        data: {
          currentSessionKnown: false,
          limit: 20,
          offset: 0,
          sessions: [],
          totalCount: 0,
        },
      });
      return;
    }
    if (request.method === "GET" && pathname === COMPUTE_TARGETS_PATH) {
      writeJson(response, { success: true, data: [] });
      return;
    }

    response.statusCode = 404;
    writeJson(response, { success: false, error: "not found" });
  });

  return new Promise<StaleTokenCloudServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("stale-token cloud server did not bind.");
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        statusBearers,
        refreshCount: () => minted,
        refusedAttempts: () =>
          statusBearers.filter((bearer) => bearer === refusedToken).length,
        close: () => closeServer(server),
      });
    });
  });
}

function refuse(response: ServerResponse): void {
  response.statusCode = UNAUTHORIZED_STATUS;
  writeJson(response, { success: false, error: "Unauthorized" });
}

function bearerOf(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolve();
    });
  });
}
