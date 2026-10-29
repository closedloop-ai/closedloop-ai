"use client";

import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { type CountNoun, pluralize } from "@repo/design-system/lib/count-noun";
import { type ReactNode, useCallback, useId, useState } from "react";
import type { ArtifactBulkActionPartition, ArtifactBulkRow } from "./registry";

/** The action and selection snapshot held until a partial action is confirmed. */
export type MixedBulkActionRequest = ArtifactBulkActionPartition & {
  actionLabel: string;
  execute: () => Promise<boolean>;
};

/** Approved confirmation words with an optional surface-specific Cancel override. */
export type MixedBulkActionCopy = {
  title: string;
  body: string;
  formatInapplicableRow: (row: ArtifactBulkRow) => string;
  proceedLabel: string;
  cancelLabel?: string;
};

export type MixedBulkActionCopyProvider = (
  request: MixedBulkActionRequest
) => MixedBulkActionCopy;

/** Hold a partial action for the shared confirmation dialog. */
export function useMixedBulkActionConfirmation(
  copyProvider: MixedBulkActionCopyProvider = approvedMixedBulkActionCopy
): {
  requestConfirmation: (request: MixedBulkActionRequest) => boolean;
  confirmationDialog: ReactNode;
} {
  const titleId = useId();
  const [pending, setPending] = useState<{
    request: MixedBulkActionRequest;
    copy: MixedBulkActionCopy;
  } | null>(null);
  const [isPending, setIsPending] = useState(false);
  const requestConfirmation = useCallback(
    (request: MixedBulkActionRequest) => {
      if (request.inapplicableRows.length === 0) {
        return false;
      }
      setPending({ request, copy: copyProvider(request) });
      return true;
    },
    [copyProvider]
  );
  const confirmationDialog = pending ? (
    <ConfirmationDialog
      cancelLabel={pending.copy.cancelLabel}
      confirmDisabled={pending.request.applicableRows.length === 0}
      confirmLabel={pending.copy.proceedLabel}
      description={pending.copy.body}
      details={
        <ul
          aria-labelledby={titleId}
          className="list-disc space-y-1 pl-5 text-muted-foreground text-sm"
        >
          {pending.request.inapplicableRows.map((row) => (
            <li key={row.id}>{pending.copy.formatInapplicableRow(row)}</li>
          ))}
        </ul>
      }
      isPending={isPending}
      onConfirm={async () => {
        setIsPending(true);
        try {
          await pending.request.execute();
        } finally {
          setIsPending(false);
        }
      }}
      onOpenChange={(open) => {
        if (!open) {
          setPending(null);
        }
      }}
      open={true}
      title={pending.copy.title}
      titleId={titleId}
    />
  ) : null;
  return { requestConfirmation, confirmationDialog };
}

const ARTIFACT_COUNT_NOUN: CountNoun = {
  one: "artifact",
  other: "artifacts",
};

/** R-12916-MIXED v2 copy approved under Daveth's 2026-10-22 delegation. */
export const approvedMixedBulkActionCopy: MixedBulkActionCopyProvider = (
  request
) => {
  const selectedCount = request.selectedRows.length;
  const inapplicableCount = request.inapplicableRows.length;
  const applicableCount = request.applicableRows.length;
  return {
    title: `${request.actionLabel} isn't available for ${inapplicableCount} of ${selectedCount} selected ${pluralize(ARTIFACT_COUNT_NOUN, selectedCount)}`,
    body: `Continue with the other ${applicableCount}?`,
    formatInapplicableRow: (row) => `${row.label || row.id} (${row.kind})`,
    proceedLabel: `${request.actionLabel} for ${applicableCount}`,
  };
};
