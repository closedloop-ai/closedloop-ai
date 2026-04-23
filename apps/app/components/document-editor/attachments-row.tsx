"use client";

import type { FileAttachment } from "@repo/api/src/types/attachment";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { DownloadIcon, FileIcon, Trash2Icon } from "lucide-react";
import {
  useAttachments,
  useDeleteAttachment,
  useDownloadAttachment,
} from "@/hooks/queries/use-attachments";

type AttachmentsRowProps = {
  documentId: string;
  className?: string;
};

/**
 * Horizontal wrap-enabled list of attachment chips shown directly below the
 * document's Properties Bar. Hides itself when there are no attachments.
 */
export function AttachmentsRow({
  documentId,
  className,
}: Readonly<AttachmentsRowProps>) {
  const { data: attachments = [] } = useAttachments(documentId);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {attachments.map((attachment) => (
        <AttachmentChip
          attachment={attachment}
          documentId={documentId}
          key={attachment.id}
        />
      ))}
    </div>
  );
}

type AttachmentChipProps = {
  attachment: FileAttachment;
  documentId: string;
};

function AttachmentChip({
  attachment,
  documentId,
}: Readonly<AttachmentChipProps>) {
  const deleteAttachment = useDeleteAttachment(documentId);
  const downloadAttachment = useDownloadAttachment();

  const sizeLabel =
    attachment.sizeBytes < 1024 * 1024
      ? `${Math.ceil(attachment.sizeBytes / 1024)} KB`
      : `${(attachment.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="group flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm">
      {attachment.previewUrl ? (
        <a
          className="flex shrink-0 hover:opacity-90"
          href={attachment.previewUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {/* biome-ignore lint/performance/noImgElement: S3 presigned URLs are external/dynamic */}
          <img
            alt={attachment.filename}
            className="h-6 w-6 shrink-0 rounded object-cover"
            height={24}
            src={attachment.previewUrl}
            width={24}
          />
        </a>
      ) : (
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="max-w-[180px] truncate font-medium">
        {attachment.filename}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {sizeLabel}
      </span>
      {attachment.previewUrl ? null : (
        <Button
          aria-label={`Download ${attachment.filename}`}
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={() =>
            downloadAttachment.mutate({
              documentId,
              attachmentId: attachment.id,
            })
          }
          size="icon"
          variant="ghost"
        >
          <DownloadIcon className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        aria-label={`Delete ${attachment.filename}`}
        className="h-6 w-6 opacity-0 group-hover:opacity-100"
        onClick={() => deleteAttachment.mutate(attachment.id)}
        size="icon"
        variant="ghost"
      >
        <Trash2Icon className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
