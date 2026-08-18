"use client";

/**
 * ISS-5508: the stated cause on an artifact-detail run action that is
 * unavailable because a run is already in flight.
 *
 * ISS-5474 removed every user-facing run-state treatment from artifact rows and
 * detail surfaces and deliberately declined to invent a replacement, leaving a
 * control that greys out and will not say why. This is the narrowest thing that
 * closes that gap without reviving what was removed: it explains ONE control's
 * unavailability at that control, and reports nothing about the run itself — no
 * identity, no status, no outcome, no link, and no Loop noun.
 *
 * The accessibility shape is the load-bearing part. A native `disabled` element
 * is removed from the tab order and skipped by screen readers, so a description
 * hung off it reaches sighted mouse users only; a `title` attribute on one is
 * worse still. The gated control therefore carries `aria-disabled` instead,
 * stays focusable, refuses activation explicitly, and points at a real visible
 * description with `aria-describedby`.
 */

import {
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

/**
 * Why the control is unavailable, in the product's current vocabulary.
 *
 * Scoped to the CONTROL, not the artifact. The gate is per command, so on a plan
 * header four of the five items stay live while this is on screen; a sentence
 * claiming a run "on this artifact" would over-claim against its own menu, and
 * `aria-describedby` already binds it to the one control it describes.
 *
 * States the CAUSE and stops, rather than naming a way out. Promising
 * availability when the run ends reads better but is not true at every site: on
 * the Build section a SUCCESSFUL execute run produces a branch, and the empty
 * state that owns "Start Building" is replaced by branch rows instead of the
 * control coming back. A sentence that is true only on the failure path is the
 * same class of defect this ticket exists to fix.
 *
 * States that the run EXISTS, not that it is running, and that is the whole
 * point of the wording (PR #4714 review, wongk). The gate is
 * `isActiveGenerationStatus`, whose active set is `PENDING | QUEUED | RUNNING`,
 * and `PENDING` is not one Loop state but two: `mapLoopStatus` in
 * `apps/api/lib/loops/loop-status-utils.ts` folds BOTH `LoopStatus.Pending` and
 * `LoopStatus.Blocked` onto it, deliberately, so a blocker-deferred dispatch
 * stays visible instead of vanishing. A deferred run has never been claimed —
 * `startedAt` is null and no work has begun — so "a run is in progress" would
 * assert execution the system cannot back, on exactly the state a user is most
 * likely to sit in (a plan queued behind an unapproved dependency). Saying it
 * ALREADY EXISTS is true of all three active states and still explains the
 * gate, which refuses a second dispatch whether the first one started or not.
 *
 * "run" is the noun PR #4605 settled on for this concept in the activity feed
 * ("started an agent run on this artifact") after ISS-4477 retired Loops as a
 * user-facing concept. No period and no em dash, per the house copy rules.
 */
export const RUN_IN_FLIGHT_REASON = "A run for this action already exists";

type RunInFlightReasonProps = {
  className?: string;
  /** Referenced by the unavailable control's `aria-describedby`. */
  id: string;
  /**
   * Also announce the line when it APPEARS, not only when the control is
   * focused.
   *
   * The guaranteed mechanism is `aria-describedby` on a focusable control; this
   * is an addition for the case where focus is ALREADY on the control when the
   * poll flips (the user pressed it a moment ago), because adding a description
   * to an already-focused element is not re-announced. It is best-effort: a
   * region inserted already-populated is skipped by some screen readers, and a
   * reader who merely opened the page hears it unprompted. Both are acceptable
   * for a polite region carrying one short sentence; neither is acceptable as
   * the only route to the explanation, which is why it is not.
   *
   * Leave it off inside a menu, which is opened after the fact, or it fires on
   * every open.
   */
  live?: boolean;
};

/**
 * The visible explanation an unavailable run action points at, as ordinary
 * accompanying text beneath the control.
 *
 * Not a banner (precisely what ISS-5474 removed) and not a `title` tooltip,
 * which is reachable by neither keyboard nor screen reader.
 */
export function RunInFlightReason({
  className,
  id,
  live = false,
}: Readonly<RunInFlightReasonProps>) {
  return (
    <p
      className={cn("text-muted-foreground text-xs", className)}
      id={id}
      role={live ? "status" : undefined}
    >
      {RUN_IN_FLIGHT_REASON}
    </p>
  );
}

/**
 * The same explanation as the footer of an Actions menu.
 *
 * A `DropdownMenuLabel` rather than a bare node so the menu's own inset and
 * padding carry it; re-typing `px-2 py-1.5` at each call site would re-declare
 * tokens the component already ships.
 */
export function RunInFlightMenuNote({ id }: Readonly<{ id: string }>) {
  return (
    <DropdownMenuLabel
      className="font-normal text-muted-foreground text-xs"
      id={id}
    >
      {RUN_IN_FLIGHT_REASON}
    </DropdownMenuLabel>
  );
}

type RunActionMenuItemProps = {
  children: ReactNode;
  /**
   * Unavailable for a reason this component does NOT explain (not ready, no
   * plan, a pending local mutation, a still-loading status fetch). Rendered as a
   * native `disabled` item, exactly as it shipped before this change.
   */
  disabled?: boolean;
  onActivate: () => void;
  /** Id of the {@link RunInFlightReason} rendered in the same menu. */
  reasonId: string;
  /**
   * A run of this item's command is in flight AND that run is the only thing
   * standing in the way.
   *
   * Callers must exclude any blocker the run's completion will NOT clear (an
   * unapproved plan, a missing plan, an issue that is not ready, a pending local
   * mutation). Otherwise the item promises it becomes available when the run
   * finishes, stays greyed when it does, and reads as the fix not working —
   * which is the same lie as the still-loading case, from the other side.
   */
  runInFlight: boolean;
};

/**
 * A run action in an artifact header's Actions menu.
 *
 * When `runInFlight` is false this is the plain `DropdownMenuItem` these menus
 * have always rendered. When it is true the item swaps native `disabled` for
 * `aria-disabled` so it keeps its place in the menu's roving focus order, blocks
 * its own activation, and describes itself with the shared reason.
 */
export function RunActionMenuItem({
  children,
  disabled = false,
  onActivate,
  reasonId,
  runInFlight,
}: Readonly<RunActionMenuItemProps>) {
  if (runInFlight) {
    return (
      <DropdownMenuItem
        aria-describedby={reasonId}
        aria-disabled
        className="cursor-not-allowed opacity-50"
        onSelect={preventActivation}
      >
        {children}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem disabled={disabled} onSelect={() => onActivate()}>
      {children}
    </DropdownMenuItem>
  );
}

/**
 * Refuses the select outright — `aria-disabled` is advisory, so pointer and
 * keyboard activation have to be blocked here, and preventing the default also
 * keeps the menu open so the explanation stays on screen.
 */
function preventActivation(event: Event) {
  event.preventDefault();
}
