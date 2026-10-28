import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { DesktopAuthorizeConsent } from "@repo/app/onboarding/components/desktop-authorize-consent";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";
import { LIVE_ORG_SLUG, withLiveRoute } from "./live-route";
import { SETTINGS_PATH } from "./settings-live-page";

// ISS-11361 Target sidebar, entry 33 of 62: Desktop Authorize (Sign-in & connect flow).
// The live route's own page
// (`apps/app/.../[orgSlug]/settings/integrations/desktop/authorize/page.tsx`)
// in the app frame: the consent card the desktop's sign-in opens in the
// browser. The page is a server component that hands `DesktopAuthorizeConsent`
// the URL's query and the org slug; `accountCreated` is false for a returning
// user. Each story is one state the page reaches from its URL.

const AUTHORIZE_PATH = `/${LIVE_ORG_SLUG}${SETTINGS_PATH}/integrations/desktop/authorize`;

const GATEWAY_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAq7mXy0Lr2vQ9kJ4tW8bZcN1sF6hD3eP5gU0aYiRxT2o=\n-----END PUBLIC KEY-----";

/** The query the desktop puts on the authorize link. */
const AUTHORIZE_QUERY: Record<string, string> = {
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge]:
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallengeMethod]: "S256",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.state]: "st_4f1c9e2a",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri]: "http://127.0.0.1:49152/cb",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayId]: "gw_7f3c2a91",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey]:
    encodeDesktopGatewayPublicKey(GATEWAY_PUBLIC_KEY_PEM),
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName]: "Dana-MBP",
  [DESKTOP_AUTHORIZE_QUERY_PARAMS.platform]: "darwin",
};

function authorizeRoute(query: Record<string, string>) {
  return {
    liveRoute: {
      path: `${AUTHORIZE_PATH}?${new URLSearchParams(query).toString()}`,
    },
  };
}

/** What `page.tsx` renders for the URL the story is at. */
function DesktopAuthorizePage() {
  const search = useSearchParamsValue();
  return (
    <LivePage activePath={SETTINGS_PATH}>
      <DesktopAuthorizeConsent
        accountCreated={false}
        requestedOrgSlug={LIVE_ORG_SLUG}
        searchParams={Object.fromEntries(search.entries())}
      />
    </LivePage>
  );
}

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Desktop Authorize",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <DesktopAuthorizePage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    ...authorizeRoute(AUTHORIZE_QUERY),
    appCore: { apiRoutes: liveAppShellRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        AUTHORIZE_QUERY[DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName]
      )
    ).toBeVisible();
    await expect(await canvas.findByText(LIVE_ORG_SLUG)).toBeVisible();
  },
};

/** The link is missing the desktop's parameters. */
export const IncompleteLink: Story = {
  parameters: authorizeRoute({}),
};

/** The link hands back to an address that is not the desktop's loopback. */
export const InvalidRedirect: Story = {
  parameters: authorizeRoute({
    ...AUTHORIZE_QUERY,
    [DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri]: "https://example.com/cb",
  }),
};
