import {
  GitHubAccessDenialReason,
  type GitHubClerkLinkSyncResponse,
} from "@repo/api/src/types/github";
import { GITHUB_CLERK_LINK_PATH } from "@repo/api/src/types/github-clerk-link";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { ClerkGitHubLinkClient } from "@/app/(unauthenticated)/connect/github/link/clerk-github-link-client";
import { AUTH_TRANSITION_TIMEOUT_MS } from "@/lib/github-connect-redirect";
import {
  AuthPage,
  pending,
  withClerkState,
  withFastForward,
} from "./auth-page";

// ISS-11361 Target sidebar: GitHub Link (Sign-in & connect flow).
// The live `/connect/github/link` route: `ClerkGitHubLinkClient` with the
// props `link/page.tsx` derives for a link started from Settings (no
// `returnTo`, no installation to resume), inside the live auth layout. A
// signed-in user without a verified GitHub account is handed to GitHub to
// link one; one who has it waits on the server sync. Each story is a state
// the screen reaches: in flight on either leg, stalled or unanswered (the
// screen's own timers, fired at once), refused by the sync, signed out, or
// Clerk never loading.

const VERIFIED_GITHUB_ACCOUNT = {
  id: "eac_github",
  provider: "github",
  username: "dana-reyes",
  verification: { status: "verified" },
};

/** The user has no GitHub account yet; GitHub's consent screen is opening. */
const handingOffToGitHub = withClerkState({
  user: { externalAccounts: [], createExternalAccount: pending },
});

/** The user's GitHub account is verified; the server is syncing it. */
const syncingWithServer = withClerkState({
  user: { externalAccounts: [VERIFIED_GITHUB_ACCOUNT] },
});

function clerkLinkAnswers(
  respond: () => GitHubClerkLinkSyncResponse | Promise<never>
): FixtureRoute[] {
  return [{ method: "POST", path: "/integrations/github/clerk-link", respond }];
}

const meta = {
  title: "Surfaces/Sign In/GitHub Link",
  tags: ["stable"],
  render: () => (
    <AuthPage>
      <ClerkGitHubLinkClient
        resumeInstallationId={null}
        resumePath={GITHUB_CLERK_LINK_PATH}
        returnToPath="/settings"
      />
    </AuthPage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: clerkLinkAnswers(pending) },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

async function expectPanel(canvasElement: HTMLElement) {
  const panel = within(await within(canvasElement).findByRole("status"));
  await expect(panel.getByRole("heading", { level: 1 })).toBeInTheDocument();
  return panel;
}

/** Handing off to GitHub to link the account. */
export const Default: Story = {
  decorators: [handingOffToGitHub],
  play: async ({ canvasElement }) => {
    await expectPanel(canvasElement);
  },
};

/** The GitHub account is linked; the server sync is in flight. */
export const Syncing: Story = {
  decorators: [syncingWithServer],
};

/** The GitHub hand-off is taking longer than expected. */
export const Stalled: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS]),
    handingOffToGitHub,
  ],
};

/** The server sync never answered. */
export const Unanswered: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS]),
    syncingWithServer,
  ],
  play: async ({ canvasElement }) => {
    const panel = await expectPanel(canvasElement);
    await expect(await panel.findByRole("button")).toBeInTheDocument();
  },
};

/** The sync refused the link: the organization restricts GitHub access. */
export const LinkRefused: Story = {
  decorators: [syncingWithServer],
  parameters: {
    appCore: {
      apiRoutes: clerkLinkAnswers(() => ({
        linked: false,
        reason: GitHubAccessDenialReason.OrgRestricted,
      })),
    },
  },
  play: async ({ canvasElement }) => {
    const panel = await expectPanel(canvasElement);
    await expect(await panel.findByRole("button")).toBeInTheDocument();
  },
};

/** Nobody is signed in: sign in first. */
export const SignInRequired: Story = {
  decorators: [withClerkState({ signedOut: true })],
  play: async ({ canvasElement }) => {
    const panel = await expectPanel(canvasElement);
    await expect(await panel.findByRole("link")).toBeInTheDocument();
  },
};

/** Clerk never loaded, so the link never started. */
export const NeverStarted: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS]),
    withClerkState({ loaded: false }),
  ],
  play: async ({ canvasElement }) => {
    const panel = await expectPanel(canvasElement);
    await expect(await panel.findByRole("button")).toBeInTheDocument();
  },
};
