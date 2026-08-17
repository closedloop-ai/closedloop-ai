"use client";

import type { PackInstallState } from "@repo/app/packs/lib/install-state";
import {
  MEMBER_INSTALL_ACTION_LABEL,
  type MemberInstallAction,
  memberInstallActionAriaLabel,
  memberInstallActionFor,
  memberInstallBlockedReason,
} from "@repo/app/packs/lib/member-install-action";
import {
  type MemberInstallDispatchCopy,
  MemberInstallDispatchTone,
} from "@repo/app/packs/lib/member-install-dispatch-copy";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { DownloadIcon, Loader2Icon } from "lucide-react";

/**
 * The member's ACT affordance for one (machine x harness) cell (ISS-5125).
 *
 * The per-machine block was a read-only status list; this is the one control
 * that lets a member do something about a row. It renders exactly ONE of three
 * things, never two:
 *
 *  1. an action button, when {@link memberInstallActionFor} says the cell
 *     affords one (Not installed -> Install, Install failed -> Retry);
 *  2. a short reason, when the cell is blocked in a way the member would
 *     otherwise read as a missing button (offline / unsupported / already
 *     running) — silence there looks like a bug, not a rule;
 *  3. nothing, for the settled states (installed, update available) whose
 *     status line already says everything true about them.
 *
 * Beneath whichever of those renders, the LAST dispatch outcome for this cell
 * shows as its own line when there is one. It is deliberately separate from the
 * cell's `PackInstallState`: the status says where the pack STANDS (last known
 * on-device truth), the outcome says what the last CLICK proved. Collapsing them
 * would force the UI to either claim an install the node never confirmed, or
 * discard the only feedback the member gets between clicking and the node
 * reporting back.
 */

type MemberInstallControlProps = {
  readonly state: PackInstallState;
  /** Pack name, used only to build the control's full accessible name. */
  readonly packName: string;
  readonly computeTargetName: string;
  /** Resolved harness display label, for the accessible name. */
  readonly harnessLabel: string;
  /** A dispatch for THIS cell is in flight. */
  readonly isPending?: boolean;
  /** The last dispatch outcome for THIS cell, if the member has clicked. */
  readonly dispatch?: MemberInstallDispatchCopy | null;
  readonly onAction: (action: MemberInstallAction) => void;
};

const TONE_CLASS: Record<MemberInstallDispatchTone, string> = {
  [MemberInstallDispatchTone.Success]: "text-muted-foreground",
  [MemberInstallDispatchTone.Pending]: "text-muted-foreground",
  [MemberInstallDispatchTone.Danger]: "text-destructive",
};

/**
 * The last dispatch outcome, as a live region so a member using a screen reader
 * hears the result of their own click without moving focus. `polite` because the
 * outcome is informational — it never steals focus mid-task.
 */
const DispatchOutcome = ({
  dispatch,
}: {
  dispatch: MemberInstallDispatchCopy;
}) => (
  <p
    aria-live="polite"
    className={cn("max-w-64 text-right text-xs", TONE_CLASS[dispatch.tone])}
    data-testid="member-install-dispatch"
  >
    {dispatch.message}
  </p>
);

/**
 * Decide what the control offers, accounting for a dispatch the member has
 * already made. An ambiguous `Pending` outcome SUPPRESSES the action even though
 * the underlying cell state still reads `NotInstalled` — the node may already be
 * installing, and re-offering the button there is how a member is invited to run
 * the same install twice. That is the one case where the last click, not the
 * cell state, decides the affordance.
 */
function resolveOfferedAction(
  state: PackInstallState,
  dispatch: MemberInstallDispatchCopy | null | undefined
): MemberInstallAction | null {
  const action = memberInstallActionFor(state);
  if (!action) {
    return null;
  }
  if (dispatch && !dispatch.retryable) {
    return null;
  }
  return action;
}

export const MemberInstallControl = ({
  state,
  packName,
  computeTargetName,
  harnessLabel,
  isPending = false,
  dispatch = null,
  onAction,
}: MemberInstallControlProps) => {
  const action = resolveOfferedAction(state, dispatch);
  const blockedReason = action
    ? null
    : memberInstallBlockedReason(state, computeTargetName);

  return (
    <span className="flex flex-col items-end gap-1">
      {action ? (
        <Button
          aria-label={memberInstallActionAriaLabel({
            action,
            packName,
            computeTargetName,
            harnessLabel,
          })}
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          disabled={isPending}
          onClick={() => onAction(action)}
          size="sm"
          variant="outline"
        >
          {isPending ? (
            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <DownloadIcon aria-hidden="true" className="size-3.5" />
          )}
          {isPending ? "Sending…" : MEMBER_INSTALL_ACTION_LABEL[action]}
        </Button>
      ) : null}
      {blockedReason ? (
        <span className="max-w-64 text-right text-muted-foreground text-xs">
          {blockedReason}
        </span>
      ) : null}
      {dispatch ? <DispatchOutcome dispatch={dispatch} /> : null}
    </span>
  );
};
