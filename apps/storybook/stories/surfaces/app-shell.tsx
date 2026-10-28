"use client";

import {
  PRIMARY_NAV_DESTINATIONS,
  PrimaryNavGroup,
} from "@repo/app/shared/lib/primary-nav-destinations";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarNavLinkItem,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { SearchIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

/**
 * The web app's authenticated shell, assembled the way
 * `apps/app/app/(authenticated)` assembles it: inset sidebar, search field,
 * the canonical nav split into its two visual groups, and a breadcrumb
 * header over the page body.
 *
 * The nav rows come from `PRIMARY_NAV_DESTINATIONS` — the same source of
 * truth the real sidebar and the mobile bottom nav both derive from — rather
 * than a hand-copied list. A destination added, renamed or reordered there
 * shows up here too, so these screens cannot quietly drift into showing
 * navigation the product no longer has.
 *
 * Feature-flagged destinations are rendered here regardless of flag state:
 * this is a design reference, and a designer looking at the shell wants to
 * see the full destination set rather than one org's rollout.
 */
const TOP_LEVEL = PRIMARY_NAV_DESTINATIONS.filter(
  (destination) => destination.group === PrimaryNavGroup.TopLevel
);
const ARTIFACTS = PRIMARY_NAV_DESTINATIONS.filter(
  (destination) => destination.group === PrimaryNavGroup.Artifact
);

/** The org slug every Surface story renders under, so hrefs across the
 * Surfaces layer resolve to one consistent org rather than drifting. */
export const ORG_SLUG = "closedloop";

export function AppScreenShell({
  activePath,
  breadcrumbs = [],
  hideHeader = false,
  children,
}: Readonly<{
  /** Org-relative path of the current destination, e.g. "/dashboard". */
  activePath: string;
  breadcrumbs?: readonly string[];
  /**
   * Skip this shell's own breadcrumb header. A Surface sets this when the real
   * content it mounts already renders the production page's own header —
   * the Document editor's `Header` (with its `SidebarTrigger`, breadcrumb, and
   * page actions) is real and needs this shell's `SidebarProvider` context,
   * but must not sit beside a second, redundant breadcrumb bar this shell
   * would otherwise draw. Every other Surface leaves this off and gets the
   * shell's own breadcrumb bar exactly as before.
   */
  hideHeader?: boolean;
  children: ReactNode;
}>) {
  return (
    <SidebarProvider>
      <Sidebar variant="inset">
        {/* A real <form>, so it needs a submit handler: without one, Enter in
            the field navigates and reloads the Storybook canvas instead of
            doing nothing. This surface has no search backend to open, so the
            submit is swallowed rather than faked. */}
        <form
          className="flex items-center px-2 pt-2.5"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="relative w-full">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <Input
              aria-label="Search"
              className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-3 pl-8 text-xs shadow-none focus-visible:bg-background"
              name="q"
              placeholder="Search"
              type="search"
            />
          </div>
        </form>

        <SidebarContent className="gap-1 pt-2">
          <SidebarGroup className="p-1">
            <NavList activePath={activePath} destinations={TOP_LEVEL} />
          </SidebarGroup>

          <SidebarCollapsibleSection title="Artifacts">
            <NavList activePath={activePath} destinations={ARTIFACTS} />
          </SidebarCollapsibleSection>
        </SidebarContent>

        <SidebarFooter>
          <div className="flex items-center gap-2 rounded-md p-2 text-sm">
            <div className="flex size-7 items-center justify-center rounded-full bg-sidebar-primary font-medium text-sidebar-primary-foreground text-xs">
              MS
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-xs">Mordecai Swinburne</p>
              <p className="truncate text-muted-foreground text-xs">
                ClosedLoop
              </p>
            </div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        {hideHeader ? null : (
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Breadcrumb>
              <BreadcrumbList>
                {breadcrumbs.map((crumb, index) => (
                  <Fragment key={crumb}>
                    {index > 0 ? <BreadcrumbSeparator /> : null}
                    <BreadcrumbItem>
                      <BreadcrumbPage>{crumb}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NavList({
  activePath,
  destinations,
}: Readonly<{
  activePath: string;
  destinations: readonly (typeof PRIMARY_NAV_DESTINATIONS)[number][];
}>) {
  return (
    <SidebarMenu className="gap-0">
      {destinations.map((destination) => (
        <SidebarNavLinkItem
          className="text-sm"
          href={`/${ORG_SLUG}${destination.path}`}
          icon={<destination.icon />}
          isActive={destination.path === activePath}
          key={destination.path}
          title={destination.title}
          tooltip={destination.title}
          trailing={
            destination.title === "Inbox" ? (
              <SidebarCountBadge count={10} />
            ) : undefined
          }
        />
      ))}
    </SidebarMenu>
  );
}
