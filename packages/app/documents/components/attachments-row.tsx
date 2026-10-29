"use client";

import type { FileAttachment } from "@repo/api/src/types/attachment";
import { AttachmentList } from "@repo/app/documents/components/attachment-list";
import { ReferencedAttachmentDeleteDialog } from "@repo/app/documents/components/referenced-attachment-delete-dialog";
import {
  useDeleteAttachment,
  useDocumentAttachments,
  useDownloadAttachment,
} from "@repo/app/documents/hooks/use-attachments";
import {
  isAttachmentReferencedByContent,
  selectListedAttachments,
} from "@repo/app/documents/lib/attachment-visibility";
import { useState } from "react";

type AttachmentsRowProps = {
  documentId: string;
  active?: boolean;
  /**
   * Latest document markdown used to warn before deleting attachments that are
   * still referenced by the current saved content. Historical views should pass
   * the saved latest version content, not the historical version body.
   */
  latestContent?: string;
  /**
   * The body the reader is actually looking at, whose rendered inline images are
   * hidden from the list. The selected version when reading history, so a
   * historical view does not hide a file that version never renders. Falls back
   * to `latestContent` when a mount site has no version notion.
   */
  renderedContent?: string;
  className?: string;
};

/**
 * Horizontal wrap-enabled list of attachment chips shown directly below the
 * document's Properties Bar. Hides itself when there are no attachments.
 */
export function AttachmentsRow({
  documentId,
  active = true,
  latestContent,
  renderedContent,
  className,
}: Readonly<AttachmentsRowProps>) {
  const { data: attachments = [] } = useDocumentAttachments(documentId, {
    enabled: active,
  });
  const deleteAttachment = useDeleteAttachment(documentId);
  const downloadAttachment = useDownloadAttachment();
  const [referencedDeleteTarget, setReferencedDeleteTarget] =
    useState<FileAttachment | null>(null);

  const handleDelete = (attachment: FileAttachment) => {
    if (isAttachmentReferencedByContent(latestContent, attachment.id)) {
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

  // Filtered before the emptiness check, so a document whose only attachments
  // are inline images the body already renders collapses to nothing rather than
  // rendering an empty chip row.
  const listedAttachments = selectListedAttachments(
    attachments,
    renderedContent ?? latestContent
  );

  if (listedAttachments.length === 0) {
    return null;
  }

  return (
    <>
      <AttachmentList
        attachments={listedAttachments}
        className={className}
        onDelete={handleDelete}
        onDownload={(attachment) =>
          downloadAttachment.mutate({
            documentId,
            attachmentId: attachment.id,
          })
        }
      />
      <ReferencedAttachmentDeleteDialog
        onCancel={() => setReferencedDeleteTarget(null)}
        onConfirm={handleConfirmReferencedDelete}
        target={referencedDeleteTarget}
      />
    </>
  );
}
