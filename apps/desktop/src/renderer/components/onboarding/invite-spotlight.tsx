import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@closedloop-ai/design-system/components/ui/popover";
import { useSidebar } from "@closedloop-ai/design-system/components/ui/sidebar";
import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  hasRecordedSyncConsent,
  type SyncConsentRecord,
} from "../../../shared/sync-consent";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  inviteSpotlightDismissedStorageKey,
  readFlag,
  writeFlag,
} from "../dashboard/dashboard-storage-keys";
import { useBlockingOnboardingModalOpen } from "./blocking-onboarding-modal-store";
import { readSettingsInviteSpotlightAnswers } from "./invite-spotlight-settings-answers";
import { useSyncConsentRecord } from "./use-sync-consent-record";

/** Which host element the pop-up hangs off. Exactly one is on screen at a time. */
export const InviteSpotlightAnchor = {
  /**
   * The sidebar's invite affordance. Which control that IS moved with ISS-10362:
   * the footer item while the entry lives there, and the workspace-menu trigger
   * once it does not — the menu is closed at rest, so the invite row inside it is
   * not on screen to be pointed at.
   *
   * ISS-11247: "once it does not" is `useDesktopWorkspaceMenuHoldsInvite`, not
   * the `workspace-menu-invite-entry` key. The entry only reaches that menu in
   * the `Ready` standing, so in any other one the footer still holds the row and
   * is still the host — both hosts reading one predicate is what keeps the
   * one-at-a-time sentence above true, since nothing here enforces it.
   */
  Sidebar: "sidebar",
  /**
   * The topbar's sidebar toggle. Below 768px the sidebar is an offcanvas sheet,
   * so its invite item is not on screen at all; anchoring there would point the
   * pop-up at nothing. The toggle is the control that reveals it, and it is
   * always visible.
   */
  Topbar: "topbar",
} as const;
export type InviteSpotlightAnchor =
  (typeof InviteSpotlightAnchor)[keyof typeof InviteSpotlightAnchor];

export const INVITE_SPOTLIGHT_TITLE = "Share with your team";
export const INVITE_SPOTLIGHT_BODY =
  "Invite your team to see their sessions and the agentic components they are using on this page.";
export const INVITE_SPOTLIGHT_DISMISS_LABEL = "Maybe later";
export const INVITE_SPOTLIGHT_INVITE_LABEL = "Invite your team";

/** Ring applied to whichever control the pop-up is pointing at, while it is open. */
export const INVITE_SPOTLIGHT_RING_CLASS =
  "ring-2 ring-primary/50 ring-offset-1";

type InviteSpotlightState = {
  /** The host that owns the anchor right now, or null when nothing must show. */
  anchor: InviteSpotlightAnchor | null;
  open: boolean;
  /** Any close is an answer — "Maybe later", Escape and outside-click alike. */
  onOpenChange: (open: boolean) => void;
  onInvite: () => void;
};

const DORMANT: InviteSpotlightState = {
  anchor: null,
  open: false,
  onOpenChange: () => {
    // No provider, nothing to close.
  },
  onInvite: () => {
    // No provider, no dialog to open.
  },
};

const InviteSpotlightContext = createContext<InviteSpotlightState>(DORMANT);

/**
 * What this install has already answered about the invite nudge, and for which
 * org. `organizationId` is the org the answer was READ for — compared against
 * the signed-in one so a stale answer from the previous org is never applied.
 */
type InviteSpotlightDismissal = {
  organizationId: string | null;
  dismissed: boolean;
};

const UNREAD_DISMISSAL: InviteSpotlightDismissal = {
  organizationId: null,
  dismissed: false,
};

/**
 * Whether the arrival invite nudge should be on screen.
 *
 * Pure, so the decision is testable without a window, a bridge or a flag
 * snapshot. Every arm is a withhold: a pop-up that fires at the wrong moment
 * (over the blocking consent takeover, at a guest with no org to invite anyone
 * into, or at someone who already said "Maybe later") is worse than one that
 * waits for the next launch.
 */
export function shouldShowInviteSpotlight({
  authStatus,
  guidedOnboardingOpen,
  organizationId,
  record,
  recordResolved,
  dismissal,
}: {
  authStatus: DesktopAuthStatus;
  /**
   * ISS-11315 Defect 5: the guided onboarding takeover is on screen.
   *
   * The wizard's own Continue on the sync step calls `recordSyncConsent`, which
   * flips `hasRecordedSyncConsent` — and every other arm here was already
   * satisfied by then, so the nudge opened UNDER the wizard while it advanced
   * to its own invite step. Measured on the operator's 2026-09-27 recording:
   * up at 109.875s behind the dialog, gone by 110.875s, never answered.
   *
   * IT IS NOT COSMETIC, which is why this is an arm and not a delay. `open`
   * and `onOpenChange` are wired straight to Radix's `Popover`, and
   * `onOpenChange(false)` is `answer()` — the write of
   * `inviteSpotlightDismissedStorageKey`. Radix closes a popover on a
   * focus-outside, and the wizard takes focus on every step change, so the
   * auto-close ran `answer()` and PERMANENTLY consumed the arrival nudge for
   * that org. Nothing downstream can tell that apart from a deliberate "Maybe
   * later": `answer()` is the single sink for both.
   *
   * Named beside the other withholds rather than expressed as a timeout or a
   * CSS hide, because a nudge that is merely INVISIBLE is still open, and still
   * reachable by the auto-close that spends it.
   */
  guidedOnboardingOpen: boolean;
  organizationId: string | null;
  /** null = unreadable (no bridge / failed read), which withholds. */
  record: SyncConsentRecord | null;
  recordResolved: boolean;
  dismissal: InviteSpotlightDismissal;
}): boolean {
  if (authStatus !== DesktopAuthStatus.Authenticated) {
    return false;
  }
  if (guidedOnboardingOpen) {
    return false;
  }
  // The dialog this nudge points at mints real Clerk invitations against an org
  // id. With no org there is nothing to invite anyone into, so there is nothing
  // to nudge about.
  if (organizationId === null) {
    return false;
  }
  // Consent must be on record before this nudge fires. ISS-5489 read a second
  // signal here — the legacy post-auth takeover publishing what it had just
  // committed — so that a rejected or never-settling consent read could not
  // withhold the nudge from someone who had just finished that flow. ISS-10195
  // retired that takeover with the workspace-experience gate, so the shared
  // consent snapshot is the only signal left and the short-circuit it fed is
  // gone with its producer.
  if (!(recordResolved && record)) {
    return false;
  }
  if (!hasRecordedSyncConsent(record, organizationId)) {
    return false;
  }
  // An answer read for a DIFFERENT org (or not read yet) is not an answer for
  // this one. Withhold rather than flash the pop-up for one frame and retract it.
  if (dismissal.organizationId !== organizationId) {
    return false;
  }
  return !dismissal.dismissed;
}

/**
 * ISS-5489 (PLN-1694 M2) — the arrival nudge that points at "Invite your team".
 */
export function InviteSpotlightProvider({ children }: { children: ReactNode }) {
  const { state } = useDesktopAuth();
  // The same store the tour arming gate reads, and the same producer: the
  // guided dialog host's `onOpenChange`. One definition of "the takeover is up"
  // rather than a second predicate that can disagree with it.
  const guidedOnboardingOpen = useBlockingOnboardingModalOpen();
  const { record, isResolved } = useSyncConsentRecord(state.userId);
  const { isMobile, state: sidebarState } = useSidebar();
  const organizationId = state.organizationId;
  /** One string standing for "who is signed in", for the dialog's remount key. */
  const identityKey = `${state.userId ?? ""}:${organizationId ?? ""}`;
  const [dismissal, setDismissal] =
    useState<InviteSpotlightDismissal>(UNREAD_DISMISSAL);
  /**
   * WHICH identity opened the invite dialog, not merely that one is open.
   *
   * `InviteTeamDialog` keeps typed addresses when it is dismissed — only a sent
   * invitation resets them — and this provider outlives a sign-out, so a plain
   * boolean let user A leave a draft, user B reopen it, and B send A's addresses
   * into B's organization. Pairing this with the `key` below closes both halves:
   * the key discards the draft, and the identity comparison means the dialog
   * cannot come back open under someone else.
   */
  const [inviteOpenFor, setInviteOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (
      organizationId === null ||
      readFlag(inviteSpotlightDismissedStorageKey(organizationId))
    ) {
      setDismissal({ organizationId, dismissed: organizationId !== null });
      return;
    }
    // ISS-12135: an answer a seeded profile carries in its settings. Until it
    // is read the dismissal stays on the previous org, which withholds.
    let cancelled = false;
    readSettingsInviteSpotlightAnswers()
      .then((answered) => {
        if (!cancelled) {
          setDismissal({
            organizationId,
            dismissed: answered.includes(organizationId),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const answer = useCallback(() => {
    if (organizationId === null) {
      return;
    }
    writeFlag(inviteSpotlightDismissedStorageKey(organizationId));
    setDismissal({ organizationId, dismissed: true });
  }, [organizationId]);

  const show = shouldShowInviteSpotlight({
    authStatus: state.status,
    dismissal,
    guidedOnboardingOpen,
    organizationId,
    record,
    recordResolved: isResolved,
  });

  const value = useMemo<InviteSpotlightState>(
    () => ({
      anchor: show ? visibleAnchor(isMobile, sidebarState) : null,
      open: show,
      onOpenChange: (next: boolean) => {
        if (!next) {
          answer();
        }
      },
      onInvite: () => {
        // Taking the action answers the nudge too — someone who opened the invite
        // dialog from here does not need asking again next launch.
        answer();
        setInviteOpenFor(identityKey);
      },
    }),
    [answer, identityKey, isMobile, show, sidebarState]
  );

  return (
    <InviteSpotlightContext.Provider value={value}>
      {children}
      {/* Owned here rather than reached for inside the sidebar: below 768px that
          item lives in an offcanvas sheet that is UNMOUNTED while closed, so a
          pop-up anchored to the topbar could not open a dialog that only exists
          in the sidebar's subtree. One controlled instance, both breakpoints.

          KEYED by identity so a sign-out discards it outright. The dialog keeps
          entered addresses across a dismissal, and this provider outlives the
          user who typed them. */}
      <InviteTeamDialog
        key={identityKey}
        onOpenChange={(next) => setInviteOpenFor(next ? identityKey : null)}
        open={inviteOpenFor === identityKey}
      />
    </InviteSpotlightContext.Provider>
  );
}

export function useInviteSpotlight(): InviteSpotlightState {
  return useContext(InviteSpotlightContext);
}

/**
 * The ring for whichever control the pop-up is pointing at. `undefined` for
 * every other control and every render where nothing is pointing.
 */
export function useInviteSpotlightHighlight(
  anchor: InviteSpotlightAnchor
): string | undefined {
  const spotlight = useInviteSpotlight();
  return spotlight.anchor === anchor && spotlight.open
    ? INVITE_SPOTLIGHT_RING_CLASS
    : undefined;
}

/**
 * Wrap the control this pop-up should hang off. Renders `children` untouched
 * unless the spotlight is currently anchored HERE, so both hosts can wrap
 * unconditionally and neither pays for a Popover it is not using.
 */
export function InviteSpotlightPopover({
  anchor,
  children,
  keepAnchorMounted = false,
}: {
  anchor: InviteSpotlightAnchor;
  children: ReactNode;
  /**
   * Keep the anchor wrapper mounted even while the nudge is not pointing here
   * (ISS-10362).
   *
   * SWITCHING BETWEEN THE TWO BRANCHES REMOUNTS `children`. React reconciles by
   * position, so returning `children` bare and returning them nested under
   * `Popover > PopoverAnchor` are different positions: every hook state inside
   * is destroyed on the change. That is invisible for a control whose state
   * lives ABOVE this wrapper, and fatal for one that owns its own — and the
   * change lands on the very interaction that answers the nudge, because
   * clicking the control this pop-up points at IS an outside-click that
   * dismisses it. The workspace-menu trigger is exactly that: `spotlight.open`
   * goes false in the same tick its dropdown opens, the subtree remounts, and
   * the menu closes again before it is ever on screen.
   *
   * Opt-in rather than the default so the two hosts whose children hold no
   * state of their own keep their resting DOM byte-identical.
   */
  keepAnchorMounted?: boolean;
}) {
  const spotlight = useInviteSpotlight();
  const pointingHere = spotlight.anchor === anchor;
  if (!(pointingHere || keepAnchorMounted)) {
    return children;
  }
  return (
    <Popover
      onOpenChange={spotlight.onOpenChange}
      open={pointingHere && spotlight.open}
    >
      {/* Anchored to a wrapper rather than `asChild` on the control: the sidebar
          host hands us a `InviteTeamDialog`, and the topbar's control is itself
          wrapped, so neither is guaranteed to be a single ref-forwarding DOM
          element. Without `keepAnchorMounted` the wrapper renders only while the
          pop-up is up, so those two hosts' resting DOM is unchanged; with it the
          wrapper is permanent, which is the point — see the prop. */}
      <PopoverAnchor>{children}</PopoverAnchor>
      {pointingHere ? (
        <PopoverContent
          align="end"
          aria-label={INVITE_SPOTLIGHT_TITLE}
          className="w-80"
          side={anchor === InviteSpotlightAnchor.Sidebar ? "right" : "bottom"}
          sideOffset={8}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="font-medium text-sm">{INVITE_SPOTLIGHT_TITLE}</p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {INVITE_SPOTLIGHT_BODY}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => spotlight.onOpenChange(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {INVITE_SPOTLIGHT_DISMISS_LABEL}
              </Button>
              <Button onClick={spotlight.onInvite} size="sm" type="button">
                {INVITE_SPOTLIGHT_INVITE_LABEL}
              </Button>
            </div>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/**
 * Which of the two hosts is actually REACHABLE right now.
 *
 * Two ways the sidebar's invite item is not: below 768px it lives in an
 * offcanvas sheet that is unmounted while closed, and at desktop width a
 * `collapsible="offcanvas"` sidebar that the user collapsed is still MOUNTED but
 * translated to negative x (`group-data-[collapsible=offcanvas]:left-[calc(...*-1)]`).
 * The second is the nastier one precisely because the element still exists and
 * still measures: a pop-up anchored to it renders off screen, with the ring
 * highlighting a control nobody can see. That state also persists across
 * launches, so it is not a transient the next run clears.
 *
 * Both collapse to one question — "is the invite item on screen?" — and the
 * topbar toggle is the answer to both, being the control that reveals it.
 */
type SidebarState = ReturnType<typeof useSidebar>["state"];

/** `useSidebar().state`'s collapsed literal; the design system exports the type, not a value. */
const SIDEBAR_COLLAPSED: SidebarState = "collapsed";

function visibleAnchor(
  isMobile: boolean,
  sidebarState: SidebarState
): InviteSpotlightAnchor {
  return isMobile || sidebarState === SIDEBAR_COLLAPSED
    ? InviteSpotlightAnchor.Topbar
    : InviteSpotlightAnchor.Sidebar;
}
