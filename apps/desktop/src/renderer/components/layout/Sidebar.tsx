import {
  Avatar,
  AvatarFallback,
} from "@closedloop-ai/design-system/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { AgentsNavBadge } from "@repo/app/agents/components/agents-nav-badge";
import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import { SessionLimitsNav } from "@repo/app/session-limits/components/session-limits-nav";
import { SessionLimitsStatus } from "@repo/app/session-limits/types";
import { SidebarSearchForm } from "@repo/app/shared/components/sidebar-search-form";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { getUserNamePart } from "@repo/app/shared/lib/user-utils";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LogInIcon,
  SunMoonIcon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { useSessionLimits } from "../../hooks/use-session-limits";
import {
  type NavEntry,
  NavSection,
  navItemsForSection,
} from "../../navigation/nav-config";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { isMacOS } from "../../platform";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import {
  GuestSignupIntent,
  useGuestSignup,
} from "../onboarding/guest-signup-provider";
import {
  InviteSpotlightAnchor,
  InviteSpotlightPopover,
  useInviteSpotlightHighlight,
} from "../onboarding/invite-spotlight";
import {
  canOfferAccount,
  useGuestOnboarding,
} from "../onboarding/use-guest-onboarding";
import { ClosedloopMark } from "./closedloop-mark";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "./sidebar-persistence";

type SidebarProps = {
  activeNav: NavId;
  /** Nav ids to omit (e.g. feature-flagged-off routes). Defaults to none. */
  hiddenNavIds?: readonly NavId[];
};

/**
 * Desktop sidebar mirroring the finalized web GlobalSidebar: search on top, the
 * shared top-level / Artifacts / Gateway / Labs nav structure from nav-config,
 * and a footer account menu (identity trigger + Settings/Diagnostics + theme),
 * mirroring web's AccountMenu. Items render port links (hrefForNavId), so
 * navigation flows through the desktop navigation adapter exactly like shared
 * component links do.
 */
export function Sidebar({ activeNav, hiddenNavIds }: SidebarProps) {
  const { navigate } = useNavigation();
  const searchParams = useSearchParamsValue();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const isHidden = (entry: NavEntry) =>
    hiddenNavIds?.includes(entry.id) ?? false;
  const visible = (section: Parameters<typeof navItemsForSection>[0]) =>
    navItemsForSection(section).filter((entry) => !isHidden(entry));

  const mainItems = visible(NavSection.Main);
  const artifactItems = visible(NavSection.Artifacts);
  const gatewayItems = visible(NavSection.Gateway);
  const labsItems = visible(NavSection.Labs);
  // ISS-4478: Settings + Diagnostics render inside the footer account menu
  // (mirroring web's AccountMenu), not as a top-level sidebar section.
  const accountItems = visible(NavSection.Account);

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
            <NavSectionMenu activeNav={activeNav} items={mainItems} />
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
            // ISS-4478: Labs starts collapsed by default (expands on click, its
            // open state then persists). Explicitly `false` rather than derived
            // from FOCUS_MODE so it stays collapsed even if FOCUS_MODE is later
            // turned off.
            defaultOpen={false}
            persistenceKey={DESKTOP_LABS_NAV_SECTION_STORAGE_KEY}
            title="Labs"
          >
            <NavSectionMenu activeNav={activeNav} items={labsItems} />
          </SidebarCollapsibleSection>
        )}
      </SidebarContent>
      <SidebarFooter className="px-0 pt-1 pb-0">
        <SessionLimitsFooter />
        <SidebarMenu>
          <InviteTeamMenuItem />
          <AccountMenu accountItems={accountItems} activeNav={activeNav} />
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}

/**
 * Subscription session-limit summary (PRD-538) above the gateway menu, behind
 * the `subscriptionSessionLimits` Labs toggle (ISS-4779 closed-by-default;
 * default off — the feature is not product-approved yet, Mike 2026-08-07).
 *
 * The gate is checked HERE rather than inside the nav so that with the toggle
 * off the reading component never mounts at all: no snapshot IPC, no interval,
 * nothing. One key covers the whole feature — the same flag suppresses the
 * credential read and the `/usage` request in the main process (PRD-538 R5) —
 * so capture can never run while the bars stay hidden. Desktop-only, so there is
 * no PostHog twin to keep in lockstep.
 */
function SessionLimitsFooter() {
  const enabled = useFeatureFlagEnabled(
    DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY
  );
  if (!enabled) {
    return null;
  }
  return <SessionLimitsFooterContent />;
}

/**
 * The gated half, split out so the snapshot hook is not called at all while the
 * flag is off (hooks cannot live behind a conditional in one component).
 */
function SessionLimitsFooterContent() {
  const state = useSessionLimits();
  if (state.status === SessionLimitsStatus.Unavailable) {
    return null;
  }
  return <SessionLimitsNav state={state} />;
}

/**
 * "Invite your team" affordance (PRD-532 §5.4 / M9). Opens the shared
 * {@link InviteTeamDialog}, which mints real Clerk org invitations through the
 * BFF route; on accept the Clerk membership webhook syncs a durable MEMBER into
 * the existing org.
 */
function InviteTeamMenuItem() {
  const guest = useGuestOnboarding();
  const { requestSignup, resuming, clearResume } = useGuestSignup();
  const [inviteOpen, setInviteOpen] = useState(false);
  const spotlightHighlight = useInviteSpotlightHighlight(
    InviteSpotlightAnchor.Sidebar
  );

  // Resume the interrupted job: someone who signed up FROM here wanted to
  // invite a teammate, so give them the dialog they were reaching for.
  useEffect(() => {
    if (resuming !== GuestSignupIntent.Invite) {
      return;
    }
    setInviteOpen(true);
    clearResume();
  }, [resuming, clearResume]);

  // ISS-5112: a guest has no organization to invite anyone INTO. The dialog
  // mints real Clerk invitations against an org id, so opening it signed out is
  // a control that cannot do its job — ask for the account first.
  if (canOfferAccount(guest)) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => requestSignup(GuestSignupIntent.Invite)}
          tooltip="Invite your team"
        >
          <UserPlusIcon className="size-4" />
          <span className="truncate">Invite your team</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      {/* ISS-5489 (PLN-1694 M2): the arrival nudge points HERE — at where invite
          actually lives — whenever this item is on screen. Renders the plain
          dialog trigger otherwise. */}
      <InviteSpotlightPopover anchor={InviteSpotlightAnchor.Sidebar}>
        <InviteTeamDialog
          onOpenChange={setInviteOpen}
          open={inviteOpen}
          trigger={
            <SidebarMenuButton
              className={spotlightHighlight}
              tooltip="Invite your team"
            >
              <UserPlusIcon className="size-4" />
              <span className="truncate">Invite your team</span>
            </SidebarMenuButton>
          }
        />
      </InviteSpotlightPopover>
    </SidebarMenuItem>
  );
}

/**
 * Footer account menu mirroring the web AccountMenu shape: the trigger shows the
 * signed-in organization (or account) name with the Closedloop mark as the
 * avatar, so it reads as "me and my stuff" — a target someone hunting for
 * Settings can aim at — rather than product branding (ISS-4478 review). The
 * account destinations (Settings, Diagnostics) live here as `<Link>` menu items,
 * the same pattern web's AccountMenu uses for its Settings link, above the theme
 * controls. The active destination carries a trailing check, matching web's
 * active-org row, so opening the menu while on Settings shows you are there.
 */
function AccountMenu({
  accountItems,
  activeNav,
}: {
  accountItems: NavEntry[];
  activeNav: NavId;
}) {
  const accountLabel = useAccountLabel();
  const guest = useGuestOnboarding();
  const { requestSignup } = useGuestSignup();

  // ISS-5112: the signed-in trigger reads an organization name, and the fallback
  // reads "Account" — both claim a thing a guest does not have. An empty-state
  // avatar and the literal word "Guest" say what is actually true.
  //
  // The MENU itself stays, and that is the whole point: Settings and Diagnostics
  // have no other link site in the renderer and no Electron app-menu entry, and
  // Settings is where the Labs tab lives — including the `guest-onboarding`
  // toggle. A guest-only branch that dropped the dropdown would strip a
  // signed-out user of Settings, Diagnostics and the theme controls, and trap
  // them with no way to switch this very flag back off.
  const isGuest = canOfferAccount(guest);

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            aria-label="Open account menu"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            size="lg"
            tooltip={isGuest ? "Guest" : accountLabel}
          >
            {isGuest ? (
              // An Avatar with only its fallback — a person with no picture yet,
              // which is what a guest is. An earlier revision used a dashed
              // border, but a dashed outline means "nothing here yet" in this
              // product (the dashboard's own empty card is the other one), and a
              // guest is a person, not a missing thing.
              <Avatar className="size-8 shrink-0 rounded-lg">
                <AvatarFallback className="rounded-lg bg-muted text-muted-foreground">
                  <UserRoundIcon aria-hidden="true" className="size-4" />
                </AvatarFallback>
              </Avatar>
            ) : (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--foreground)] text-[var(--background)]">
                <ClosedloopMark />
              </div>
            )}
            <span className="truncate font-medium">
              {isGuest ? "Guest" : accountLabel}
            </span>
            <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-md"
          side="top"
          sideOffset={4}
        >
          {isGuest && (
            <>
              <DropdownMenuItem
                onSelect={() => requestSignup(GuestSignupIntent.Header)}
              >
                <LogInIcon className="size-4" />
                {/* "Create account", not "Sign In". Desktop auth is a single
                    loopback OAuth door, so a differently-named control here
                    promises a second path that does not exist — the same reason
                    `account-dialog` dropped its "Already have an account?"
                    footer — and this one opened a dialog headed "Create your
                    account". It was also the only Title Case sign-in string in
                    the renderer. */}
                Create account
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {accountItems.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <DropdownMenuItem asChild key={item.id}>
                <Link
                  aria-current={isActive ? "page" : undefined}
                  href={hrefForNavId(item.id)}
                >
                  <item.icon className="size-4" />
                  {item.label}
                  {isActive && (
                    <CheckIcon className="ml-auto size-4 text-muted-foreground" />
                  )}
                </Link>
              </DropdownMenuItem>
            );
          })}
          <ThemeSubmenu icon={<SunMoonIcon className="size-4" />} />
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/**
 * The signed-in display name for the footer account trigger: organization name,
 * then the user's name, then email, falling back to a generic "Account" label so
 * the trigger always reads as an account slot even before the identity fetch
 * settles, when signed out, or when the identity bridge is absent (test stubs).
 */
function useAccountLabel(): string {
  const { state } = useDesktopAuth();
  const { identity } = useDesktopIdentity(state.status, state.userId);
  const userName = identity ? getUserNamePart(identity) : "";
  return identity?.organizationName || userName || identity?.email || "Account";
}

function NavSectionMenu({
  items,
  activeNav,
}: {
  items: NavEntry[];
  activeNav: NavId;
}) {
  return (
    <SidebarMenu className="gap-0">
      {items.map((item) => {
        const isActive = activeNav === item.id;
        return (
          <SidebarNavLinkItem
            className="text-sm"
            href={hrefForNavId(item.id)}
            icon={<item.icon />}
            isActive={isActive}
            key={item.id}
            title={item.label}
            tooltip={item.label}
            trailing={
              item.id === NavId.Agents ? (
                // The badge reads its org scope from the injected auth port, so
                // the per-org last-visited marker is scoped automatically — a
                // shared machine with more than one desktop login no longer
                // drains one org's badge with another's visit.
                <AgentsNavBadge isActive={isActive} />
              ) : undefined
            }
          />
        );
      })}
    </SidebarMenu>
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
