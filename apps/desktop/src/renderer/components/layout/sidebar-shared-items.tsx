import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@closedloop-ai/design-system/components/ui/sidebar";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { GuidedGettingStartedCard } from "@repo/app/onboarding/components/guided-getting-started-card";
import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import { SessionLimitsNav } from "@repo/app/session-limits/components/session-limits-nav";
import { SessionLimitsStatus } from "@repo/app/session-limits/types";
import { SidebarSearchForm } from "@repo/app/shared/components/sidebar-search-form";
import { DevModeSidebarItem } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-sidebar-item";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { UserPlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { DESKTOP_SUBSCRIPTION_SESSION_LIMITS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags-labs-detail";
import { DESKTOP_SIDEBAR_INVITE_LABEL } from "../../../shared/invite-copy";
import { useSessionLimits } from "../../hooks/use-session-limits";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { isMacOS } from "../../platform";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useBlockingOnboardingModalOpen } from "../onboarding/blocking-onboarding-modal-store";
import { GuestGettingStartedCard } from "../onboarding/guest-getting-started-card";
import { useGuidedOnboardingRunOverride } from "../onboarding/guided-onboarding-run-override-store";
import {
  InviteSpotlightAnchor,
  InviteSpotlightPopover,
  useInviteSpotlightHighlight,
} from "../onboarding/invite-spotlight";
import { syncConsentRecordedFlag } from "../onboarding/sync-consent-recorded-flag";
import {
  canOfferAccount,
  useGuestOnboarding,
} from "../onboarding/use-guest-onboarding";
import { useSyncConsentRecord } from "../onboarding/use-sync-consent-record";
import { useDesktopWorkspaceMenuHoldsInvite } from "./desktop-invite-entry-placement";

/**
 * The desktop sidebar chrome BOTH arms render (ISS-9734, PLN-2016 D7).
 *
 * It lives here rather than in `Sidebar.tsx` because the `shell-sidebar-v2`
 * branch has two trees that must render the SAME node — a second copy behind
 * the key is how the arms drift, and the whole point of a rollback being a flag
 * flip is that the off arm is still the thing users have.
 */

/**
 * macOS hides the native title bar (main/window.ts), so the stoplight buttons
 * overlay the top-left of the window. Reserve a draggable strip — it clears the
 * stoplights off the first nav row, and doubles as the window-move handle.
 */
export function SidebarMacDragStrip() {
  if (!isMacOS()) {
    return null;
  }
  return <div aria-hidden="true" className="app-region-drag h-7 shrink-0" />;
}

/**
 * Subscription session-limit summary (PRD-538) above the gateway menu, behind
 * the `subscriptionSessionLimits` Labs toggle (ISS-4779 closed-by-default;
 * default off — the feature is not product-approved yet, Marisol 2026-08-07).
 *
 * The gate is checked HERE rather than inside the nav so that with the toggle
 * off the reading component never mounts at all: no snapshot IPC, no interval,
 * nothing. One KEY covers the whole feature — the same literal gates the
 * credential read and the `/usage` request in the main process (PRD-538 R5).
 *
 * ISS-8792 — AND ONE VERDICT. This read resolves the signed-in account's
 * PostHog assignment (the renderer's only flag source since ISS-8753), and main
 * now resolves the same assignment for the same literal through
 * `main/session-limits/session-limits-gate.ts`. So "capture can never run while
 * the bars stay hidden" holds: a persisted opt-in no longer keeps main capturing
 * behind a dark footer. Main re-attempts when the verdict lands rather than
 * snapshotting it, because `UsageApiService.start()` schedules no timer while
 * its gate reads closed.
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
 * ISS-8353: the guided-onboarding recovery card, in BOTH footers between the
 * session-limits summary and the menu. It reads its own route context rather
 * than taking it as props, so the two arms cannot hand it different return
 * targets for the same screen.
 *
 * ISS-10942: a signed-out guest gets {@link GuestGettingStartedCard} instead.
 * The two are mutually exclusive by construction — the server-owned snapshot
 * this one draws is keyed to a Clerk identity a guest does not have — so the
 * branch is made HERE rather than inside either card, and the guest arm never
 * mounts the snapshot query at all.
 */
function DesktopGuidedGettingStartedCard() {
  const guest = useGuestOnboarding();
  // ISS-11751: the takeover mounts as a shell SIBLING and covers this footer,
  // where the module then restates the step the modal is already asking — and
  // its press opens a second signup door over the first. Read from the same
  // store the tour arming gate and the invite spotlight read, so "the takeover
  // is up" has one definition rather than a third that can disagree with them.
  // The hook's render-time snapshot, not `getBlockingOnboardingModalOpen()`:
  // this only paints, and it comes back on the commit after the modal closes.
  const takeoverOpen = useBlockingOnboardingModalOpen();

  if (takeoverOpen) {
    return null;
  }
  if (canOfferAccount(guest)) {
    return <GuestGettingStartedCard />;
  }
  return <SignedInGuidedGettingStartedCard />;
}

/** The signed-in arm, split out so its hooks stay off a guest's tree. */
function SignedInGuidedGettingStartedCard() {
  const { state: authState } = useDesktopAuth();
  const syncConsent = useSyncConsentRecord(authState.userId);
  // ISS-11251: the same run the modal in the sibling tree is rendering. Without
  // it this card counted the SERVER run and posted a server transition the modal
  // was not watching, so its press did nothing at all.
  const run = useGuidedOnboardingRunOverride();

  return (
    <GuidedGettingStartedCard
      analysisStarted={true}
      host={OnboardingHost.Desktop}
      run={run}
      syncConsentReadSettled={syncConsent.isResolved}
      syncConsentRecorded={syncConsentRecordedFlag(
        syncConsent.record,
        authState.organizationId
      )}
    />
  );
}

/**
 * "Invite your team" affordance (PRD-532 §5.4 / M9). Picks between two outcomes
 * — nothing (the workspace menu is showing the entry instead, or the caller is a
 * guest, who gets the Getting started module) and {@link InviteTeamDialogItem},
 * which is the arm that mounts the shared {@link InviteTeamDialog}. That dialog
 * mints real Clerk org invitations through the BFF route; on accept the Clerk
 * membership webhook syncs a durable MEMBER into the existing org.
 */
function InviteTeamMenuItem({
  className,
}: {
  /**
   * Type size for the trigger. `SidebarMenuButton` bases at `text-base`, which
   * is right in the footer this came from and one size too large beside the v2
   * nav rows, so the v2 arm passes `text-sm` and the legacy arm passes nothing
   * — the off tree stays byte-identical while the key is closed.
   */
  readonly className?: string;
} = {}) {
  // ISS-10362 moved the signed-in entry into the workspace menu, ISS-10942
  // replaced the guest's signup door with the Getting started module above, and
  // ISS-11247 narrowed the move to the standings where that menu can actually
  // show the entry. All three verdicts live in the hook, so the row and the
  // padding cannot disagree.
  const keepsInvite = useDesktopFooterKeepsInvite();

  if (!keepsInvite) {
    return null;
  }

  return <InviteTeamDialogItem className={className} />;
}

/**
 * The footer arm that actually MOUNTS the invite dialog.
 *
 * ISS-10942 removed the ISS-5112 resume that used to live here. Its marker was
 * only ever set by the guest footer row's invite ask, and that row is gone — so
 * nothing could arm it, and an effect that can never fire is not a recovery
 * path, it is scaffolding.
 */
function InviteTeamDialogItem({ className }: { readonly className?: string }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const spotlightHighlight = useInviteSpotlightHighlight(
    InviteSpotlightAnchor.Sidebar
  );

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
              className={cn(spotlightHighlight, className)}
              tooltip={DESKTOP_SIDEBAR_INVITE_LABEL}
            >
              <UserPlusIcon className="size-4" />
              <span className="truncate">{DESKTOP_SIDEBAR_INVITE_LABEL}</span>
            </SidebarMenuButton>
          }
        />
      </InviteSpotlightPopover>
    </SidebarMenuItem>
  );
}

/**
 * The Sessions search control, with the query state both arms drive it from.
 *
 * A node rather than a component so each arm can place it where its own tree
 * wants it — inside the legacy Labs section's body, or through the v2
 * composite's `renderControl` slot — while the submit and clear destinations
 * stay stated once.
 */
export function useDesktopSidebarSearch(): ReactNode {
  const { navigate } = useNavigation();
  const searchParams = useSearchParamsValue();
  const [search, setSearch] = useState(searchParams.get("search") ?? "");

  useEffect(() => {
    setSearch(searchParams.get("search") ?? "");
  }, [searchParams]);

  return (
    <SidebarSearchForm
      onClear={() => {
        setSearch("");
        navigate(hrefForNavId(NavId.Sessions));
      }}
      onSubmit={(submittedSearch: string) => {
        navigate(buildSessionsSearchHref(submittedSearch));
      }}
      onValueChange={setSearch}
      showClear={!!search || !!searchParams.get("search")}
      value={search}
    />
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

/**
 * The footer run, stated once so the two arms cannot drift in what it holds or
 * its order. Each arm keeps its own `SidebarFooter` wrapper; the invite entry's
 * type size is the one difference between them.
 */
export function DesktopSidebarFooterItems({
  inviteClassName,
}: {
  readonly inviteClassName?: string;
} = {}) {
  return (
    <>
      <SessionLimitsFooter />
      <DesktopGuidedGettingStartedCard />
      <SidebarMenu>
        <InviteTeamMenuItem className={inviteClassName} />
        {/* ISS-12048: the Dev Mode switch, in the footer rather than Labs
            because Dev Mode off is the customer view, which closes Labs and
            would take the only way back with it (the web shell keeps its
            footer row for the same reason, ISS-11248). Renders nothing for a
            viewer who cannot operate Dev Mode. */}
        <DevModeSidebarItem />
      </SidebarMenu>
    </>
  );
}

/**
 * Whether the desktop footer still holds an invite affordance (ISS-10362).
 *
 * The signed-in entry moved into the workspace menu, where web's invite row
 * already sits — but only where {@link useDesktopWorkspaceMenuHoldsInvite} says
 * that menu is really holding it, which is narrower than the key being on
 * (ISS-11247).
 *
 * ISS-10942 took the GUEST arm away entirely: that row was a signup door, not
 * an invite entry, and the operator replaced it with the Getting started
 * module. So a guest holds no invite affordance here whatever the key says, and
 * the guest term is part of this answer rather than a second test at one of the
 * two call sites — which is what it was, and it made them disagree for every
 * guest: the row returned null while the padding still reserved space for it.
 *
 * Stated once, here, because two things need the same answer: the footer row
 * itself and the legacy arm's bottom padding. Each consumer CALLS this rather
 * than being handed a boolean — a flag threaded as an argument becomes N
 * derivations that can settle at different moments (`no-threaded-feature-flag`).
 */
export function useDesktopFooterKeepsInvite(): boolean {
  const guest = useGuestOnboarding();
  // ISS-11247: the row moves to the workspace menu only where that menu is
  // actually holding it, which is narrower than the key being on. Asked of the
  // shared predicate rather than re-derived, because the header slot needs the
  // same answer and a second copy of it is how the gates came to disagree.
  const menuHoldsInvite = useDesktopWorkspaceMenuHoldsInvite();

  if (canOfferAccount(guest)) {
    return false;
  }
  return !menuHoldsInvite;
}
