/**
 * @file desktop-shell-navigation-transport.test.tsx
 * @description How the v2 desktop sidebar actually FETCHES its navigation
 * projection (ISS-9734, PLN-2016 D4).
 *
 * The sibling `sidebar-shell-v2.test.tsx` stubs the shared hook so its cases are
 * about the tree. This file stubs nothing above the bridge: the real
 * `useNavigationViewModel` runs through the real desktop cloud adapter, so the
 * assertions are about the request that leaves the renderer and about what the
 * sidebar renders when the cloud refuses it.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  NavigationActorStanding,
  NavigationProjectionStatus,
} from "@repo/api/src/types/navigation-view-model";
import { SHELL_SIDEBAR_V2_FLAG_KEY } from "@repo/api/src/types/shell-sidebar-v2-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ShellNavigationItemId } from "@repo/app/shared/lib/shell-navigation-contract";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CloudApiFetchResult } from "../../../../shared/cloud-api-fetch-contract";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { Sidebar } from "../Sidebar";
import { shellItemLabel } from "./shell-item-label-test-helpers";

const cloudApiFetch = vi.fn();

/** The Dashboard row, whatever state word the fold appended to its name. */
const DASHBOARD_ROW_NAME = /Dashboard/;
/** The v2 row's own label, as the shared contract declares it. */
const DASHBOARD_ROW_LABEL = shellItemLabel(ShellNavigationItemId.Dashboard);

vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: () => null,
}));
vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: () => null,
}));
vi.mock("../../../feature-flags/desktop-feature-flag-provider", async () => {
  const actual = await vi.importActual<
    typeof import("../../../feature-flags/desktop-feature-flag-provider")
  >("../../../feature-flags/desktop-feature-flag-provider");
  return { ...actual, useDesktopFeatureFlagsResolved: () => true };
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  cloudApiFetch.mockReset();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { cloudApiFetch },
  });
});

afterEach(() => {
  cleanup();
});

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/dashboard" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [SHELL_SIDEBAR_V2_FLAG_KEY],
          })}
        >
          <SidebarProvider>
            <Sidebar activeNav={NavId.Dashboard} />
          </SidebarProvider>
        </FeatureFlagAdapterProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

/**
 * A result in the BRIDGE's own envelope: `kind: "response"`, header TUPLES and
 * `bodyText`. Typed, because an object that merely resembles a `fetch` Response
 * is rejected by the adapter as malformed and fails the read exactly the way a
 * transport error does — so a status-specific case built on one renders the
 * rows it claims to prove without ever exercising that status.
 */
function bridgeResponse(
  status: number,
  statusText: string,
  body: unknown
): CloudApiFetchResult {
  return {
    bodyText: JSON.stringify(body),
    headers: [["content-type", "application/json"]],
    kind: "response",
    status,
    statusText,
  };
}

/** The navigation-view-model request the renderer marshalled, if it made one. */
async function navigationRequestPath(): Promise<string> {
  return await waitFor(() => {
    const call = cloudApiFetch.mock.calls.find((args) =>
      String(args[0]?.path ?? "").startsWith("/navigation/view-model")
    );
    if (call === undefined) {
      throw new Error("no navigation view-model request was marshalled");
    }
    return String(call[0].path);
  });
}

describe("the v2 desktop sidebar's projection read", () => {
  it("goes over the desktopApi cloud-fetch bridge with one destinations param per id", async () => {
    cloudApiFetch.mockResolvedValue(
      bridgeResponse(200, "OK", {
        data: {
          destinations: {},
          organizationId: "org-1",
          projectionStatus: NavigationProjectionStatus.Ready,
          standing: NavigationActorStanding.Member,
        },
        success: true,
      })
    );

    renderSidebar();

    const path = await navigationRequestPath();
    const requested = new URLSearchParams(path.split("?")[1] ?? "").getAll(
      "destinations"
    );
    // Repeated parameters, never comma-joined: the route reads a comma-joined
    // value as ONE id and would answer about a destination that does not exist.
    // Only the Labs container is closed here, so the offered set is the three
    // rows that live outside it.
    expect(requested).toEqual([
      ShellNavigationItemId.Branches,
      ShellNavigationItemId.Dashboard,
      ShellNavigationItemId.Sessions,
    ]);
  });

  it("renders unavailable rows, not a crash, when the cloud refuses a signed-out read", async () => {
    cloudApiFetch.mockResolvedValue(
      bridgeResponse(401, "Unauthorized", {
        error: "unauthorized",
        success: false,
      })
    );

    renderSidebar();

    await navigationRequestPath();
    // ISS-8377's accepted contract, restated for desktop: a failed read never
    // GRANTS a destination, and never removes one either — the row stays,
    // announced, and says what it does not know.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: DASHBOARD_ROW_NAME })
          .getAttribute("aria-disabled")
      ).toBe("true");
    });
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: DASHBOARD_ROW_LABEL })
    ).toBeNull();
  });
});
