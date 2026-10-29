"use client";

import type { FileAttachment } from "@repo/api/src/types/attachment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";

type ReferencedAttachmentDeleteDialogProps = {
  /** The attachment awaiting confirmation, or `null` when the dialog is closed. */
  target: FileAttachment | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Confirm step for deleting an attachment the latest content still references.
 *
 * Shared rather than copied because both surfaces need it for the first time:
 * until ISS-8036 the issue rail listed `context` rows only, so it could not
 * reach a rendered inline image, and it deleted without asking. Now that it
 * lists `inline` rows, one wording has to cover both.
 */
export function ReferencedAttachmentDeleteDialog({
  target,
  onCancel,
  onConfirm,
}: Readonly<ReferencedAttachmentDeleteDialogProps>) {
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open={!!target}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete referenced attachment?</AlertDialogTitle>
          <AlertDialogDescription>
            This attachment is referenced by the latest document content.
            Deleting it can leave a broken inline image.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Delete attachment
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
