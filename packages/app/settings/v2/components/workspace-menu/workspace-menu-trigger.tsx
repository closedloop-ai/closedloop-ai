"use client";

import {
  WORKSPACE_MENU_TRIGGER_LABEL,
  type WorkspaceMenuProjection,
  WorkspaceMenuProjectionStatus,
} from "@repo/api/src/types/workspace-menu";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  SidebarMenuButton,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { ChevronDownIcon } from "lucide-react";
import { type ComponentProps, useId } from "react";

/**
 * The menu's trigger row.
 *
 * ONE PRESENTATION ON BOTH HOSTS, per the 2026-09-03 operator ruling: same
 * position, same visual treatment, same accessible name. What differs between
 * hosts is the ITEM SET behind it, never this.
 *
 * The accessible name is "Open account menu", not "Open organization switcher".
 * The ruling is explicit that the desktop control is not an organization
 * switcher, and naming it one would promise switching to a screen-reader user on
 * a host that has no such path.
 *
 * THE STATE IS A DESCRIPTION, NOT PART OF THE NAME (ISS-11400 AC4). `aria-label`
 * replaces this button's entire subtree in the accessible NAME computation, so
 * the visible word — "Account unavailable", "Loading", "Guest", or the workspace
 * name — never reached the accessibility tree on its own, and `disabled` was the
 * only thing telling a screen-reader user that an Error trigger was not a normal
 * account menu. Removing `disabled` therefore had to put that distinction back,
 * and `aria-describedby` pointed at the word span is where it goes: the name
 * stays the one constant string every host announces, and the state rides
 * beside it as the description. Folding the word INTO `aria-label` would have
 * made the name change under the user, which is the half of the invariant that
 * rule protects.
 */

const TRIGGER_CLASSNAME =
  "h-10 rounded-lg px-2 data-[state=open]:bg-sidebar-accent";

/**
 * The word each non-Ready status shows, exhaustive by type so a new
 * {@link WorkspaceMenuProjectionStatus} fails `tsc` here until someone decides
 * what it SAYS — rather than falling through to "Account unavailable" and
 * quietly mislabelling itself.
 *
 * A `Record` rather than a `switch` with `assertNever`: this renders the TRIGGER,
 * outside any error boundary, so a throw on an unknown status would blank the
 * whole menu — the same reason the Settings panel-status map avoids `assertNever`.
 */
const NON_READY_TRIGGER_WORD: Record<
  Exclude<
    WorkspaceMenuProjectionStatus,
    typeof WorkspaceMenuProjectionStatus.Ready
  >,
  string
> = {
  // The literal word, because "Account" would claim a thing a guest does not
  // have (ISS-5112).
  [WorkspaceMenuProjectionStatus.Guest]: "Guest",
  [WorkspaceMenuProjectionStatus.Pending]: "Loading",
  [WorkspaceMenuProjectionStatus.Error]: "Account unavailable",
};

function triggerWord(projection: WorkspaceMenuProjection): string {
  if (projection.status === WorkspaceMenuProjectionStatus.Ready) {
    return projection.activeWorkspace.name;
  }
  return NON_READY_TRIGGER_WORD[projection.status];
}

/**
 * Spreads `...triggerProps` onto the button on purpose. Radix's `asChild` clones
 * this element and injects the props that MAKE it a trigger — `onPointerDown`,
 * `aria-expanded`, `aria-haspopup`, `ref`. A component that accepts only its own
 * props swallows all of them, and the menu then never opens: the button renders,
 * looks right, and does nothing.
 */
export function WorkspaceMenuTrigger({
  projection,
  ...triggerProps
}: ComponentProps<typeof SidebarMenuButton> & {
  projection: WorkspaceMenuProjection;
}) {
  const { open: sidebarOpen } = useSidebar();
  const word = triggerWord(projection);
  const wordId = useId();
  const imageUrl =
    projection.status === WorkspaceMenuProjectionStatus.Ready
      ? projection.activeWorkspace.imageUrl
      : null;

  return (
    <SidebarMenuButton
      {...triggerProps}
      // Merged rather than assigned: `asChild` clones this element, and a
      // wrapper that describes the trigger itself — the collapsed-sidebar
      // Tooltip below — must not lose its own id to this one.
      aria-describedby={[triggerProps["aria-describedby"], wordId]
        .filter(Boolean)
        .join(" ")}
      aria-label={WORKSPACE_MENU_TRIGGER_LABEL}
      className={TRIGGER_CLASSNAME}
      // Only when collapsed, matching the production account menu. A tooltip
      // repeating a label that is already visible is noise — and passing one
      // unconditionally wraps this button in a Tooltip that swallows the
      // dropdown trigger's props, so the menu never opens.
      tooltip={sidebarOpen ? undefined : word}
    >
      {/* Not a `PersonAvatar` (ISS-12343): the subject is the active
          WORKSPACE, and on a non-Ready status it is a state word rather than
          anyone at all. */}
      <Avatar className="size-7 shrink-0 rounded-md">
        {/* ISS-8972: always mounted, `src` possibly undefined — see
         * table-cell-list-primitives.tsx's ReferenceChip for why. */}
        <AvatarImage alt="" src={imageUrl ?? undefined} />
        <AvatarFallback className="rounded-md text-xs">
          {word.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        {/* The state word is visible TEXT, never a colour or opacity change
            alone (WCAG 1.4.1) — a loading trigger and a failed one must not be
            distinguishable only by shade. It is ALSO the button's
            `aria-describedby` target, which is what carries that same
            distinction into the accessibility tree past the `aria-label` above;
            the two statements are one element, so neither can be dropped
            without the other going with it. */}
        <span className="truncate font-medium" id={wordId}>
          {word}
        </span>
      </div>
      <ChevronDownIcon
        aria-hidden="true"
        className="ml-auto size-4 opacity-60"
      />
    </SidebarMenuButton>
  );
}
