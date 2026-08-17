import { InviteTeamDialog } from "@repo/app/organizations/components/invite-team-dialog";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@closedloop-ai/design-system/components/ui/popover";
import { useSidebar } from "@closedloop-ai/design-system/components/ui/sidebar";
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
import { DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import {
  hasRecordedSyncConsent,
  type SyncConsentRecord,
} from "../../../shared/sync-consent";
import { useDesktopFeatureFlagsResolved } from "../../feature-flags/desktop-feature-flag-provider";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import {
  inviteSpotlightDismissedStorageKey,
  readFlag,
  writeFlag,
} from "../dashboard/dashboard-storage-keys";
import {
  isArrivalForIdentity,
  useSyncConsentArrival,
} from "./sync-consent-arrival";
import { useSyncConsentRecord } from "./use-sync-consent-record";

/** Which host element the pop-up hangs off. Exactly one is on screen at a time. */
export const InviteSpotlightAnchor = {
  /** The sidebar footer's "Invite your team" item — where invite actually lives. */
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
  flagEnabled,
  flagsResolved,
  authStatus,
  organizationId,
  record,
  recordResolved,
  dismissal,
  answeredThisRun,
}: {
  flagEnabled: boolean;
  /** ISS-5037: an unresolved snapshot reads every flag as its default, so it counts as off. */
  flagsResolved: boolean;
  authStatus: DesktopAuthStatus;
  organizationId: string | null;
  /** null = unreadable (no bridge / failed read), which withholds. */
  record: SyncConsentRecord | null;
  recordResolved: boolean;
  dismissal: InviteSpotlightDismissal;
  /**
   * The takeover committed an answer for THIS identity during this run.
   *
   * Load-bearing, not a shortcut. `useSyncConsentRecord` holds per-call-site
   * state and re-reads only when the user id changes, so the takeover's
   * post-save `refresh()` reaches its own instance and nothing else. Reading
   * `record` alone therefore left this nudge suppressed for the whole run in
   * which the user actually answered — the arrival run it is named after — and
   * it surfaced only on some later launch.
   */
  answeredThisRun: boolean;
}): boolean {
  if (!(flagsResolved && flagEnabled)) {
    return false;
  }
  if (authStatus !== DesktopAuthStatus.Authenticated) {
    return false;
  }
  // The dialog this nudge points at mints real Clerk invitations against an org
  // id. With no org there is nothing to invite anyone into, so there is nothing
  // to nudge about.
  if (organizationId === null) {
    return false;
  }
  // The consent takeover is a hard block that makes everything behind it inert.
  // Firing this while it is up would put a pop-up with two buttons behind a
  // modal that swallows every click — the same defect ISS-5489 shipped a fix for.
  //
  // TWO signals, because one is not enough to answer "is the takeover shut".
  // `record` is this component's own snapshot, and it is stale for the rest of
  // the run once the takeover writes (see `answeredThisRun`); the arrival is the
  // takeover publishing what it just committed. Either one settles it, and the
  // takeover's own closing condition is the union of the same two.
  //
  // The arrival short-circuits the record entirely rather than being read
  // alongside it. Gating on the record first put this fix behind the very read
  // it exists to bypass: a rejected or never-settling IPC call withheld the
  // nudge from a user who had just completed the consent flow, on the run it is
  // named after.
  if (!answeredThisRun) {
    if (!(recordResolved && record)) {
      return false;
    }
    if (!hasRecordedSyncConsent(record, organizationId)) {
      return false;
    }
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
 *
 * Split from the armed half for the STRUCTURAL reason `SyncConsentTakeoverGate`
 * and `GuestLandingGate` split theirs: the armed half reads auth, which throws
 * without a `DesktopAuthProvider`, and the app-shell suites deliberately mount
 * none. Answering "is this launch even a candidate" first lets the flag-off
 * default — every existing user, and every one of those tests — render the shell
 * without ever mounting the hook that would throw.
 */
export function InviteSpotlightProvider({ children }: { children: ReactNode }) {
  const flagEnabled = useFeatureFlagEnabled(
    DESKTOP_GUEST_ONBOARDING_FEATURE_FLAG_KEY
  );
  const flagsResolved = useDesktopFeatureFlagsResolved();
  if (!(flagsResolved && flagEnabled)) {
    return children;
  }
  return (
    <ArmedInviteSpotlightProvider
      flagEnabled={flagEnabled}
      flagsResolved={flagsResolved}
    >
      {children}
    </ArmedInviteSpotlightProvider>
  );
}

function ArmedInviteSpotlightProvider({
  children,
  flagEnabled,
  flagsResolved,
}: {
  children: ReactNode;
  flagEnabled: boolean;
  flagsResolved: boolean;
}) {
  const { state } = useDesktopAuth();
  const { record, isResolved } = useSyncConsentRecord(state.userId);
  const arrival = useSyncConsentArrival();
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
    setDismissal({
      organizationId,
      dismissed:
        organizationId === null
          ? false
          : readFlag(inviteSpotlightDismissedStorageKey(organizationId)),
    });
  }, [organizationId]);

  const answer = useCallback(() => {
    if (organizationId === null) {
      return;
    }
    writeFlag(inviteSpotlightDismissedStorageKey(organizationId));
    setDismissal({ organizationId, dismissed: true });
  }, [organizationId]);

  const show = shouldShowInviteSpotlight({
    answeredThisRun: isArrivalForIdentity(arrival, {
      organizationId,
      userId: state.userId,
    }),
    authStatus: state.status,
    dismissal,
    flagEnabled,
    flagsResolved,
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
}: {
  anchor: InviteSpotlightAnchor;
  children: ReactNode;
}) {
  const spotlight = useInviteSpotlight();
  if (spotlight.anchor !== anchor) {
    return children;
  }
  return (
    <Popover onOpenChange={spotlight.onOpenChange} open={spotlight.open}>
      {/* Anchored to a wrapper rather than `asChild` on the control: the sidebar
          host hands us a `InviteTeamDialog`, and the topbar's control is itself
          wrapped, so neither is guaranteed to be a single ref-forwarding DOM
          element. The wrapper renders only while the pop-up is up, so the
          resting DOM of both hosts is unchanged. */}
      <PopoverAnchor>{children}</PopoverAnchor>
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
