import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  InviteSpotlightAnchor,
  InviteSpotlightPopover,
  useInviteSpotlightHighlight,
} from "../onboarding/invite-spotlight";
import { useDesktopWorkspaceMenuHoldsInvite } from "./desktop-invite-entry-placement";
import { WorkspaceHeader } from "./workspace-header";

/**
 * The workspace menu's trigger as both sidebar arms mount it, and — while that
 * menu is holding the invite entry — what the arrival nudge points at
 * (ISS-10362).
 *
 * The menu is CLOSED at rest, so the invite row inside it is not on screen to be
 * anchored to. Same problem the `Topbar` anchor was created for, same answer:
 * point at the control that reveals it.
 *
 * ONE component for both arms, like the footer run above: the legacy tree owns
 * its `SidebarMenuItem` and `ShellSidebar` owns its own, so a per-arm copy is
 * how the two drift. The anchor sits INSIDE whichever item wraps this —
 * `PopoverAnchor` renders a `Primitive.div`, and wrapping the item instead would
 * commit `ul > div > li` and break the list semantics screen readers rely on.
 *
 * It is anchored with `keepAnchorMounted`, which is load-bearing rather than a
 * tidiness preference: this is the one spotlight host whose child owns state.
 */
export function DesktopWorkspaceHeaderSlot() {
  // ISS-11247: the same question the footer asks, not the key alone. The footer
  // keeps its own invite row — and its own anchor on this same
  // `InviteSpotlightAnchor.Sidebar` — whenever the menu is not holding the
  // entry, so deciding this on the key would put TWO hosts on one anchor, which
  // `invite-spotlight.tsx` states as an invariant and enforces with nothing.
  const menuHoldsInvite = useDesktopWorkspaceMenuHoldsInvite();
  const spotlightHighlight = useInviteSpotlightHighlight(
    InviteSpotlightAnchor.Sidebar
  );

  if (!menuHoldsInvite) {
    return <WorkspaceHeader />;
  }
  return (
    <InviteSpotlightPopover
      anchor={InviteSpotlightAnchor.Sidebar}
      // The menu keeps its own `open` state, and clicking this trigger is the
      // outside-click that ANSWERS the nudge. Letting the anchor unmount on that
      // answer remounts the menu and closes it in the same tick it opened, so
      // the first click after an arrival nudge did nothing at all.
      keepAnchorMounted
    >
      {/* `rounded-lg` matches `WorkspaceMenuTrigger`'s own radius, so the ring
          follows the shape it is pointing at instead of boxing a rounded control
          in square corners. It rides this wrapper rather than the trigger
          because that button owns its own className. */}
      <div className={cn("rounded-lg", spotlightHighlight)}>
        <WorkspaceHeader />
      </div>
    </InviteSpotlightPopover>
  );
}
