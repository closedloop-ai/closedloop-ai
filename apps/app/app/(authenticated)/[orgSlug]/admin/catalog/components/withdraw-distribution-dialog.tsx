"use client";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import type { PackDistributionWithdrawal } from "@repo/app/packs/hooks/use-pack-distribution-withdrawal";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";

type WithdrawDistributionDialogProps = {
  /** The withdraw flow this dialog confirms. */
  readonly withdrawal: PackDistributionWithdrawal;
  /** The pack being withdrawn; named in the blast-radius sentence. */
  readonly pack: CatalogItemDto | null;
};

/**
 * Confirmation for withdrawing a pack from org distribution (ISS-5123).
 *
 * The description is the substance of this component, not decoration. Three
 * short sentences, one idea each: what stops, what does not, and that it is
 * reversible.
 *
 * The middle one is load-bearing. "Stop distributing" reads to most people as a
 * remote uninstall, and an admin who assumes that will either wait for a cleanup
 * that never comes or avoid the control entirely for fear of breaking everyone's
 * machines. Saying plainly that installed copies stay put is what makes the
 * action safe to take.
 *
 * The pack name is quoted because it opens the sentence and pack names are
 * commonly lowercase ("code"), which reads as a typo unquoted. Matches how the
 * custom-fields delete confirmation names its subject.
 */
export function WithdrawDistributionDialog({
  withdrawal,
  pack,
}: WithdrawDistributionDialogProps) {
  // Falls back to a generic subject rather than an empty string or a fabricated
  // name if the selection is cleared while the dialog is open.
  const subject = pack?.name ?? "This pack";

  return (
    <ConfirmationDialog
      confirmLabel="Stop distributing"
      description={`"${subject}" will no longer be offered to anyone in your organization. Copies already installed stay put and keep working. You can distribute it again later.`}
      isPending={withdrawal.isPending}
      onConfirm={withdrawal.confirmWithdraw}
      onOpenChange={withdrawal.setConfirmOpen}
      open={withdrawal.pendingDistributionIds !== null}
      title="Stop distributing this pack"
      variant="destructive"
    />
  );
}
