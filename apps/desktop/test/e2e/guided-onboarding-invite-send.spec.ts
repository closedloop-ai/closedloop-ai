/**
 * ISS-11670 launched-app regression: a successful send from the guided
 * onboarding Invite step, in the Desktop shell.
 *
 * `GuidedOnboardingDialogHost` is shared with the web shell and the web half of
 * this flow is `e2e/guided-onboarding-required-phase-sequence.spec.ts`. This
 * spec drives the same step through the real built Electron app, the desktop
 * auth restore lane and the desktop API transport, against a local cloud
 * stand-in: the reader types two addresses and sends, the step confirms the
 * server's tally, advances on its own with exactly one `send_invitations`, and
 * a return to the step lists the addresses the server reported `invited`.
 *
 * Would fail before the change: a clean send never advanced on its own, so the
 * GitHub step below never appears without a Continue click.
 *
 * The run is SEEDED at the invite step through the guided snapshot, the way
 * `guided-onboarding-settings-sync.spec.ts` seeds its run: an email account with
 * no GitHub connection, so the step after invitations is the GitHub prompt,
 * which has the Back control the return leg needs.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity.ts";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github.ts";
import {
  InviteMemberStatus,
  type InviteMembersInput,
  type InviteMembersResponse,
  OrgInviteRole,
} from "@repo/api/src/types/onboarding.ts";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events.ts";
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
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase.ts";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience.ts";
import {
  GUIDED_ONBOARDING_BACK_NAME,
  INVITE_DIALOG_NAME,
  INVITE_EMAILS_FIELD_LABEL,
  INVITE_SENT_DIALOG_NAME,
  SEND_TWO_INVITES_NAME,
  TWO_INVITATIONS_SENT_TITLE,
} from "../../../../e2e/helpers/guided-onboarding-step-copy";
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
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
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

/**
 * The GitHub step's heading. Re-typed rather than imported for the reason
 * `guided-onboarding-github-connect-refusal.spec.ts` states: the component
 * module's extension-less imports abort the whole desktop-e2e suite at load.
 */
const GITHUB_STEP_HEADING = "Connect GitHub to finish setup";

const INVITED_EMAILS = [
  "ada@iss-11670.example.test",
  "grace@iss-11670.example.test",
] as const;
const CLOUD_PROFILE_ID = "iss-11670-cloud-profile";
const DASHBOARD_NAV = "dashboard";
const STEP_BUDGET_MS = 30_000;
const E2E_BUDGET_MS = 180_000;

test("ISS-11670: a successful invite send advances once and lists the invited addresses", async () => {
  test.setTimeout(E2E_BUDGET_MS);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11670-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11670-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-11670-desktop-udd-")
  );
  const cloud = createInviteStepCloud();
  const server = await startAuthenticatedBranchCloudServer({
    extraRoutes: cloud.route,
  });

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
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
      const inviteDialog = page.getByRole("dialog", {
        name: INVITE_DIALOG_NAME,
      });
      await expect(inviteDialog).toBeVisible({ timeout: STEP_BUDGET_MS });

      // The trailing separator commits both addresses as chips, so the submit
      // label below counts two recipients rather than one plus a draft.
      await inviteDialog
        .getByLabel(INVITE_EMAILS_FIELD_LABEL)
        .fill(`${INVITED_EMAILS.join(", ")},`);
      await inviteDialog
        .getByRole("button", { name: SEND_TWO_INVITES_NAME })
        .click();

      // The confirmation states the server's tally on the sent-state dialog.
      const sentDialog = page.getByRole("dialog", {
        name: INVITE_SENT_DIALOG_NAME,
      });
      await expect(
        sentDialog
          .getByRole("alert")
          .filter({ hasText: TWO_INVITATIONS_SENT_TITLE })
      ).toBeVisible({ timeout: STEP_BUDGET_MS });

      // The paced advance, with no Continue pressed.
      const githubHeading = page.getByRole("heading", {
        name: GITHUB_STEP_HEADING,
      });
      await expect(githubHeading).toBeVisible({ timeout: STEP_BUDGET_MS });
      expect(cloud.inviteRequests).toEqual([
        { emailAddresses: [...INVITED_EMAILS], role: OrgInviteRole.Member },
      ] satisfies InviteMembersInput[]);
      expect(cloud.posted).toEqual([
        { type: OnboardingEvent.SendInvitations },
      ] satisfies OnboardingEventInput[]);

      // Back to the step: the confirmation is retired and the sent state lists
      // the addresses this run's send invited.
      await page
        .getByRole("button", { name: GUIDED_ONBOARDING_BACK_NAME })
        .click();
      await expect(sentDialog).toBeVisible({ timeout: STEP_BUDGET_MS });
      for (const email of INVITED_EMAILS) {
        await expect(
          sentDialog.getByText(email, { exact: true })
        ).toBeVisible();
      }
      await expect(
        sentDialog
          .getByRole("alert")
          .filter({ hasText: TWO_INVITATIONS_SENT_TITLE })
      ).toHaveCount(0);
      expect(cloud.posted).toEqual([
        { type: OnboardingEvent.SendInvitations },
        { type: OnboardingEvent.Back },
      ] satisfies OnboardingEventInput[]);
      expect(cloud.phase()).toBe(OnboardingPhase.InviteTeam);
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

type InviteStepCloud = {
  inviteRequests: InviteMembersInput[];
  phase: () => OnboardingPhase;
  posted: OnboardingEventInput[];
  route: (request: IncomingMessage, response: ServerResponse) => boolean;
};

/**
 * The cloud routes the invite step reads and writes, stateful over one run.
 * The guided pair keeps the server's two acceptance checks (the `revision`
 * compare-and-swap and a restorable posted state) and stores the client's
 * state verbatim, as `guided-onboarding-settings-sync.spec.ts` argues; the
 * invitations route answers a clean send, every address `invited`.
 */
function createInviteStepCloud(): InviteStepCloud {
  let snapshot = inviteStepSnapshot();
  const inviteRequests: InviteMembersInput[] = [];
  const posted: OnboardingEventInput[] = [];

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
    posted.push(command.event);
    snapshot = {
      ...snapshot,
      context: {
        ...snapshot.context,
        teamInvited:
          command.event.type === OnboardingEvent.SendInvitations ||
          snapshot.context.teamInvited,
      },
      revision: snapshot.revision + 1,
      state: command.state,
    };
    writeApiResult(response, snapshot);
  }

  function sendInvitations(body: string, response: ServerResponse): void {
    const input: InviteMembersInput = JSON.parse(body);
    inviteRequests.push(input);
    const result: InviteMembersResponse = {
      invited: input.emailAddresses.length,
      results: input.emailAddresses.map((email, index) => ({
        email,
        invitationId: `inv_iss_11670_${index}`,
        status: InviteMemberStatus.Invited,
      })),
    };
    writeApiResult(response, result);
  }

  function answerPost(
    request: IncomingMessage,
    response: ServerResponse,
    handle: (body: string, response: ServerResponse) => void
  ): void {
    readRequestBody(request)
      .then((body) => handle(body, response))
      .catch(() => {
        response.statusCode = 400;
        writeApiResult(response, null);
      });
  }

  function route(request: IncomingMessage, response: ServerResponse): boolean {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!INVITE_STEP_PATHS.has(pathname)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (request.method === "POST" && pathname === GUIDED_TRANSITION_PATH) {
      answerPost(request, response, applyTransition);
      return true;
    }
    if (request.method === "POST" && pathname === INVITATIONS_PATH) {
      answerPost(request, response, sendInvitations);
      return true;
    }
    if (request.method !== "GET") {
      return false;
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
    inviteRequests,
    phase: () =>
      restoreOnboardingState(snapshot.state, OnboardingHost.Desktop).state
        .phase,
    posted,
    route,
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

/**
 * A Desktop run parked on the invite step, after the ISS-10890 order
 * (organization, then sync policy, then invitations). An email account with no
 * GitHub connection, so `send_invitations` lands on the GitHub step.
 */
function inviteStepSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-iss-11670-desktop",
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
        name: "ISS-11670 Cloud E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}

function desktopIdentity(): DesktopIdentity {
  return {
    email: "desktop-iss-11670@example.test",
    firstName: "Desktop",
    lastName: "User",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    organizationName: "ISS-11670 Org",
    organizationSlug: "iss-11670",
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
const INVITATIONS_PATH = "/organizations/invitations";

const INVITE_STEP_PATHS = new Set([
  DESKTOP_IDENTITY_PATH,
  GITHUB_INTEGRATION_PATH,
  GUIDED_SNAPSHOT_PATH,
  GUIDED_TRANSITION_PATH,
  INVITATIONS_PATH,
]);
