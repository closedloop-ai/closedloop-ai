import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { guidedOnboardingKeys } from "../hooks/use-guided-onboarding";
import { GETTING_STARTED_STEP_CONTENT } from "./getting-started-card-shell";
import {
  GuidedGettingStartedCard,
  type GuidedGettingStartedCardProps,
} from "./guided-getting-started-card";

const STORY_ORG_ID = "org_test";
const STORY_USER_ID = "user_test";
// ISS-10942: the action carries the pending step's OWN label and icon, as the
// web-master prototype renders it — not a generic "Continue" / "Open Settings".
const SYNC_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ChooseSessionSync].label;
const GITHUB_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ConnectGitHub].label;
const CREATE_ACCOUNT_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount].label;
const DOWNLOAD_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.DownloadDesktop].label;
const INVITE_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.InviteTeam].label;

const meta: Meta<typeof GuidedGettingStartedCard> = {
  args: {
    analysisStarted: true,
    host: OnboardingHost.Desktop,
    syncConsentReadSettled: true,
    syncConsentRecorded: KnownFlag.No,
  },
  component: GuidedGettingStartedCard,
  decorators: [
    (Story) => (
      <div className="w-64 bg-sidebar p-3">
        <Story />
      </div>
    ),
  ],
  parameters: {
    appCore: {
      queryData: seededCache(OnboardingHost.Desktop),
    },
    layout: "padded",
  },
  tags: ["deprecated", "autodocs"],
  title: "Composites v1.0/Onboarding/Guided Getting Started Card",
};

export default meta;

type Story = StoryObj<typeof GuidedGettingStartedCard>;

/**
 * Desktop-only deferred sync consent. A BUTTON since ISS-11249: the step resumes
 * the SyncPolicy phase inside the onboarding modal, so it is no longer a link out
 * to the Settings v2 sync-policy target.
 */
export const DesktopSyncConsentPending: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: SYNC_ACTION_NAME })
    ).toBeVisible();
  },
};

/** Web uses the same completion card for phase-backed deferred steps. */
export const WebGitHubDeferred: Story = {
  args: {
    analysisStarted: false,
    host: OnboardingHost.Web,
    syncConsentRecorded: KnownFlag.Unknown,
  },
  parameters: {
    appCore: {
      queryData: seededCache(OnboardingHost.Web, { githubConnected: false }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: GITHUB_ACTION_NAME })
    ).toBeVisible();
  },
};

/**
 * Desktop deferred the account itself (ISS-8349's rank-1 step; only Desktop can
 * skip it, since Web requires an established account to get this far).
 */
export const CreateAccountPending: Story = {
  parameters: {
    appCore: {
      queryData: seededCache(OnboardingHost.Desktop, {
        accountStatus: AccountStatus.Skipped,
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: CREATE_ACCOUNT_ACTION_NAME })
    ).toBeVisible();
  },
};

/** Web hasn't downloaded the desktop app yet (Web-only; Desktop already has it). */
export const WebDownloadDesktopPending: Story = {
  args: {
    host: OnboardingHost.Web,
  },
  parameters: {
    appCore: {
      queryData: seededCache(OnboardingHost.Web, {
        desktopAppDownloaded: false,
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: DOWNLOAD_ACTION_NAME })
    ).toBeVisible();
  },
};

/** Rank-4: account established and GitHub connected, but the team isn't invited yet. */
export const InviteTeamPending: Story = {
  parameters: {
    appCore: {
      queryData: seededCache(OnboardingHost.Desktop, {
        teamInvited: false,
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("button", { name: INVITE_ACTION_NAME })
    ).toBeVisible();
  },
};

function seededCache(
  host: OnboardingHost,
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
) {
  return [
    [
      guidedOnboardingKeys.snapshot(host, STORY_ORG_ID, STORY_USER_ID),
      readySnapshot(context),
    ],
  ] as const;
}

function readySnapshot(
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-story",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
      ...context,
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
