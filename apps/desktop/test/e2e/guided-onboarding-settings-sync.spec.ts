/**
 * E2E (ISS-8353 / PLN-1949 v3): a Desktop user who reached Ready without a
 * recorded sync policy gets a deferred onboarding item, answers it, and sees the
 * item clear only after an explicit local sync choice is saved.
 *
 * ISS-11249 changed where that item LEADS. It used to be a link into Settings v2
 * — the detour the operator reported, because the onboarding run owns this
 * election and was the one place not presenting it. The item now resumes the
 * SyncPolicy phase in the onboarding modal, so this spec asserts that first, then
 * reaches Settings by its own route to keep pinning the half that did not change:
 * Settings is still a valid place to change the answer later.
 *
 * This uses the launched Electron app and the standard authenticated fixture so
 * the chain under test is production wiring: guided snapshot -> shared sidebar
 * card -> native Settings v2 route -> desktop settings host IPC -> persisted
 * consent record -> sidebar card recomputation. Renderer tests own the smaller
 * state-machine cases; this spec pins the Desktop crossing the plan added.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  BROWSER_SESSION_PAGE_LIMIT_DEFAULT,
  BROWSER_SESSION_PAGE_LIMIT_MAX,
  type BrowserSessionListResponse,
} from "@repo/api/src/types/browser-session.ts";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import {
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
} from "@repo/api/src/types/github.ts";
import {
  type GuidedOnboardingSnapshot,
  guidedOnboardingTransitionRequestSchema,
} from "@repo/api/src/types/onboarding-guided.ts";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence.ts";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase.ts";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role.ts";
import {
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel.ts";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model.ts";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience.ts";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
  SyncObservabilityTier,
} from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  activeNavPanel,
  drainedCloudReadReadiness,
  gotoHash,
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

const CLOUD_PROFILE_ID = "iss-8353-cloud-profile";
const DESKTOP_SETTINGS_FILE = "desktop-settings.json";
const DASHBOARD_NAV = "dashboard";
const GETTING_STARTED_LABEL = "Getting started";
const CHOOSE_SESSION_SYNC_LABEL = "Choose session sync";
const CONNECTED_DEVICES_HEADING = "Connected Devices";
const SYNC_SECTION_SELECTOR = "[data-this-device-sync-policy]";
const SYNC_RECORDED_ATTRIBUTE = "data-this-device-sync-recorded";
const SAVE_SYNC_CHOICE = "Save sync choice";
const FULL_TRANSCRIPTS = "Full transcripts";
const OFF = "Off";
const LEGACY_SYNC_TAKEOVER_TITLE = /sync permissions/i;
/**
 * The in-modal sync step's heading (ISS-11249). No other STEP emits it, but the
 * dialog's live region re-emits whatever the current heading says, so locate it
 * with {@link syncStepHeading} rather than by text.
 */
const IN_MODAL_SYNC_TITLE = "Choose what to sync";
const IN_MODAL_SYNC_EYEBROW = "Your data, your choice";
const MODAL_BACK = "Back";
const MODAL_CONTINUE = "Continue";
const UNRECORDED_COPY =
  "This device has not saved a sync choice yet. Choose a level below, then save it for this workspace.";
const DESKTOP_IDENTITY_EMAIL = "desktop-e2e@example.test";
const DESKTOP_ORGANIZATION_NAME = "Desktop E2E Org";
const STEP_BUDGET_MS = 30_000;
const E2E_BUDGET_MS = 180_000;

type PersistedSettings = {
  dataSyncLevel?: string;
  syncObservabilityTier?: string | null;
  syncConsentOrganizationId?: string | null;
};

test("ISS-8353: deferred sync completion opens Settings v2 and clears after explicit save", async () => {
  test.setTimeout(E2E_BUDGET_MS);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-8353-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-8353-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-8353-desktop-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: createGuidedSettingsRoutes(),
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(server.origin),
          cloudCommandsPaused: false,
          dataSyncLevel: DataSyncLevel.Full,
          syncObservabilityTier: null,
          transcriptSyncEnabled: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CL_AUTH_API_ORIGIN: server.origin,
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
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

      await gotoNavSettled(page, DASHBOARD_NAV);
      const card = page.getByLabel(GETTING_STARTED_LABEL);
      await expect(card).toBeVisible({ timeout: STEP_BUDGET_MS });
      await expect(card.getByText(CHOOSE_SESSION_SYNC_LABEL)).toBeVisible();
      await expect(
        page.getByRole("alertdialog", { name: LEGACY_SYNC_TAKEOVER_TITLE })
      ).toHaveCount(0);

      // ISS-11249: the action is a BUTTON that resumes the SyncPolicy phase in
      // the onboarding modal, not a link out to Settings. The negative pins the
      // detour itself as gone — a link here is the defect the operator reported.
      await expect(
        card.getByRole("link", { name: CHOOSE_SESSION_SYNC_LABEL })
      ).toHaveCount(0);
      await card
        .getByRole("button", { name: CHOOSE_SESSION_SYNC_LABEL })
        .click();
      // Exactly one element, asserted where the narrowing is: `toBeVisible` on
      // an ambiguous locator throws strict mode instead of reporting a count, so
      // it cannot be the thing that proves the count is one (ISS-11331 AC1).
      await expect(syncStepHeading(page)).toHaveCount(1, {
        timeout: STEP_BUDGET_MS,
      });
      await expect(syncStepHeading(page)).toBeVisible();
      await expect(page.getByText(IN_MODAL_SYNC_EYEBROW)).toBeVisible();

      // Back out of the resumed step rather than answering in it: the chain this
      // spec owns is Settings -> persisted consent -> the card clearing, and that
      // is the ISS-11249 AC4 half — Settings is still a valid place to answer.
      // Back from a resumed step returns to the Dashboard and closes the modal.
      await page.getByRole("button", { name: MODAL_BACK }).click();
      await expect(syncStepHeading(page)).toHaveCount(0, {
        timeout: STEP_BUDGET_MS,
      });

      await gotoHash(
        page,
        `/settings?panel=${SettingsPanelId.ConnectedDevices}&intent=${SettingsPanelIntent.SyncPolicy}`
      );
      const settingsShell = page.getByTestId("settings-shell");
      await expect(settingsShell).toBeVisible({
        timeout: STEP_BUDGET_MS,
      });
      await expect(
        settingsShell.getByRole("heading", { name: CONNECTED_DEVICES_HEADING })
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.location.hash), {
          timeout: STEP_BUDGET_MS,
        })
        .toContain(
          `/settings?panel=${SettingsPanelId.ConnectedDevices}&intent=${SettingsPanelIntent.SyncPolicy}`
        );

      const syncSection = settingsShell.locator(SYNC_SECTION_SELECTOR);
      await expect(syncSection).toHaveAttribute(
        SYNC_RECORDED_ATTRIBUTE,
        "false",
        { timeout: STEP_BUDGET_MS }
      );
      await expect(syncSection).toBeFocused({ timeout: STEP_BUDGET_MS });
      await expect(syncSection).toBeInViewport({
        ratio: 0.1,
        timeout: STEP_BUDGET_MS,
      });
      await expect(syncSection.getByText(UNRECORDED_COPY)).toBeVisible();
      await expect(
        syncSection.getByRole("radio", { name: FULL_TRANSCRIPTS })
      ).not.toBeChecked();
      await expect(
        syncSection.getByRole("radio", { checked: true })
      ).toHaveCount(0);
      await expect(
        syncSection.getByRole("button", { name: SAVE_SYNC_CHOICE })
      ).toBeDisabled();
      await syncSection.getByRole("radio", { name: OFF }).click();
      await expect(syncSection.getByRole("radio", { name: OFF })).toBeChecked();
      await expect(
        syncSection.getByRole("button", { name: SAVE_SYNC_CHOICE })
      ).toBeEnabled();

      await expect(syncSection.getByText(UNRECORDED_COPY)).toBeVisible();
      await syncSection.getByRole("button", { name: SAVE_SYNC_CHOICE }).click();
      await expect(syncSection).toHaveAttribute(
        SYNC_RECORDED_ATTRIBUTE,
        "true",
        { timeout: STEP_BUDGET_MS }
      );
      await expect(syncSection.getByText(UNRECORDED_COPY)).toHaveCount(0);
      await expect(
        syncSection.getByText("Current level").locator("..")
      ).toContainText(OFF);
      await expect
        .poll(() => readPersistedSettings(userDataDir), {
          timeout: STEP_BUDGET_MS,
        })
        .toMatchObject({
          dataSyncLevel: DataSyncLevel.Off,
          syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
          syncObservabilityTier: SyncObservabilityTier.Local,
        });

      await gotoNavSettled(page, DASHBOARD_NAV);
      await expect(page.getByLabel(GETTING_STARTED_LABEL)).toHaveCount(0, {
        timeout: STEP_BUDGET_MS,
      });
      expect(pageErrors).toEqual([]);
      expect(server.requests).toContainEqual(
        expect.objectContaining({
          authorization: `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`,
          pathname: "/onboarding/guided/snapshot",
        })
      );
    } finally {
      await cleanup();
    }

    const relaunch = await launchAuthenticatedDesktopApp({
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
      userDataDir,
    });

    try {
      await gotoNavSettled(relaunch.page, DASHBOARD_NAV);
      await expect(relaunch.page.getByLabel(GETTING_STARTED_LABEL)).toHaveCount(
        0,
        { timeout: STEP_BUDGET_MS }
      );

      await gotoHash(
        relaunch.page,
        `/settings?panel=${SettingsPanelId.ConnectedDevices}&intent=${SettingsPanelIntent.SyncPolicy}`
      );
      // ISS-8370 D6: under v2 Settings is a modal over the last nav page, so the committed panel stays Dashboard and no Settings page exists.
      await expect(activeNavPanel(relaunch.page, DASHBOARD_NAV)).toBeAttached({
        timeout: STEP_BUDGET_MS,
      });
      await expect(
        relaunch.page.locator('[data-nav-panel="settings"]')
      ).toHaveCount(0);
      const relaunchedShell = relaunch.page.getByTestId("settings-shell");
      await expect(relaunchedShell).toBeVisible({ timeout: STEP_BUDGET_MS });
      const relaunchedSyncSection = relaunchedShell.locator(
        SYNC_SECTION_SELECTOR
      );
      await expect(relaunchedSyncSection).toHaveAttribute(
        SYNC_RECORDED_ATTRIBUTE,
        "true",
        { timeout: STEP_BUDGET_MS }
      );
      await expect(
        relaunchedSyncSection.getByRole("radio", { name: OFF })
      ).toBeChecked();
      expect(relaunch.pageErrors).toEqual([]);
    } finally {
      await relaunch.cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

/**
 * ISS-11249 AC1-3, the half the spec above deliberately backs out of.
 *
 * That spec owns the Settings chain and therefore has to leave the resumed step
 * unanswered to reach an UNRECORDED Settings panel. Reviewed on PR #7971: with
 * only that spec, the launched app never completes the card-to-modal path, so a
 * broken modal sync write or a broken resumed exit still passes — both the save
 * and the final card assertion happen through Settings. This is the other end of
 * the same chain: press the row, answer IN the modal, and require BOTH the
 * desktop-local write and the card clearing.
 */
test("ISS-11249: the sync row is answered in the onboarding modal and clears the card", async () => {
  test.setTimeout(E2E_BUDGET_MS);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11249-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11249-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11249-desktop-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: createGuidedSettingsRoutes(),
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(server.origin),
          cloudCommandsPaused: false,
          dataSyncLevel: DataSyncLevel.Full,
          syncObservabilityTier: null,
          transcriptSyncEnabled: true,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CL_AUTH_API_ORIGIN: server.origin,
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
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

      await gotoNavSettled(page, DASHBOARD_NAV);
      const card = page.getByLabel(GETTING_STARTED_LABEL);
      await expect(card).toBeVisible({ timeout: STEP_BUDGET_MS });
      await card
        .getByRole("button", { name: CHOOSE_SESSION_SYNC_LABEL })
        .click();
      // Exactly one element, asserted where the narrowing is: `toBeVisible` on
      // an ambiguous locator throws strict mode instead of reporting a count, so
      // it cannot be the thing that proves the count is one (ISS-11331 AC1).
      await expect(syncStepHeading(page)).toHaveCount(1, {
        timeout: STEP_BUDGET_MS,
      });
      await expect(syncStepHeading(page)).toBeVisible();

      // Answered HERE, not in Settings. `Off` differs from the seeded `Full`, so
      // the persisted level below cannot be satisfied by the seed.
      await page.getByRole("radio", { name: OFF }).click();
      await expect(page.getByRole("radio", { name: OFF })).toBeChecked();
      await page.getByRole("button", { name: MODAL_CONTINUE }).click();

      // The modal's own write reached disk. `syncConsentOrganizationId` is the
      // field that makes the choice RECORDED rather than merely defaulted.
      await expect
        .poll(() => readPersistedSettings(userDataDir), {
          timeout: STEP_BUDGET_MS,
        })
        .toMatchObject({
          dataSyncLevel: DataSyncLevel.Off,
          syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
          syncObservabilityTier: SyncObservabilityTier.Local,
        });

      // The resumed step exits, and the checklist the press came from is gone.
      // Paired with the `toBeVisible` on this same locator above, so an absence
      // that was never a presence cannot satisfy it.
      await expect(syncStepHeading(page)).toHaveCount(0, {
        timeout: STEP_BUDGET_MS,
      });
      await expect(card).toHaveCount(0, { timeout: STEP_BUDGET_MS });
      expect(pageErrors).toEqual([]);
      expect(server.requests).toContainEqual(
        expect.objectContaining({
          authorization: `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`,
          method: "POST",
          pathname: GUIDED_TRANSITION_PATH,
        })
      );
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
 * The guided-onboarding stand-in, STATEFUL over one run.
 *
 * It used to answer `/onboarding/guided/snapshot` with a frozen `Ready` and
 * model no transition at all, so `POST /onboarding/guided/transition` fell
 * through to the base server's 404. That was invisible for as long as this spec
 * only followed a LINK out to Settings — nothing it asserted went through the
 * run. ISS-11249 made the checklist action post a transition and wait for the
 * modal to re-render from the answer, and against a static double that press can
 * never do anything: a failed guided transition is deliberately not toasted, so
 * the spec saw the same silent nothing a real user would.
 *
 * The CLIENT owns the machine here — `useGuidedOnboardingTransition` runs
 * `transitionOnboarding` before it posts and sends the resulting state — so a
 * faithful double stores what it is handed rather than deriving anything. It
 * keeps the two server-side checks that decide whether a command is accepted at
 * all, because both are load-bearing for what this spec proves: the CAS on
 * `revision`, and `restoreOnboardingState(...).outcome === Restored`, which is
 * the gate a real API applies to refuse an unreachable posted state.
 */
function createGuidedSettingsRoutes(): (
  request: IncomingMessage,
  response: ServerResponse
) => boolean {
  let snapshot = readySnapshot();

  function applyTransition(body: string, response: ServerResponse): void {
    const command = guidedOnboardingTransitionRequestSchema.parse(
      JSON.parse(body)
    );
    if (command.revision !== snapshot.revision) {
      response.statusCode = 409;
      writeApiResult(response, snapshot);
      return;
    }
    if (
      restoreOnboardingState(command.state, command.host).outcome !==
      OnboardingRestoreOutcome.Restored
    ) {
      response.statusCode = 400;
      writeApiResult(response, null);
      return;
    }
    snapshot = {
      ...snapshot,
      restoreOutcome: OnboardingRestoreOutcome.Restored,
      revision: snapshot.revision + 1,
      state: command.state,
    };
    writeApiResult(response, snapshot);
  }

  return function routeGuidedSettingsRequest(request, response): boolean {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!GUIDED_SETTINGS_PATHS.has(requestUrl.pathname)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (
      request.method === "POST" &&
      requestUrl.pathname === GUIDED_TRANSITION_PATH
    ) {
      readRequestBody(request)
        .then((body) => applyTransition(body, response))
        .catch(() => {
          response.statusCode = 400;
          writeApiResult(response, null);
        });
      return true;
    }
    if (request.method !== "GET") {
      return false;
    }
    if (requestUrl.pathname === "/onboarding/guided/snapshot") {
      writeApiResult(response, snapshot);
      return true;
    }
    if (requestUrl.pathname === "/desktop/identity") {
      writeApiResult(response, desktopIdentity());
      return true;
    }
    if (requestUrl.pathname === "/integrations/github") {
      writeApiResult(response, connectedGitHubStatus());
      return true;
    }
    if (requestUrl.pathname === "/settings/view-model") {
      writeApiResult(response, settingsViewModel());
      return true;
    }
    if (requestUrl.pathname === "/settings/browser-sessions") {
      writeApiResult(response, browserSessionsResponse(requestUrl));
      return true;
    }
    if (requestUrl.pathname === "/compute-targets") {
      writeApiResult(response, []);
      return true;
    }
    return false;
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function readPersistedSettings(userDataDir: string): PersistedSettings {
  return JSON.parse(
    fs.readFileSync(path.join(userDataDir, DESKTOP_SETTINGS_FILE), "utf8")
  );
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
        name: "ISS-8353 Cloud E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}

function desktopIdentity(): DesktopIdentity {
  return {
    email: DESKTOP_IDENTITY_EMAIL,
    firstName: "Desktop",
    lastName: "User",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationName: DESKTOP_ORGANIZATION_NAME,
    organizationSlug: "desktop-e2e",
    userId: AUTHENTICATED_USER_ID,
  };
}

function connectedGitHubStatus(): GitHubIntegrationStatus {
  return {
    connected: true,
    installation: {
      accountLogin: "closedloop-ai",
      accountType: "Organization",
      claimedAt: "2026-09-08T12:00:00.000Z",
      createdAt: "2026-09-08T12:00:00.000Z",
      id: "github-installation-desktop-e2e",
      installationId: "8353",
      repositoryCount: 1,
      repositorySelection: "selected",
      status: GitHubInstallationStatus.Active,
    },
  };
}

function readySnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-desktop-e2e",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 3,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}

function settingsViewModel() {
  return projectSettingsViewModel({
    resolution: {
      role: SettingsActorRole.Member,
      status: SettingsActorRoleStatus.Resolved,
    },
    staleSessionRole: false,
  });
}

function browserSessionsResponse(requestUrl: URL): BrowserSessionListResponse {
  const limit = clampPageLimit(requestUrl.searchParams.get("limit"));
  const offset = clampPageOffset(requestUrl.searchParams.get("offset"));
  return {
    currentSessionKnown: false,
    limit,
    offset,
    sessions: [],
    totalCount: 0,
  };
}

function clampPageLimit(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isInteger(requested)) {
    return BROWSER_SESSION_PAGE_LIMIT_DEFAULT;
  }
  return Math.min(Math.max(requested, 1), BROWSER_SESSION_PAGE_LIMIT_MAX);
}

function clampPageOffset(raw: string | null): number {
  const requested = Number(raw);
  if (!Number.isInteger(requested)) {
    return 0;
  }
  return Math.max(requested, 0);
}

const GUIDED_TRANSITION_PATH = "/onboarding/guided/transition";

const GUIDED_SETTINGS_PATHS = new Set([
  "/compute-targets",
  "/desktop/identity",
  "/integrations/github",
  GUIDED_TRANSITION_PATH,
  "/onboarding/guided/snapshot",
  "/settings/browser-sessions",
  "/settings/view-model",
]);

/**
 * The in-modal sync step's own heading, located by ROLE.
 *
 * Not `getByText`: the onboarding dialog's polite live region carries the
 * current step heading's text verbatim (`useAnnounceBodyChange` in
 * `guided-onboarding-dialog.tsx`), so one commit after arriving at the step the
 * string exists on TWO nodes — the `DialogTitle` and the `sr-only` announcement
 * span. Both are pinned together by
 * `packages/app/onboarding/components/__tests__/guided-onboarding-phase-focus.test.tsx`,
 * so the duplication is a contract rather than a bug. A text query is therefore
 * ambiguous exactly when an assertion's first poll lands after that second
 * commit and not before it, which is the intermittent
 * `strict mode violation: resolved to 2 elements` ISS-11331 measured on
 * PR #7991. The announcement is a `span` with no role, so narrowing to the
 * heading resolves the one element this spec means.
 */
function syncStepHeading(page: Page) {
  return page.getByRole("heading", { name: IN_MODAL_SYNC_TITLE });
}
