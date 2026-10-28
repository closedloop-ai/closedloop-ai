import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import { WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY } from "@repo/api/src/types/workspace-menu-invite-entry-flag";
// Cross-slice on purpose (ISS-9682/ISS-9651): the gap sentence is read back out
// of onboarding's SSOT rather than typed here, so a story cannot go on showing
// copy the product stopped using.
import {
  DesktopOs,
  describeDesktopInstallerGap,
} from "@repo/app/onboarding/lib/desktop-platform-availability";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { FeatureFlagAdapterProvider } from "../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../shared/feature-flags/static-feature-flag-adapter";
import { WorkspaceMenuHostAdapterProvider } from "../../../../shared/workspace-menu-host/provider";
import type { WorkspaceMenuHostAdapter } from "../../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import {
  createDesktopGuestWorkspaceMenuHostAdapterFixture,
  createDesktopWorkspaceMenuHostAdapterFixture,
  createWebWorkspaceMenuHostAdapterFixture,
} from "../../../../shared/workspace-menu-host/workspace-menu-host-fixtures";
import { WorkspaceMenu } from "./workspace-menu";
import {
  DOWNLOAD_LOOKUP_FAILED_DETAIL,
  DownloadDesktopUnavailable,
} from "./workspace-menu-download-item";

/**
 * One presentation, two item sets — the 2026-09-03 operator ruling. Web and
 * Desktop stories sit side by side here precisely so the shared trigger and the
 * different bodies are reviewable together.
 *
 * The menu is a sidebar-header item, so every story supplies the
 * `SidebarProvider` the shell gives it in production.
 */

function withHost(adapter: WorkspaceMenuHostAdapter, children: ReactNode) {
  return (
    <NavigationProvider
      adapter={
        createMemoryNavigation({
          initialPath: "/dashboard",
          orgSlug: "closedloop",
        }).adapter
      }
    >
      <SidebarProvider>
        <WorkspaceMenuHostAdapterProvider adapter={adapter}>
          <div className="w-72 p-4">{children}</div>
        </WorkspaceMenuHostAdapterProvider>
      </SidebarProvider>
    </NavigationProvider>
  );
}

const meta = {
  title: "Composites v1.0/Settings/Workspace Menu",
  component: WorkspaceMenu,
  tags: ["deprecated", "autodocs"],
} satisfies Meta<typeof WorkspaceMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Web: Settings, Members, Download, Switch workspace, Create, Log out. */
export const Web: Story = {
  render: () =>
    withHost(createWebWorkspaceMenuHostAdapterFixture(), <WorkspaceMenu />),
};

/** Desktop: no switcher, no create, no download. Diagnostics instead. */
export const Desktop: Story = {
  render: () =>
    withHost(createDesktopWorkspaceMenuHostAdapterFixture(), <WorkspaceMenu />),
};

/** A signed-out desktop keeps Settings, Diagnostics, and the way back in. */
export const DesktopGuest: Story = {
  render: () =>
    withHost(
      createDesktopGuestWorkspaceMenuHostAdapterFixture(),
      <WorkspaceMenu />
    ),
};

/**
 * ISS-10362: desktop's invite entry, which every story above is missing because
 * none of them mounts a flag port and the gate ships closed. Without this the
 * first place the row could be looked at is production behind the rollout.
 *
 * Desktop only, deliberately — web projects the entry `Unavailable` and shows
 * "Invite and manage members" in this same slot instead.
 */
export const DesktopInviteEntry: Story = {
  render: () =>
    withHost(
      createDesktopWorkspaceMenuHostAdapterFixture(),
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [WORKSPACE_MENU_INVITE_ENTRY_FLAG_KEY],
        })}
      >
        <WorkspaceMenu />
      </FeatureFlagAdapterProvider>
    ),
};

/**
 * Identity has not settled. Reads as loading, never as signed out — and since
 * ISS-11400 the trigger is a WORKING control while it says so: Settings,
 * Diagnostics and the theme need no workspace identity, and a load that never
 * settles must not strand a user with nowhere to go.
 */
export const Pending: Story = {
  render: () =>
    withHost(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Pending,
          downloadUrl: null,
        }),
      }),
      <WorkspaceMenu />
    ),
};

/**
 * ISS-11400 — the reported defect's state: signed in on desktop, the identity
 * read resolved to nothing. The trigger keeps the honest word ("Account
 * unavailable") and the menu behind it still reaches Settings, Diagnostics, the
 * theme, and Log out, which is this user's way back in.
 */
export const ErrorWithDestinations: Story = {
  render: () =>
    withHost(
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Error,
          reason: WorkspaceMenuCapabilityReason.ReadFailed,
          downloadUrl: null,
        }),
      }),
      <WorkspaceMenu />
    ),
};

/**
 * The download entry's three withholding states (ISS-9682, ISS-9753), which no
 * story above can reach: those mount the real `WorkspaceMenu`, whose platform
 * comes from `navigator`, so they show whichever arm the viewer's own machine
 * selects, and whose release lookup does not fail on demand.
 *
 * Rendered inside a held-open menu at the shell's own `w-72` rather than bare —
 * the thing worth reviewing is the dimmed row's weight NEXT TO a live one, and
 * the gap sentence's full-strength second slot beneath it, at the width where a
 * 51-character line either fits or wraps.
 */
function withOpenMenu(children: ReactNode) {
  return (
    <div className="p-4">
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">Closedloop</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-72 rounded-xl p-1.5 shadow-xl"
        >
          <DropdownMenuItem className="py-2.5">
            {WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings]}
          </DropdownMenuItem>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Windows: the entry stays, inert, and says why instead of offering a `.dmg`. */
export const DownloadUnavailableOnWindows: Story = {
  render: () =>
    withOpenMenu(
      <DownloadDesktopUnavailable
        detail={describeDesktopInstallerGap(DesktopOs.Windows).headline}
      />
    ),
};

/**
 * Nobody has looked yet. The entry holds its slot so the items below it do not
 * jump once the read lands, and claims no gap it has not measured — which is a
 * different row from the one above, not a dimmer version of it.
 */
export const DownloadPlatformNotYetKnown: Story = {
  render: () => withOpenMenu(<DownloadDesktopUnavailable detail={null} />),
};

/**
 * The release lookup produced no usable link (ISS-9753). Same row as the two
 * above rather than a fourth spelling: it is one more reason this entry cannot
 * be offered, so it says so in the slot the other reasons use, and stays in the
 * menu's roving focus so a keyboard user hears it at all. The sentence names no
 * CAUSE, because the capability behind it covers both a failed request and a
 * rejected URL — see the component.
 */
export const DownloadLookupFailed: Story = {
  render: () =>
    withOpenMenu(
      <DownloadDesktopUnavailable detail={DOWNLOAD_LOOKUP_FAILED_DETAIL} />
    ),
};
