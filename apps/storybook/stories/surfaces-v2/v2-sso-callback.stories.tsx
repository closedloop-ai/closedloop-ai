import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { SsoCallbackClient } from "@/app/(unauthenticated)/sso-callback/sso-callback-client";
import { env } from "@/env";
import {
  HANDSHAKE_FAILURE_TITLE,
  HANDSHAKE_WAITING_TITLE,
} from "@/lib/auth-transition-copy";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  buildSignInFallbackHref,
  GITHUB_CONNECT_REDIRECT_PARAM,
  resolveDesktopSignInProviderFromSearchParams,
  resolveGitHubConnectRedirectFromSearchParams,
} from "@/lib/github-connect-redirect";
import { AuthPage, withFastForward } from "./auth-page";

// ISS-11361 Target sidebar: SSO Callback (Sign-in & connect flow).
// The live `/sso-callback` route: `SsoCallbackClient` with the props
// `sso-callback/page.tsx` derives from the query `/connect/github` sends
// (`provider`, `redirect_url`), inside the live auth layout. The screen holds
// a "finishing sign-in" panel while Clerk completes the OAuth handshake, then
// offers a way out once it stalls and again once the request goes unanswered;
// those two states are reached by firing the screen's own timers at once.

type Search = Record<string, string>;

const GITHUB_SEARCH: Search = {
  provider: DesktopSignInProvider.GitHub,
  [GITHUB_CONNECT_REDIRECT_PARAM]: "/org-test/dashboard",
};

/** What `sso-callback/page.tsx` hands its client for this query. */
function SsoCallbackPage({ search }: { search: Search }) {
  const fallbackRedirectUrl = resolveGitHubConnectRedirectFromSearchParams(
    search,
    env.NEXT_PUBLIC_APP_URL
  );
  return (
    <SsoCallbackClient
      fallbackRedirectUrl={fallbackRedirectUrl}
      fallbackSignInHref={buildSignInFallbackHref(fallbackRedirectUrl)}
      provider={resolveDesktopSignInProviderFromSearchParams(search)}
    />
  );
}

const meta = {
  title: "Surfaces/Sign In/SSO Callback",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <AuthPage>
      <SsoCallbackPage
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

/** The GitHub handshake is in flight. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: HANDSHAKE_WAITING_TITLE })
    ).toBeInTheDocument();
  },
};

/** The same, for a Google sign-in. */
export const Google: Story = {
  parameters: {
    search: { ...GITHUB_SEARCH, provider: DesktopSignInProvider.Google },
  },
};

/** The handshake has taken longer than expected: a way out appears. */
export const Stalled: Story = {
  decorators: [withFastForward([AUTH_TRANSITION_TIMEOUT_MS])],
  play: async ({ canvasElement }) => {
    const panel = within(await within(canvasElement).findByRole("status"));
    await expect(await panel.findByRole("link")).toBeInTheDocument();
  },
};

/** The handshake never answered: the screen says it failed. */
export const Unanswered: Story = {
  decorators: [
    withFastForward([AUTH_TRANSITION_TIMEOUT_MS, DEFAULT_API_TIMEOUT_MS]),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: HANDSHAKE_FAILURE_TITLE })
    ).toBeInTheDocument();
  },
};
