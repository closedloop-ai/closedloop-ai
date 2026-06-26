import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNavLinkItem,
  Sidebar as SidebarRoot,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@closedloop-ai/design-system/components/ui/sidebar-collapsible-section";
import { ThemeSubmenu } from "@closedloop-ai/design-system/components/ui/theme-submenu";
import { SidebarSearchForm } from "@repo/app/shared/components/sidebar-search-form";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  ChevronsUpDownIcon,
  Loader2Icon,
  SettingsIcon,
  SunMoonIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  FOCUS_MODE,
  type NavEntry,
  navItemsForSection,
} from "../../navigation/nav-config";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { isMacOS } from "../../platform";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "./sidebar-persistence";
import { useDashboardReady } from "./use-dashboard-ready";

type SidebarProps = {
  activeNav: NavId;
  runtimeHealthy: boolean;
  /** Nav ids to omit (e.g. feature-flagged-off routes). Defaults to none. */
  hiddenNavIds?: readonly NavId[];
};

/**
 * Desktop sidebar mirroring the finalized web GlobalSidebar: search on top, the
 * shared top-level / Artifacts / Gateway / Labs nav structure from nav-config,
 * and a footer with the gateway health state and product branding. Items render
 * port links (hrefForNavId), so navigation flows through the desktop navigation
 * adapter exactly like shared component links do.
 */
export function Sidebar({
  activeNav,
  runtimeHealthy,
  hiddenNavIds,
}: SidebarProps) {
  const { navigate } = useNavigation();
  const searchParams = useSearchParamsValue();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const isHidden = (entry: NavEntry) =>
    hiddenNavIds?.includes(entry.id) ?? false;
  const visible = (section: Parameters<typeof navItemsForSection>[0]) =>
    navItemsForSection(section).filter((entry) => !isHidden(entry));

  const mainItems = visible("main");
  const artifactItems = visible("artifacts");
  const gatewayItems = visible("gateway");
  const labsItems = visible("labs");

  // Sessions is the landing page; the local-first Dashboard ingests in the
  // background. Mounting the Dashboard runs synchronous local-DB reads on the
  // main thread, so we must not let it open until ready: the nav item shows a
  // throbber and is disabled while preparing, then becomes a normal menu item.
  const dashboardReady = useDashboardReady();

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
  }, [searchParams]);

  const handleSearchSubmit = (submittedSearch: string) => {
    navigate(buildSessionsSearchHref(submittedSearch));
  };

  const clearSearch = () => {
    setSearch("");
    navigate(hrefForNavId(NavId.Sessions));
  };

  return (
    <SidebarRoot collapsible="offcanvas" variant="inset">
      {/* macOS hides the native title bar (main/window.ts), so the stoplight
          buttons overlay the top-left of the window. Reserve a draggable strip
          here — its height lines the search up with the content below the
          Topbar, and the strip doubles as the window-move handle. */}
      {isMacOS() && (
        <div aria-hidden="true" className="app-region-drag h-7 shrink-0" />
      )}
      <SidebarSearchForm
        onClear={clearSearch}
        onSubmit={handleSearchSubmit}
        onValueChange={setSearch}
        showClear={!!search || !!searchParams.get("search")}
        value={search}
      />
      <SidebarContent className="gap-1 pt-2">
        {mainItems.length > 0 && (
          <SidebarGroup className="px-0 py-1">
            <NavSectionMenu
              activeNav={activeNav}
              dashboardReady={dashboardReady}
              items={mainItems}
            />
          </SidebarGroup>
        )}

        {artifactItems.length > 0 && (
          <SidebarCollapsibleSection className="px-0 py-1" title="Artifacts">
            <NavSectionMenu activeNav={activeNav} items={artifactItems} />
          </SidebarCollapsibleSection>
        )}

        {gatewayItems.length > 0 && (
          <SidebarCollapsibleSection className="px-0 py-1" title="Gateway">
            <NavSectionMenu activeNav={activeNav} items={gatewayItems} />
          </SidebarCollapsibleSection>
        )}

        {labsItems.length > 0 && (
          <SidebarCollapsibleSection
            className="px-0 py-1"
            defaultOpen={!FOCUS_MODE}
            persistenceKey={DESKTOP_LABS_NAV_SECTION_STORAGE_KEY}
            title="Labs"
          >
            <NavSectionMenu activeNav={activeNav} items={labsItems} />
          </SidebarCollapsibleSection>
        )}
      </SidebarContent>
      <SidebarFooter className="px-0 pt-1 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-xs"
              tooltip={runtimeHealthy ? "Gateway healthy" : "Gateway unhealthy"}
            >
              <span
                className={`size-2 shrink-0 rounded-full ${
                  runtimeHealthy
                    ? "bg-[var(--success)]"
                    : "bg-[var(--destructive)]"
                }`}
              />
              <span className="truncate">
                {runtimeHealthy ? "Gateway healthy" : "Gateway unhealthy"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <GatewayMenu />
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}

/**
 * Footer gateway menu mirroring the web AccountMenu: the branded "Closedloop
 * Gateway" button opens a dropdown with settings and theme controls. Settings
 * routes to the Settings (Labs) page for now.
 */
function GatewayMenu() {
  const { navigate } = useNavigation();

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            size="lg"
            tooltip="Closedloop Gateway"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--foreground)] text-[var(--background)]">
              <ClosedloopMark />
            </div>
            <span className="truncate font-medium">Closedloop Gateway</span>
            <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-md"
          side="top"
          sideOffset={4}
        >
          <DropdownMenuItem
            onSelect={() => navigate(hrefForNavId(NavId.Settings))}
          >
            <SettingsIcon className="size-4" />
            Settings
          </DropdownMenuItem>
          <ThemeSubmenu icon={<SunMoonIcon className="size-4" />} />
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function NavSectionMenu({
  items,
  activeNav,
  dashboardReady = true,
}: {
  items: NavEntry[];
  activeNav: NavId;
  /**
   * Whether the local-first Dashboard analytics are ready. While false, the
   * Dashboard nav item is disabled and shows a throbber so it cannot be opened
   * (and block the main thread) before its data has finished computing.
   */
  dashboardReady?: boolean;
}) {
  return (
    <SidebarMenu className="gap-0">
      {items.map((item) => {
        const preparing = item.id === NavId.Dashboard && !dashboardReady;
        return (
          <SidebarNavLinkItem
            className="text-sm"
            disabled={preparing}
            href={hrefForNavId(item.id)}
            icon={<item.icon />}
            isActive={activeNav === item.id}
            key={item.id}
            title={item.label}
            tooltip={preparing ? "Dashboard · preparing…" : item.label}
            trailing={preparing ? <DashboardThrobber /> : undefined}
          />
        );
      })}
    </SidebarMenu>
  );
}

/** Spinner shown on the Dashboard nav item while local analytics ingest. */
function DashboardThrobber() {
  return (
    <Loader2Icon
      aria-label="Preparing dashboard"
      className="ml-auto size-3 shrink-0 animate-spin text-muted-foreground"
    />
  );
}

function ClosedloopMark() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      viewBox="0 0 100 100"
    >
      <path
        d="M0.424623 49.6765C0.339767 56.2176 1.55939 62.7103 4.01272 68.7779C6.46604 74.8455 10.1042 80.3673 14.7161 85.0227C19.3281 89.6781 24.8219 93.3744 30.8788 95.8973C36.9358 98.4202 43.4352 99.7193 50 99.7193C56.5648 99.7193 63.0643 98.4202 69.1212 95.8973C75.1782 93.3744 80.672 89.6781 85.2839 85.0227C89.8958 80.3673 93.534 74.8455 95.9873 68.7779C98.4406 62.7103 99.6603 56.2176 99.5754 49.6765C99.5754 49.5115 99.5754 49.3546 99.5754 49.1895H71.7496C71.7496 49.3546 71.7496 49.5115 71.7496 49.6765C71.7496 53.9658 70.473 58.1587 68.0814 61.7249C65.6898 65.2912 62.2906 68.0706 58.3136 69.7117C54.3367 71.3527 49.9606 71.7817 45.739 70.9443C41.5174 70.1069 37.6398 68.0408 34.5966 65.0072C31.5535 61.9737 29.4815 58.109 28.6428 53.902C27.804 49.695 28.2361 45.3346 29.8845 41.3723C31.5329 37.4101 34.3235 34.0239 37.9033 31.6421C41.4831 29.2603 45.6914 27.9899 49.9959 27.9915H50.0704L50.0373 0.280626C43.524 0.275203 37.0735 1.54886 31.0545 4.02881C25.0354 6.50876 19.5659 10.1464 14.9583 14.7338C10.3508 19.3211 6.69575 24.7683 4.20197 30.764C1.70819 36.7597 0.424621 43.1863 0.424623 49.6765Z"
        fill="currentColor"
      />
      <path
        d="M57.1534 0.801147V29.2137C60.1811 30.2616 62.939 31.9629 65.2303 34.1961C67.5215 36.4293 69.2895 39.1392 70.4077 42.1323H99.004C97.3792 31.6897 92.4381 22.0411 84.906 14.6024C77.3738 7.16375 67.6471 2.32669 57.1534 0.801147Z"
        fill="#41A3FF"
      />
    </svg>
  );
}

function buildSessionsSearchHref(search: string): string {
  const trimmed = search.trim();
  if (!trimmed) {
    return hrefForNavId(NavId.Sessions);
  }
  const params = new URLSearchParams({ search: trimmed });
  return `${hrefForNavId(NavId.Sessions)}?${params.toString()}`;
}
