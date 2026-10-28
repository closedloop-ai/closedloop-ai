import { AuthErrorCode } from "@repo/api/src/types/auth-error";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  clearAuthRejection,
  publishAuthRejectionIfAuthError,
} from "@repo/app/shared/query/auth-rejection-store";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useEffect, useState } from "react";
import { expect, within } from "storybook/test";
import DashboardPage from "@/app/(authenticated)/[orgSlug]/dashboard/page";
import { WorkspaceAuthGuard } from "@/app/(authenticated)/components/workspace-auth-guard";
import { dashboardApiRoutes } from "./fixtures/dashboard-fixtures";
import { LivePage } from "./live-page";
import { expectActiveNavItem } from "./live-route";

// ISS-11361 Target sidebar, entry 61 of 62: Workspace Access Failed (System
// state). The live layout wraps every page in `WorkspaceAuthGuard`
// (`apps/app/app/(authenticated)/components/workspace-auth-guard.tsx`), which
// replaces the page with a recovery card when the session cannot be used and
// keeps the sidebar. Here the page behind it is the Dashboard.
//
// Default is the guard's own trip: `/me` answers 401. The other states are
// latched by the app's shared query boundary when ANY query is rejected with
// a server-tagged auth code; Storybook's query client has no such boundary,
// so those stories publish the same rejection to the same store the boundary
// writes to, and clear it on unmount.

function meRejected(status: number): FixtureRoute {
  return { method: "GET", path: "/me", respond: () => null, status };
}

/** Latches a cross-query rejection for the life of the story. */
function withLatchedRejection(error: ApiError): Decorator {
  function LatchedRejection({ children }: { children: ReactNode }) {
    useState(() => {
      clearAuthRejection();
      publishAuthRejectionIfAuthError(error);
      return null;
    });
    useEffect(() => clearAuthRejection, []);
    return <>{children}</>;
  }
  return (Story) => (
    <LatchedRejection>
      <Story />
    </LatchedRejection>
  );
}

const meta = {
  title: "Surfaces/System States/Workspace Access Failed",
  tags: ["stable"],
  render: () => (
    <LivePage activePath="/dashboard">
      <WorkspaceAuthGuard>
        <DashboardPage />
      </WorkspaceAuthGuard>
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: [meRejected(401), ...dashboardApiRoutes] },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** `/me` answers 401: the session expired. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toBeVisible();
    await expectActiveNavItem(canvas, "Dashboard");
  },
};

/** `/me` answers 403: the identity probe trips on either status. */
export const IdentityForbidden: Story = {
  parameters: {
    appCore: { apiRoutes: [meRejected(403), ...dashboardApiRoutes] },
  },
};

/**
 * A query was refused with `org_forbidden`: the session is live but the
 * organization could not be confirmed, so Retry leads.
 */
export const OrganizationUnconfirmed: Story = {
  decorators: [
    withLatchedRejection(
      new ApiError("Forbidden", 403, { code: AuthErrorCode.OrgForbidden })
    ),
  ],
  parameters: { appCore: { apiRoutes: dashboardApiRoutes } },
};

/**
 * A query failed with `org_unverifiable`: the identity provider lookup
 * failed, so Retry is the only recovery offered.
 */
export const OrganizationUnverifiable: Story = {
  decorators: [
    withLatchedRejection(
      new ApiError("Service unavailable", 503, {
        code: AuthErrorCode.OrgUnverifiable,
      })
    ),
  ],
  parameters: { appCore: { apiRoutes: dashboardApiRoutes } },
};
