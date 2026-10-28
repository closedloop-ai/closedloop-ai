import {
  DesktopSignInFraming,
  DesktopSignInMethod,
  DesktopSignInProvider,
  providerForSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { SignIn } from "@repo/auth/components/sign-in";
import { SignUp } from "@repo/auth/components/sign-up";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { GitHubConnectRedirectClient } from "@/app/(unauthenticated)/connect/github/github-connect-redirect-client";
import { env } from "@/env";
import {
  handoffFailureTitle,
  handoffWaitingTitle,
} from "@/lib/auth-transition-copy";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  buildSignInFallbackHref,
  DESKTOP_SIGN_IN_PROVIDER_LABEL,
  GITHUB_CONNECT_REDIRECT_PARAM,
  resolveDesktopSignInFramingFromSearchParams,
  resolveDesktopSignInMethodFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
} from "@/lib/github-connect-redirect";
import { AuthPage, withClerkState, withFastForward } from "./auth-page";

// ISS-11361 Target sidebar: GitHub Connect (Sign-in & connect flow).
// The live `/connect/github` route, where the desktop app's browser sign-in
// lands: `connect/github/page.tsx` sends a social method straight on to the
// provider through `GitHubConnectRedirectClient`, and the email method to
// Clerk's embed, all inside the live auth layout. Each story is the query the
// desktop sends plus the state the redirect reaches: in flight, stalled,
// unanswered (the screen's own timers, fired at once), refused by Clerk, or
// never started because Clerk did not load.

type Search = Record<string, string>;

const GITHUB_SEARCH: Search = {
  provider: DesktopSignInMethod.GitHub,
  [GITHUB_CONNECT_REDIRECT_PARAM]: "/settings/integrations/desktop/authorize",
};
const GITHUB_LABEL =
  DESKTOP_SIGN_IN_PROVIDER_LABEL[DesktopSignInProvider.GitHub];

/** What `connect/github/page.tsx` renders for this query. */
function ConnectGitHubPage({ search }: { search: Search }) {
  const target = resolveGitHubConnectRedirectFromSearchParams(
    search,
    env.NEXT_PUBLIC_APP_URL
  );
  const provider = providerForSignInMethod(
    resolveDesktopSignInMethodFromSearchParams(search)
  );
  if (!provider) {
    if (
      resolveDesktopSignInFramingFromSearchParams(search) ===
      DesktopSignInFraming.SignIn
    ) {
      return (
        <SignIn
          forceRedirectUrl={target}
          routing="hash"
          signUpForceRedirectUrl={target}
        />
      );
    }
    return (
      <SignUp
        forceRedirectUrl={target}
        routing="hash"
        signInForceRedirectUrl={target}
      />
    );
  }
  return (
    <GitHubConnectRedirectClient
      fallbackSignInHref={buildSignInFallbackHref(target)}
      provider={provider}
      redirectUrlComplete={target}
    />
  );
}

const meta = {
  title: "Surfaces/Sign In/GitHub Connect",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <AuthPage>
      <ConnectGitHubPage
        search={(parameters.search as Search | undefined) ?? GITHUB_SEARCH}
      />
    </AuthPage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The hand-off to GitHub is under way. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: handoffWaitingTitle(GITHUB_LABEL),
      })
    ).toBeInTheDocument();
  },
};

/** The same, for Google. */
export const Google: Story = {
  parameters: {
    search: { ...GITHUB_SEARCH, provider: DesktopSignInMethod.Google },
  },
};

/** The desktop picked email: Clerk's sign-up embed. */
export const Email: Story = {
  parameters: {
    search: { ...GITHUB_SEARCH, provider: DesktopSignInMethod.Email },
  },
};

/** The hand-off has taken longer than expected: a way out appears. */
export const Stalled: Story = {
  decorators: [withFastForward([AUTH_TRANSITION_TIMEOUT_MS])],
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("status"));
    await expect(await panel.findByRole("link")).toBeInTheDocument();
  },
};

/** The hand-off never answered. */
export const Unanswered: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS]),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: handoffFailureTitle(GITHUB_LABEL),
      })
    ).toBeInTheDocument();
  },
};

/** Clerk refused to start the redirect. */
export const Refused: Story = {
  decorators: [
    withClerkState({
      sso: () => Promise.reject(new Error("Clerk refused the redirect")),
    }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: handoffFailureTitle(GITHUB_LABEL),
      })
    ).toBeInTheDocument();
  },
};

/** Clerk never loaded, so the redirect never started. */
export const NeverStarted: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS]),
    withClerkState({ loaded: false }),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: handoffFailureTitle(GITHUB_LABEL),
      })
    ).toBeInTheDocument();
  },
};
