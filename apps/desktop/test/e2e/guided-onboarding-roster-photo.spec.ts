/**
 * ISS-12341 regression on the ELECTRON shell: the guided-onboarding invite
 * step's "your team is already here" roster draws each teammate's photo, and
 * falls back to initials when the URL fails.
 *
 * THE INVITE STEP IS NOT WEB-ONLY, which is why this file exists alongside
 * `e2e/guided-onboarding-roster-photo.spec.ts`.
 * `DesktopGuidedOnboardingDialogHost` mounts the same shared
 * `GuidedOnboardingDialogHost` that `apps/app` does, and
 * `guided-onboarding-invite-send.spec.ts` beside this file already drives this
 * step through the launched app. `packages/app/AGENTS.md` therefore owes a
 * browser regression on each shell, and both read their payloads and assertions
 * from `e2e/helpers/onboarding-roster-photo-fixture.ts`.
 *
 * THE ROSTER IS A CLOUD READ. It is `GET /users` folded against `GET /me`, so
 * the stand-in below serves both, and the SIGNER ROW IS THE SAME OBJECT in each
 * — the fold subtracts the reader by id, and two disagreeing ids leave the
 * reader named in their own roster, a state every assertion here would pass
 * through.
 *
 * ONE LAUNCH, TWO PHASES. The loadable pair is asserted, the payload is
 * re-pointed at the failing pair, and the app is reloaded so the step mounts
 * from cold against a payload it has never seen. Four urls rather than two
 * flipped between 200 and 404, so neither phase can be answered out of the
 * other's HTTP cache.
 *
 * Outside `DESKTOP_SMOKE_SPECS`: this gates the invite roster, not every change
 * that runs `desktop-e2e`.
 *
 * Build before running: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github.ts";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided.ts";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence.ts";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase.ts";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience.ts";
import { INVITE_DIALOG_NAME } from "../../../../e2e/helpers/guided-onboarding-step-copy";
import { currentUser } from "../../../../e2e/helpers/mock-users";
import {
  expectRosterPhotosFellBack,
  expectRosterPhotosLoaded,
  installRosterPhotoRoutes,
  RosterPhotoState,
  rosterUsersPayload,
} from "../../../../e2e/helpers/onboarding-roster-photo-fixture";
import type { PhotoRouteCounts } from "../../../../e2e/helpers/person-photo-evidence";
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

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

const CLOUD_PROFILE_ID = "iss-12341-roster-cloud-profile";
const DASHBOARD_NAV = "dashboard";
const STEP_BUDGET_MS = 30_000;
const E2E_BUDGET_MS = 300_000;

test("ISS-12341: the invite roster draws teammate photos, then initials when they fail", async () => {
  test.setTimeout(E2E_BUDGET_MS);

  const dirs = makeHarnessDirs();
  const cloud = createRosterCloud();
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: cloud.route,
  });

  try {
    await seedRestorableSession(dirs);
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(server.origin),
          cloudCommandsPaused: false,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: dirs.codexHome,
      },
      userDataDir: dirs.userDataDir,
    });

    try {
      const counts = await installRosterPhotoRoutes(page);
      await expectAuthenticated(page);
      await gotoNavSettled(page, DASHBOARD_NAV);

      await expectRosterPhotosLoaded(await inviteDialog(page));
      expect(counts.loadable).toBeGreaterThanOrEqual(2);

      cloud.servePhotoState(RosterPhotoState.Failed);
      await reloadUntilPhotoFailed(page, counts);
      await expectRosterPhotosFellBack(await inviteDialog(page), counts);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupHarnessDirs(dirs);
  }
});

type HarnessDirs = {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
};

function makeHarnessDirs(): HarnessDirs {
  return {
    claudeHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-roster-cl-")),
    codexHome: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-roster-cx-")),
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "iss-12341-roster-ud-")),
  };
}

function cleanupHarnessDirs(dirs: HarnessDirs): void {
  for (const dir of [dirs.userDataDir, dirs.codexHome, dirs.claudeHome]) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * The first launch exists to write the session: the seed encrypts through
 * Electron's own `safeStorage`, so it needs a live app, and the production
 * restore lane reads that file only at boot.
 */
async function seedRestorableSession(dirs: HarnessDirs): Promise<void> {
  const seedLaunch = await launchAuthenticatedDesktopApp({
    env: { CLAUDE_HOME: dirs.claudeHome, CODEX_HOME: dirs.codexHome },
    userDataDir: dirs.userDataDir,
  });
  try {
    await seedAuthenticatedDesktopSession(seedLaunch.app, dirs.userDataDir);
  } finally {
    await seedLaunch.cleanup();
  }
}

async function expectAuthenticated(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDesktopAuthState()), {
      timeout: STEP_BUDGET_MS,
    })
    .toMatchObject({
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: AUTHENTICATED_USER_ID,
    });
}

async function inviteDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: INVITE_DIALOG_NAME });
  await expect(dialog).toBeVisible({ timeout: STEP_BUDGET_MS });
  return dialog;
}

/**
 * Re-mounts the step against the re-pointed payload.
 *
 * A reload rather than a refetch: the renderer holds the first roster answer in
 * its query cache, and the point of the second phase is a payload the strip has
 * never seen. The photo routes are page-scoped and survive it. Waiting on the
 * failing url's own tally is what makes the next assertion a claim about a photo
 * the browser TRIED, rather than one about a step that had not refetched yet.
 */
async function reloadUntilPhotoFailed(
  page: Page,
  counts: PhotoRouteCounts
): Promise<void> {
  const servedBefore = counts.failed;
  await page.reload();
  await expectAuthenticated(page);
  await gotoNavSettled(page, DASHBOARD_NAV);
  await expect
    .poll(() => counts.failed, { timeout: STEP_BUDGET_MS })
    .toBeGreaterThan(servedBefore);
}

type RosterCloud = {
  route: (request: IncomingMessage, response: ServerResponse) => boolean;
  servePhotoState: (state: RosterPhotoState) => void;
};

/**
 * The cloud reads the invite roster needs, over one run.
 *
 * The guided snapshot is served read-only: nothing in this spec advances the
 * run, and a transition arriving at all would mean the step was left, which the
 * dialog barrier would then fail on. The transition path is still answered, so
 * a stray post cannot surface as an unhandled 404 in `pageErrors` instead.
 */
function createRosterCloud(): RosterCloud {
  let photoState: RosterPhotoState = RosterPhotoState.Loadable;
  const snapshot = inviteStepSnapshot();
  // The reader, answered identically on `/me` and inside `/users`.
  const signer = currentUser({
    id: AUTHENTICATED_USER_ID,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
  });

  function route(request: IncomingMessage, response: ServerResponse): boolean {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!ROSTER_STEP_PATHS.has(pathname)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (pathname === GUIDED_TRANSITION_PATH) {
      writeApiResult(response, snapshot);
      return true;
    }
    if (request.method !== "GET") {
      return false;
    }
    if (pathname === USERS_PATH) {
      writeApiResult(response, rosterUsersPayload(photoState, signer));
      return true;
    }
    if (pathname === ME_PATH) {
      writeApiResult(response, signer);
      return true;
    }
    if (pathname === GUIDED_SNAPSHOT_PATH) {
      writeApiResult(response, snapshot);
      return true;
    }
    if (pathname === DESKTOP_IDENTITY_PATH) {
      writeApiResult(response, desktopIdentity());
      return true;
    }
    if (pathname === GITHUB_INTEGRATION_PATH) {
      writeApiResult(response, disconnectedGitHubStatus());
      return true;
    }
    return false;
  }

  return {
    route,
    servePhotoState: (state) => {
      photoState = state;
    },
  };
}

/**
 * A Desktop run parked on the invite step, after the ISS-10890 order
 * (organization, then sync policy, then invitations).
 *
 * `teamInvited: false` with no send performed is what keeps `invitedEmails`
 * empty: the step replaces the strip with the sent-addresses list the moment
 * this run has invited anyone, so a seeded `true` here would assert against a
 * screen that has no roster on it.
 */
function inviteStepSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-iss-12341-roster-desktop",
    context: {
      accountProvider: AccountProvider.Email,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.Email,
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.SyncPolicy,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.InviteTeam,
      resuming: false,
    }),
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
        name: "ISS-12341 Roster Photo E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}

function desktopIdentity(): DesktopIdentity {
  return {
    email: "desktop-iss-12341@example.test",
    firstName: "Desktop",
    lastName: "User",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationName: "ISS-12341 Org",
    organizationSlug: "iss-12341",
    sessionSyncPolicyEnabled: true,
    sessionSyncPolicySupported: true,
    userId: AUTHENTICATED_USER_ID,
  };
}

function disconnectedGitHubStatus(): GitHubIntegrationStatus {
  return {
    connected: false,
    githubDataConnection: {
      connected: false,
      oauthRequiredReasons: [],
      sources: [],
    },
  };
}

const DESKTOP_IDENTITY_PATH = "/desktop/identity";
const GITHUB_INTEGRATION_PATH = "/integrations/github";
const GUIDED_SNAPSHOT_PATH = "/onboarding/guided/snapshot";
const GUIDED_TRANSITION_PATH = "/onboarding/guided/transition";
const ME_PATH = "/me";
const USERS_PATH = "/users";

const ROSTER_STEP_PATHS = new Set([
  DESKTOP_IDENTITY_PATH,
  GITHUB_INTEGRATION_PATH,
  GUIDED_SNAPSHOT_PATH,
  GUIDED_TRANSITION_PATH,
  ME_PATH,
  USERS_PATH,
]);
