import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import {
  type DesktopDeviceSessionDetails,
  desktopOnboardingKeys,
} from "@repo/app/onboarding/hooks/use-desktop-onboarding";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { DesktopConnectApproval } from "@/app/(authenticated)/[orgSlug]/settings/integrations/desktop/connect/desktop-connect-approval";
import { liveAppShellRoutes } from "./fixtures/live-app-fixtures";
import { LivePage } from "./live-page";
import { LIVE_ORG_SLUG, withLiveRoute } from "./live-route";
import { SETTINGS_PATH } from "./settings-live-page";

// ISS-11361 Target sidebar, entry 34 of 62: Desktop Connect (Sign-in & connect flow).
// The live route's own page
// (`apps/app/.../[orgSlug]/settings/integrations/desktop/connect/page.tsx`)
// in the app frame: the browser approval for a Desktop-first sign-in, opened
// at `?code=<verification code>`. The page is a server component that hands
// `DesktopConnectApproval` the code and the org slug. Each story is one state
// the page reaches from its code and the pending-session read.
//
// That read goes through `getRaw` (the API answers it without the `{ data }`
// envelope the Storybook transport adds), so the session is seeded into the
// query cache under the page's own key instead of answered by a route.

const CONNECT_PATH = `/${LIVE_ORG_SLUG}${SETTINGS_PATH}/integrations/desktop/connect`;
const USER_CODE = "KQ7M-4XPD";

function pendingSession(
  overrides: Partial<DesktopDeviceSessionDetails> = {}
): DesktopDeviceSessionDetails {
  return {
    createdAt: "2026-10-06T08:41:00.000Z",
    // Far ahead, so the request reads as still pending whenever the story runs.
    expiresAt: "2099-01-01T00:00:00.000Z",
    machineName: "Dana-MBP",
    platform: "darwin",
    status: DesktopDeviceSessionStatus.Pending,
    userCode: USER_CODE,
    webAppOrigin: "https://app.closedloop.ai",
    ...overrides,
  };
}

function connectAt(code: string, session?: DesktopDeviceSessionDetails) {
  return {
    liveRoute: {
      path: code ? `${CONNECT_PATH}?code=${code}` : CONNECT_PATH,
    },
    appCore: {
      apiRoutes: liveAppShellRoutes,
      queryData: session
        ? [[desktopOnboardingKeys.session(code), session] as const]
        : [],
    },
  };
}

/** What `page.tsx` renders for the URL the story is at. */
function DesktopConnectPage() {
  const code = useSearchParamsValue().get("code") ?? "";
  return (
    <LivePage activePath={SETTINGS_PATH}>
      <DesktopConnectApproval
        initialCode={code}
        requestedOrgSlug={LIVE_ORG_SLUG}
      />
    </LivePage>
  );
}

const meta = {
  title: "Surfaces/Workspace Menu/Settings/Desktop Connect",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <DesktopConnectPage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    ...connectAt(USER_CODE, pendingSession()),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByDisplayValue(USER_CODE)).toBeVisible();
    await expect(
      await canvas.findByText(pendingSession().webAppOrigin)
    ).toBeVisible();
  },
};

/** Opened without a code: the page asks for the one the desktop shows. */
export const NoCode: Story = { parameters: connectAt("") };

/** The request timed out before it was approved. */
export const Expired: Story = {
  parameters: connectAt(
    USER_CODE,
    pendingSession({ status: DesktopDeviceSessionStatus.Expired })
  ),
};

/** The request was already approved. */
export const AlreadyUsed: Story = {
  parameters: connectAt(
    USER_CODE,
    pendingSession({ status: DesktopDeviceSessionStatus.Approved })
  ),
};

/** The request was denied. */
export const Denied: Story = {
  parameters: connectAt(
    USER_CODE,
    pendingSession({ status: DesktopDeviceSessionStatus.Denied })
  ),
};
