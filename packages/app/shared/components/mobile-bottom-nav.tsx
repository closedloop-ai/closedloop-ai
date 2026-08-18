"use client";

import { useSidebar } from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { MenuIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useFeatureFlagEnabled } from "../feature-flags/use-feature-flag-enabled";
import { ArtifactFlag } from "../lib/artifact-flags";
import {
  MOBILE_NAV_MAX_DESTINATIONS,
  resolveMobileNavDestinations,
} from "../lib/primary-nav-destinations";

/**
 * Mobile bottom navigation shown below `md`. Renders the explicit phone
 * destination set from the shared registry
 * ({@link resolveMobileNavDestinations} over MOBILE_NAV_PHONE_DESTINATION_PATHS)
 * so its shape stays fixed regardless of feature-flag state and both surfaces
 * FEA-4155 unblanks (Sessions, Branches) reach the bar — the earlier prefix
 * slice off {@link PRIMARY_NAV_DESTINATIONS} flipped slot four between Issues and
 * Sessions per flag and left Branches menu-only (bot review #3789). Title, icon,
 * and any flag gating still come from the registry, so the two navs cannot drift.
 *
 * Native bottom navs cap at five slots. The last slot is always the menu
 * affordance (it opens the sidebar Sheet, the only chrome that reaches every
 * authenticated route on the header-less phone pages), so at most
 * {@link MOBILE_NAV_MAX_DESTINATIONS} destinations render inline; any enabled
 * overflow stays reachable from that Sheet.
 *
 * Shared across web and desktop via the injected navigation and feature-flag
 * ports; the bar is mounted only by the web `apps/app` shell (its layout owns
 * the mount point), so the desktop renderer is unaffected until it opts in.
 */
export function MobileBottomNav() {
  const pathname = usePath();
  const buildOrgPath = useOrgPath();
  const { toggleSidebar } = useSidebar();

  // Resolve every flag a phone destination could gate on up front with one
  // fixed top-level hook call per distinct key (rules-of-hooks: the call order
  // never varies across renders). The current phone set is all always-on; the
  // Issues flag is resolved so a future gated phone destination stays covered
  // without moving hook calls.
  const issuesEnabled = useFeatureFlagEnabled(ArtifactFlag.Issues);

  // Feature-flag visibility resolves client-side, so gate the bar until mount
  // to keep the server and first client render identical (no hydration
  // mismatch, no items popping in). SSR-stable default: render nothing.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const flagState: Record<string, boolean> = {
    [ArtifactFlag.Issues]: issuesEnabled,
  };

  const visibleDestinations = resolveMobileNavDestinations(flagState);

  return (
    <nav
      aria-label="Primary"
      // Fixed to the viewport bottom below `md`. The row floors at
      // `min-h-bottom-nav-height` (the same token the shell reserves as content
      // padding, so the fixed bar never clips the last row) rather than a fixed
      // height, so the `pb-safe` home-indicator inset extends the bar instead of
      // squeezing the cells under it (`box-sizing: border-box`). `--z-bottom-nav`
      // sits above content but below overlays/modals. Hidden at `md+` where the
      // desktop sidebar takes over.
      className="fixed inset-x-0 bottom-0 z-[var(--z-bottom-nav)] flex min-h-bottom-nav-height items-stretch border-t bg-sidebar pb-safe md:hidden"
    >
      {visibleDestinations.map((destination) => {
        const href = buildOrgPath(destination.path);
        const isActive = isBottomNavItemActive(pathname, href);
        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={bottomNavItemClassName(isActive)}
            href={href}
            key={destination.title}
          >
            <destination.icon aria-hidden className="size-icon-md shrink-0" />
            <span className="truncate">{destination.title}</span>
          </Link>
        );
      })}
      {/* Menu affordance: toggles the sidebar Sheet (via the same `useSidebar`
          context the catalog `SidebarTrigger` uses) so it reaches every route,
          including the pages that render no Header where the trigger otherwise
          lives. Rendered as the same icon-over-label stack as the destinations
          so the row scans as one uniform rhythm rather than a lone floating
          icon; the visible "Menu" label is also its accessible name. */}
      <button
        className={bottomNavItemClassName(false)}
        onClick={toggleSidebar}
        type="button"
      >
        <MenuIcon aria-hidden className="size-icon-md shrink-0" />
        <span className="truncate">Menu</span>
      </button>
    </nav>
  );
}

/**
 * Router-derived active match: exact, or a descendant of the destination
 * (`/issues` stays lit on `/issues/abc`). Derived from the current path,
 * never from a scroll listener, so it does not re-render on scroll.
 */
function isBottomNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Shared cell styling for both the destination links and the menu affordance so
 * every slot in the row is the same icon-over-label stack at the same height.
 * Active state mirrors the desktop sidebar's active row exactly (accent fill +
 * accent foreground); the text color alone is too close to the resting
 * foreground to read, so the filled pill is what signals the current tab.
 */
function bottomNavItemClassName(isActive: boolean): string {
  return cn(
    "m-1 flex min-h-tap-min flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 font-medium text-xs transition-colors",
    isActive
      ? "bg-sidebar-accent text-sidebar-accent-foreground"
      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
  );
}
