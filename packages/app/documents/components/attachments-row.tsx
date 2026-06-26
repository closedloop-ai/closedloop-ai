"use client";

import type { FileAttachment } from "@repo/api/src/types/attachment";
import { AttachmentList } from "@repo/app/documents/components/attachment-list";
import {
  useAttachments,
  useDeleteAttachment,
  useDownloadAttachment,
} from "@repo/app/documents/hooks/use-attachments";
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
import { useState } from "react";

type AttachmentsRowProps = {
  documentId: string;
  /**
   * Latest document markdown used to warn before deleting attachments that are
   * still referenced by the current saved content. Historical views should pass
   * the saved latest version content, not the historical version body.
   */
  latestContent?: string;
  className?: string;
};

/**
 * Horizontal wrap-enabled list of attachment chips shown directly below the
 * document's Properties Bar. Hides itself when there are no attachments.
 */
export function AttachmentsRow({
  documentId,
  latestContent,
  className,
}: Readonly<AttachmentsRowProps>) {
  const { data: attachments = [] } = useAttachments(documentId);
  const deleteAttachment = useDeleteAttachment(documentId);
  const downloadAttachment = useDownloadAttachment();
  const [referencedDeleteTarget, setReferencedDeleteTarget] =
    useState<FileAttachment | null>(null);

  const handleDelete = (attachment: FileAttachment) => {
    const isReferencedByLatest = latestContent?.includes(
      `attachment://${attachment.id}`
    );
    if (isReferencedByLatest) {
      setReferencedDeleteTarget(attachment);
      return;
    }
    deleteAttachment.mutate(attachment.id);
  };

  const handleConfirmReferencedDelete = () => {
    if (referencedDeleteTarget) {
      deleteAttachment.mutate(referencedDeleteTarget.id);
      setReferencedDeleteTarget(null);
    }
  };

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <AttachmentList
        attachments={attachments}
        className={className}
        onDelete={handleDelete}
        onDownload={(attachment) =>
          downloadAttachment.mutate({
            documentId,
            attachmentId: attachment.id,
          })
        }
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setReferencedDeleteTarget(null);
          }
        }}
        open={!!referencedDeleteTarget}
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
            <AlertDialogAction onClick={handleConfirmReferencedDelete}>
              Delete attachment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
