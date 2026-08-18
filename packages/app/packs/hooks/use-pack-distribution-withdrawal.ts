"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useState } from "react";
import { useWithdrawDistribution } from "../../agents/hooks/use-distributions";

/**
 * The admin "stop distributing" flow for one pack (ISS-5123).
 *
 * Promotion to the organization used to be one-way. This hook owns the whole
 * withdraw interaction — which distribution is pending confirmation, whether the
 * capability is offered at all, and the mutation itself — so the surface that
 * mounts it only has to render a button and a confirmation dialog.
 *
 * Two invariants live here rather than at the call site, because they are what
 * makes a destructive, org-wide action safe to expose:
 *
 * 1. **A click never withdraws.** `requestWithdraw` only records the targets; the
 *    request is issued by `confirmWithdraw`, which the surface wires to an
 *    explicit confirmation naming the blast radius.
 * 2. **The confirmation is bound to specific distribution ids**, not to "the
 *    selected pack". A pack can carry several distributions at once, and the
 *    selection can change under an open dialog; keying on the ids means the
 *    withdrawal can only ever hit the distributions whose button was pressed.
 *    ISS-5123 takes the whole live set rather than one: the confirmation promises
 *    the pack will no longer be offered to anyone, and leaving a sibling
 *    distribution live would make that sentence false.
 *
 * The affordance is offered only when the surface holds the admin capability
 * AND the closed-by-default `pack-undistribute` flag is on. Both conditions are
 * combined here rather than at the call site so no surface can accidentally
 * render the control on one of them: fail either and `requestWithdraw` is
 * undefined, leaving the caller with nothing to render.
 */
export type PackDistributionWithdrawal = {
  /**
   * Ask to withdraw a pack's distributions. Undefined when the affordance is not
   * offered, so it drops straight into an optional callback prop and the
   * control is simply not rendered.
   */
  requestWithdraw: ((distributionIds: string[]) => void) | undefined;
  /** The distributions awaiting confirmation, or null when none are. */
  pendingDistributionIds: string[] | null;
  /** Issue the withdrawal. Rejects on failure so the dialog can stay open. */
  confirmWithdraw: () => Promise<void>;
  /**
   * Dialog open-state setter. Only `false` is meaningful — a confirmation is
   * opened by naming a distribution through `requestWithdraw`, never by toggling
   * a boolean, so this can only ever dismiss one.
   */
  setConfirmOpen: (open: boolean) => void;
  /** A withdrawal request is in flight. */
  isPending: boolean;
};

export function usePackDistributionWithdrawal({
  isAdmin,
  flagEnabled,
  packName,
}: {
  /** The surface holds the admin `Distribute` capability. */
  isAdmin: boolean;
  /** The closed-by-default `pack-undistribute` flag resolved on. */
  flagEnabled: boolean;
  /** Pack being withdrawn, named in the success confirmation. */
  packName?: string | null;
}): PackDistributionWithdrawal {
  const enabled = isAdmin && flagEnabled;
  const [pendingDistributionIds, setPendingDistributionIds] = useState<
    string[] | null
  >(null);
  const withdrawDistribution = useWithdrawDistribution();

  const requestWithdraw = useCallback((distributionIds: string[]) => {
    if (distributionIds.length === 0) {
      return;
    }
    setPendingDistributionIds(distributionIds);
  }, []);

  const confirmWithdraw = useCallback(async () => {
    if (!pendingDistributionIds) {
      return;
    }
    // `mutateAsync` so the caller's confirmation dialog genuinely awaits the
    // requests: on failure this rejects, the dialog stays open, and the pending
    // ids are preserved for a retry rather than being cleared as if it had
    // worked. A retry re-issues every id, including any that already landed —
    // safe because withdrawal is an idempotent no-op on an already-withdrawn
    // distribution and never re-stamps who withdrew it or when.
    await Promise.all(
      pendingDistributionIds.map((distributionId) =>
        withdrawDistribution.mutateAsync(distributionId)
      )
    );
    // The surface goes quiet on success — the roll-out block it replaces simply
    // disappears — so without this the admin has no confirmation that an
    // org-wide action they just took actually landed. It doubles as the screen
    // reader announcement, since nothing else changes focus.
    toast.success(
      packName
        ? `Stopped distributing "${packName}"`
        : "Stopped distributing this pack"
    );
    setPendingDistributionIds(null);
  }, [pendingDistributionIds, withdrawDistribution, packName]);

  const setConfirmOpen = useCallback((open: boolean) => {
    if (open) {
      return;
    }
    setPendingDistributionIds(null);
  }, []);

  return {
    requestWithdraw: enabled ? requestWithdraw : undefined,
    pendingDistributionIds: enabled ? pendingDistributionIds : null,
    confirmWithdraw,
    setConfirmOpen,
    isPending: withdrawDistribution.isPending,
  };
}
