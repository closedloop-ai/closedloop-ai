"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@repo/design-system/components/ui/sidebar";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { usePath } from "@repo/navigation/use-path";
import type { LucideIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import {
  PROTOTYPE_SHELL_NAVIGATION_ICONS,
  PROTOTYPE_SHELL_NAVIGATION_SECTIONS,
} from "./prototype-shell-navigation";
import { PrototypeShellWorkspaceMenu } from "./prototype-shell-workspace-menu";
import { ShellSidebar } from "./shell-sidebar";

/**
 * One breadcrumb segment. Mirrors the `Crumb` shape every existing
 * prototype-local `app-shell.tsx` already takes (see
 * `apps/prototypes/app/p/web-ui-kit/components/app-shell.tsx`), so swapping a
 * hand-rolled shell for this one is a drop-in rename, not a rewrite.
 */
export type PrototypeShellCrumb = {
  readonly label: string;
  readonly href?: string;
  readonly isCurrent?: boolean;
};

/** Resolves route-aware breadcrumbs from the shell's memory-navigation path. */
export type PrototypeShellBreadcrumbs =
  | readonly PrototypeShellCrumb[]
  | ((currentPath: string) => readonly PrototypeShellCrumb[]);

export type PrototypeShellProps = {
  /** Breadcrumb trail rendered in the header, left of the actions slot. */
  readonly breadcrumbs: PrototypeShellBreadcrumbs;
  /**
   * Which nav row reads as active on FIRST render — a real path from
   * `PROTOTYPE_SHELL_NAVIGATION_SECTIONS` (`/dashboard`, `/sessions`,
   * `/branches`, `/insights`, `/packs`, `/settings`). The prototype's own
   * (mock) route never has to match it.
   *
   * It seeds the memory adapter and nothing else. After a sidebar click the
   * active row comes from that adapter's current path, so the nav reflects
   * what the reader just clicked instead of staying pinned here.
   */
  readonly activePath?: string;
  /** Optional header actions slot, same position as the local app-shells'. */
  readonly actions?: ReactNode;
  /** Additional layout classes for the shell's content region. */
  readonly contentClassName?: string;
  readonly children: ReactNode;
};

/**
 * The portable, catalog-registered prototype shell (ISS-10337): the real
 * `ShellSidebar` (`./shell-sidebar.tsx`), fed the believable static mock
 * `NavigationSectionModel[]` from `./prototype-shell-navigation.ts`, inside
 * the same `SidebarProvider` > sidebar > `SidebarInset` > header
 * (`SidebarTrigger` + breadcrumbs + an actions slot) shell every one of the 7
 * existing prototype-local `app-shell.tsx` files already hand-rolls (PLN-2026).
 *
 * `ShellSidebar`'s navigable rows are real `@repo/design-system`
 * `SidebarNavLinkItem`s, and those render through `@repo/navigation/link` —
 * which throws with no `<NavigationProvider>` ancestor
 * (`packages/navigation/provider.tsx`: "Navigation hooks require a
 * NavigationProvider ancestor"). So this shell also owns a real, mock-only
 * `@repo/navigation` adapter — `createMemoryNavigation`
 * (`packages/navigation/memory-adapter.tsx`), the same one
 * `shell-sidebar.stories.tsx`'s Storybook decorator uses, and explicitly
 * documented as "Not used in production surfaces." It carries no auth, no
 * org, and no real router: a click updates its own in-memory href store and
 * calls `preventDefault`, never the browser location, so a prototype's nav
 * stays exactly as inert and disposable as the rest of its mock data.
 *
 * The account area follows production, not a copy of it (ISS-10391).
 * Production puts the workspace/account menu in `ShellSidebar`'s
 * `workspaceHeader` slot (`web-shell-sidebar.tsx`, since ISS-10195 retired the
 * old bottom-left footer), so this shell mounts the SAME `WorkspaceMenu`
 * there, fed the fixture host adapter Storybook already uses. Because it is
 * the real component rather than hand-drawn rows, a change to the production
 * menu reaches every prototype with no edit here — which is exactly what the
 * earlier static "Invite team" / org mock could not do, and why it went stale.
 * `PrototypeShellWorkspaceMenu` owns the host adapter behind it, including
 * which entries a prototype can honestly offer. The `footer` slot is empty,
 * because production's footer has nothing a prototype can honestly show.
 *
 * Maintenance note: this file's job is parity with every caller-owned slot
 * `ShellSidebar` exposes, not just the ones already handled above. If
 * `ShellSidebar` gains a new optional prop, re-check this component against
 * it directly rather than waiting for the next screenshot to catch it.
 */
export function PrototypeShell({
  actions,
  activePath,
  breadcrumbs,
  children,
  contentClassName,
}: PrototypeShellProps) {
  const [navigationAdapter] = useState(
    () => createMemoryNavigation({ initialPath: activePath ?? "/" }).adapter
  );

  return (
    <NavigationProvider adapter={navigationAdapter}>
      <PrototypeShellFrame
        actions={actions}
        breadcrumbs={breadcrumbs}
        contentClassName={contentClassName}
      >
        {children}
      </PrototypeShellFrame>
    </NavigationProvider>
  );
}

/**
 * The shell's chrome, mounted INSIDE `NavigationProvider` so it can call
 * `usePath()`. That call is the whole reason this is a separate component:
 * `usePath` reads the adapter from context, and the provider's own render
 * cannot see its own value.
 */
function PrototypeShellFrame({
  actions,
  breadcrumbs,
  children,
  contentClassName,
}: Omit<PrototypeShellProps, "activePath">) {
  // The adapter's live path, not the initial prop: `SidebarNavLinkItem` cancels
  // browser navigation and updates the memory store instead, so reading the
  // prop here left the first row highlighted forever while the store moved on.
  const currentPath = usePath();
  const resolvedBreadcrumbs =
    typeof breadcrumbs === "function" ? breadcrumbs(currentPath) : breadcrumbs;

  return (
    <SidebarProvider className="h-svh">
      <ShellSidebar
        activePath={currentPath}
        renderIcon={(destinationId) => renderPrototypeShellIcon(destinationId)}
        sections={PROTOTYPE_SHELL_NAVIGATION_SECTIONS}
        workspaceHeader={<PrototypeShellWorkspaceMenu />}
      />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-border border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="-ml-1 text-muted-foreground" />
            <Breadcrumb>
              <BreadcrumbList>
                {resolvedBreadcrumbs.map((crumb, index) => (
                  <Fragment key={crumb.label}>
                    <BreadcrumbItem>
                      {renderPrototypeShellCrumb(crumb)}
                    </BreadcrumbItem>
                    {index < resolvedBreadcrumbs.length - 1 ? (
                      <BreadcrumbSeparator />
                    ) : null}
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          {actions ? (
            <div className="flex items-center gap-2">{actions}</div>
          ) : null}
        </header>
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto p-6",
            contentClassName
          )}
        >
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function renderPrototypeShellCrumb(crumb: PrototypeShellCrumb): ReactNode {
  if (crumb.isCurrent) {
    return <BreadcrumbPage>{crumb.label}</BreadcrumbPage>;
  }
  if (crumb.href) {
    return (
      <BreadcrumbLink asChild>
        <Link href={crumb.href}>{crumb.label}</Link>
      </BreadcrumbLink>
    );
  }
  return <BreadcrumbLink>{crumb.label}</BreadcrumbLink>;
}

/**
 * `ShellSidebar`'s `renderIcon` hands back a bare `string`, so the union the
 * icon map is keyed by has to be re-established here. An id outside the fixture
 * cannot reach this (the sections come from the same module), so the guard is a
 * narrowing, not a fallback that could hide a missing icon —
 * `PROTOTYPE_SHELL_NAVIGATION_ICONS`'s own key type is what catches that.
 */
function renderPrototypeShellIcon(destinationId: string): ReactNode {
  const Icon = (
    PROTOTYPE_SHELL_NAVIGATION_ICONS as Record<string, LucideIcon | undefined>
  )[destinationId];
  return Icon ? <Icon /> : null;
}
