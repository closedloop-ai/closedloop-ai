/**
 * Launched-app regression for the operator report of 2026-10-10: "once github
 * connects; we need to go back to the desktop and complete first time
 * onboarding, currently it redirects
 * https://app.closedloop.ai/new-dmg-org-onboarding/dashboard?github=connected
 * and doesn't bring the desktop back into focus".
 *
 * The connect finishes on the web linking page, which has no channel back to
 * Desktop. The fix is in the main process: the onboarding GitHub step asks for
 * `returnToDesktop`, and main watches the account's GitHub connection after
 * opening the browser, activating the app (`app.focus({ steal: true })`, the
 * ISS-10412 sign-in return) once it reads connected after the hand-off.
 *
 * Driven through the real built app, preload, auth restore and IPC, against a
 * local cloud stand-in whose GitHub status flips to connected once the browser
 * hand-off has happened — the moment the web page would have finished the link.
 * `shell.openExternal` and `app.focus` are recorded in main rather than run, so
 * the spec opens no browser and steals no focus from the machine running it.
 *
 * Would fail before the change: nothing in Desktop re-read the connection
 * after the hand-off, so `app.focus` was never called.
 *
 * The window is REVEALED (`revealWindow`), because a suppressed window's
 * activation path returns before `app.focus` by design (`isWindowRevealSuppressed`).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import {
  GitHubDataConnectionSource,
  type GitHubIntegrationStatus,
} from "@repo/api/src/types/github.ts";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided.ts";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence.ts";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase.ts";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience.ts";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectUnauthorized,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoNavSettled,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  installOpenExternalSpy,
  openedUrls,
} from "./helpers/open-external-spy";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

/**
 * Re-typed rather than imported, for the reason
 * `guided-onboarding-github-connect-refusal.spec.ts` states: the canonical copy
 * module's extension-less imports abort the whole desktop-e2e suite at load.
 */
const GITHUB_STEP_HEADING = "Connect GitHub to finish setup";
const CONNECT_CTA_LABEL = "Continue with GitHub";

const CLOUD_PROFILE_ID = "github-connect-return-cloud-profile";
const WEB_APP_ORIGIN = "http://127.0.0.1:3000";
const CLERK_LINK_PATH = "/connect/github/link";
const STEP_BUDGET_MS = 30_000;
/** Covers the watch's 5s poll several times over. */
const RETURN_BUDGET_MS = 30_000;
const E2E_BUDGET_MS = 180_000;

for (const completesDuringHandoff of [false, true]) {
  test(`Desktop comes back to the front when GitHub connects ${completesDuringHandoff ? "during the browser handoff" : "after the browser handoff"}`, async () => {
    test.setTimeout(E2E_BUDGET_MS);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "github-connect-return-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "github-connect-return-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "github-connect-return-udd-")
    );
    const cloud = createGitHubStepCloud();
    const server = await startAuthenticatedBranchCloudServer({
      extraRoutes: cloud.route,
    });

    try {
      const seedLaunch = await launchAuthenticatedDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
      });
      try {
        await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
      } finally {
        await seedLaunch.cleanup();
      }

      const { app, page, pageErrors, cleanup } =
        await launchAuthenticatedDesktopApp({
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              ...cloudProfileSettings(server.origin),
              cloudCommandsPaused: false,
            });
          },
          cloudReadReadiness: drainedCloudReadReadiness(),
          env: {
            CL_AUTH_API_ORIGIN: server.origin,
            CLAUDE_HOME: claudeHome,
            CODEX_HOME: codexHome,
          },
          revealWindow: true,
          userDataDir,
        });

      try {
        await installOpenExternalSpy(app);
        if (completesDuringHandoff) {
          await completeDuringBrowserHandoff(app, server.origin);
        }
        await installAppFocusSpy(app);
        await expect
          .poll(
            () => page.evaluate(() => window.desktopApi.getDesktopAuthState()),
            { timeout: STEP_BUDGET_MS }
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });

        await gotoNavSettled(page, "dashboard");
        await expect(
          page.getByRole("heading", { name: GITHUB_STEP_HEADING })
        ).toBeVisible({ timeout: STEP_BUDGET_MS });
        await page
          .getByRole("button", { exact: true, name: CONNECT_CTA_LABEL })
          .first()
          .click();

        // The browser hand-off happened, to the web linking page.
        await expect
          .poll(
            async () =>
              (await openedUrls(app)).some(
                (url) => new URL(url).pathname === CLERK_LINK_PATH
              ),
            { timeout: STEP_BUDGET_MS }
          )
          .toBe(true);
        // Nothing has connected yet, so nothing has been brought forward: the
        // activation below is read against a change the connect caused.
        if (!completesDuringHandoff) {
          expect(await appFocusSteals(app)).toBe(0);
          // The web page finishes the link.
          cloud.completeConnect();
        }

        // The regression: Desktop activates itself.
        await expect
          .poll(() => appFocusSteals(app), { timeout: RETURN_BUDGET_MS })
          .toBeGreaterThan(0);
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
}

/**
 * Replace `app.focus` in MAIN with a recorder of `{ steal: true }` calls — the
 * activation `returnFromBrowserSignIn` performs — so the run steals no focus.
 */
async function installAppFocusSpy(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const recorder = globalThis as unknown as { __appFocusSteals: number };
    recorder.__appFocusSteals = 0;
    electronApp.focus = (options?: { steal?: boolean }) => {
      if (options?.steal === true) {
        recorder.__appFocusSteals += 1;
      }
    };
  });
}

function appFocusSteals(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __appFocusSteals?: number })
        .__appFocusSteals ?? 0
  );
}

type GitHubStepCloud = {
  completeConnect: () => void;
  route: (request: IncomingMessage, response: ServerResponse) => boolean;
};

/**
 * The reads the GitHub step makes. The run is a Google account's first-time
 * Desktop run parked on the GitHub step — the recorded case — and the GitHub
 * status answers disconnected until {@link GitHubStepCloud.completeConnect}.
 */
function createGitHubStepCloud(): GitHubStepCloud {
  let connected = false;

  function route(request: IncomingMessage, response: ServerResponse): boolean {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === CONNECT_COMPLETE_PATH && request.method === "POST") {
      connected = true;
      writeApiResult(response, {});
      return true;
    }
    if (!GITHUB_STEP_PATHS.has(pathname) || request.method !== "GET") {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (pathname === GUIDED_SNAPSHOT_PATH) {
      writeApiResult(response, githubStepSnapshot(connected));
      return true;
    }
    if (pathname === DESKTOP_IDENTITY_PATH) {
      writeApiResult(response, desktopIdentity());
      return true;
    }
    writeApiResult(response, gitHubStatus(connected));
    return true;
  }

  return {
    completeConnect: () => {
      connected = true;
    },
    route,
  };
}

function githubStepSnapshot(
  githubConnected: boolean
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-github-connect-return",
    context: {
      accountProvider: AccountProvider.Google,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 6,
    startedOnHost: OnboardingHost.Desktop,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.Google,
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.CreateOrganization,
        OnboardingPhase.SyncPolicy,
        OnboardingPhase.InviteTeam,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.ConnectGitHub,
      resuming: false,
    }),
  };
}

function gitHubStatus(connected: boolean): GitHubIntegrationStatus {
  return {
    connected: false,
    githubDataConnection: {
      connected,
      oauthRequiredReasons: [],
      sources: connected ? [GitHubDataConnectionSource.UserOAuth] : [],
    },
  };
}

function cloudProfileSettings(origin: string): Record<string, unknown> {
  return {
    activeConfigId: CLOUD_PROFILE_ID,
    apiOrigin: origin,
    cloudConnectionEnabled: true,
    savedConfigs: [
      {
        apiOrigin: origin,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
        id: CLOUD_PROFILE_ID,
        name: "GitHub Connect Return E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: WEB_APP_ORIGIN,
      },
    ],
  };
}

function desktopIdentity(): DesktopIdentity {
  return {
    email: "desktop-github-return@example.test",
    firstName: "Desktop",
    lastName: "User",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationName: "New DMG Org Onboarding",
    organizationSlug: "new-dmg-org-onboarding",
    sessionSyncPolicyEnabled: true,
    sessionSyncPolicySupported: true,
    userId: AUTHENTICATED_USER_ID,
  };
}

const DESKTOP_IDENTITY_PATH = "/desktop/identity";
const GITHUB_INTEGRATION_PATH = "/integrations/github";
const GUIDED_SNAPSHOT_PATH = "/onboarding/guided/snapshot";

const GITHUB_STEP_PATHS = new Set([
  DESKTOP_IDENTITY_PATH,
  GITHUB_INTEGRATION_PATH,
  GUIDED_SNAPSHOT_PATH,
]);

/** Finish the fixture link before the real opener returns to its watch. */
async function completeDuringBrowserHandoff(
  app: ElectronApplication,
  origin: string
): Promise<void> {
  await app.evaluate(({ shell }, completeUrl) => {
    const recordOpen = shell.openExternal;
    shell.openExternal = async (url: string) => {
      await recordOpen(url);
      await fetch(completeUrl, { method: "POST" });
    };
  }, `${origin}${CONNECT_COMPLETE_PATH}`);
}

const CONNECT_COMPLETE_PATH = "/test/github-connect-complete";
