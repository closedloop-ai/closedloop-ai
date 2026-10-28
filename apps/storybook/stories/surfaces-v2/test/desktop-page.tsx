import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import {
  SidebarInset,
  SidebarProvider,
} from "@repo/design-system/components/ui/sidebar";
import { type ReactNode, useEffect, useRef } from "react";
import { waitFor } from "storybook/test";
import { Sidebar } from "../../../../desktop/src/renderer/components/layout/Sidebar";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "../../../../desktop/src/renderer/components/layout/sidebar-persistence";
import { Topbar } from "../../../../desktop/src/renderer/components/layout/Topbar";
import { DesktopFeatureFlagProvider } from "../../../../desktop/src/renderer/feature-flags/desktop-feature-flag-provider";
import { buildBreadcrumbs } from "../../../../desktop/src/renderer/navigation/breadcrumb-model";
import {
  NavSection,
  navSectionFor,
} from "../../../../desktop/src/renderer/navigation/nav-config";
import type { NavId } from "../../../../desktop/src/renderer/navigation/route-table";
import { useDesktopNavGates } from "../../../../desktop/src/renderer/navigation/use-nav-gates";
import { DesktopAuthProvider } from "../../../../desktop/src/renderer/shared-agent-sessions/desktop-auth-provider";
import { DesktopAuthStatus } from "../../../../desktop/src/shared/contracts";
import { DESKTOP_LABS_NAV_FEATURE_FLAG_KEY } from "../../../../desktop/src/shared/feature-flags-labs-detail";
import { expectActiveNavItem } from "../live-route";

/**
 * Lives under `test/` because it is story scaffolding (it stands in for the
 * Electron preload bridge), and the source gates' layer check exempts story
 * scaffolding by path: a story may mount the desktop renderer, a shipped
 * Storybook module may not.
 *
 * A Surfaces page that exists only in the desktop app: the desktop
 * renderer's own view, in the desktop shell's own frame (`App.tsx`: the
 * desktop `Sidebar`, then the `SidebarInset` holding the `Topbar` with the
 * route's breadcrumbs and the scrolling content viewport).
 *
 * Storybook has no Electron main process, so the preload bridge
 * (`window.desktopApi`) is stubbed for the story: a signed-in desktop session,
 * its PostHog flag assignment, and whatever the page itself reads
 * (`bridge`). The stub is installed during render, before the providers'
 * mount effects read it, and the previous global is put back on unmount so a
 * partial bridge never leaks into the next story in the shared jsdom sweep.
 *
 * The Labs section ships collapsed and remembers being opened. A user on a
 * Labs page opened it to get there, so for a Labs destination it is open
 * (its stored preference is put back on unmount). The window is pinned
 * online for the same reason.
 */

export const DESKTOP_STORY_USER_ID = "user_test";

/** The desktop flags every desktop page story runs with. */
const BASE_FLAGS: Record<string, boolean> = {
  // The Labs section is on, as on the web app (labs-nav-section).
  [DESKTOP_LABS_NAV_FEATURE_FLAG_KEY]: true,
};

type Bridge = Record<string, unknown>;

function signedInBridge(flags: Record<string, boolean>): Bridge {
  return {
    getRuntimeStatus: () => Promise.resolve({ isPackaged: true }),
    getDesktopAuthState: () =>
      Promise.resolve({
        status: DesktopAuthStatus.Authenticated,
        userId: DESKTOP_STORY_USER_ID,
        organizationId: "org_test",
      }),
    getDesktopIdentity: () =>
      Promise.resolve({
        email: "dana@example.com",
        name: "Dana Reyes",
        organizationName: "ClosedLoop",
      }),
    getDesktopFeatureFlags: () =>
      Promise.resolve({
        userId: DESKTOP_STORY_USER_ID,
        resolved: true,
        flags: { ...BASE_FLAGS, ...flags },
      }),
  };
}

/**
 * Pins `navigator.onLine` to true for the story: the flag assignment closes
 * empty while offline, and Storybook shares one window across stories, so an
 * offline story before this one would otherwise hide the Labs section.
 */
function pinOnline(): () => void {
  const own = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => true,
  });
  return () => {
    if (own) {
      Object.defineProperty(navigator, "onLine", own);
    } else {
      Reflect.deleteProperty(navigator, "onLine");
    }
  };
}

function openLabsSection(): () => void {
  let previous: string | null = null;
  try {
    previous = localStorage.getItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY);
    localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, "true");
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (previous === null) {
        localStorage.removeItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY);
      } else {
        localStorage.setItem(DESKTOP_LABS_NAV_SECTION_STORAGE_KEY, previous);
      }
    } catch {
      // Storage is best-effort here, as in the section itself.
    }
  };
}

function installBridge(bridge: Bridge): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "desktopApi");
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
    writable: true,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, "desktopApi", original);
      return;
    }
    Reflect.deleteProperty(window, "desktopApi");
  };
}

function DesktopFrame({
  navId,
  children,
}: {
  navId: NavId;
  children: ReactNode;
}) {
  const { hiddenNavIds } = useDesktopNavGates();
  const breadcrumbs = buildBreadcrumbs({
    detailSessionId: null,
    detailBranchId: null,
    detailAgentSlug: null,
    detailTitle: null,
    detailTitleSettled: false,
    navId,
    sessionsListHref: "/sessions",
    branchBackHref: "/branches",
    branchBackLabel: BranchBackLabel.Branches,
    agentsListHref: "/agents",
  });
  return (
    <SidebarProvider className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <Sidebar activeNav={navId} hiddenNavIds={hiddenNavIds} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <Topbar breadcrumbs={breadcrumbs} />
        <div
          className="flex-1 overflow-auto"
          data-testid="desktop-content-viewport"
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * `navId` is the page's desktop destination; `flags` adds desktop flag
 * assignments; `bridge` adds the preload methods the page reads.
 */
export function DesktopPage({
  navId,
  flags = {},
  bridge = {},
  children,
}: {
  navId: NavId;
  flags?: Record<string, boolean>;
  bridge?: Bridge;
  children: ReactNode;
}) {
  const restore = useRef<(() => void) | null>(null);
  if (restore.current === null) {
    const restoreBridge = installBridge({
      ...signedInBridge(flags),
      ...bridge,
    });
    const restoreLabs =
      navSectionFor(navId) === NavSection.Labs
        ? openLabsSection()
        : () => undefined;
    const restoreOnline = pinOnline();
    restore.current = () => {
      restoreOnline();
      restoreLabs();
      restoreBridge();
    };
  }
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    []
  );
  return (
    <DesktopAuthProvider>
      <DesktopFeatureFlagProvider>
        <DesktopFrame navId={navId}>{children}</DesktopFrame>
      </DesktopFeatureFlagProvider>
    </DesktopAuthProvider>
  );
}

/**
 * `expectActiveNavItem` for the desktop sidebar, which renders its Labs items
 * only once the bridge's flag assignment has arrived.
 */
export async function expectActiveDesktopNavItem(
  canvasElement: HTMLElement,
  name: string
) {
  await waitFor(() => expectActiveNavItem(canvasElement, name), {
    timeout: 5000,
  });
}
