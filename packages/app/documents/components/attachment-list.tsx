"use client";

import type { FileAttachment } from "@repo/api/src/types/attachment";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { DownloadIcon, FileIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";

export type AttachmentListProps = {
  attachments: FileAttachment[];
  className?: string;
  onDownload?: (attachment: FileAttachment) => void;
  onDelete?: (attachment: FileAttachment) => void;
  actionVisibility?: "hover" | "always";
  emptyState?: ReactNode;
};

/**
 * Wrap-enabled list of attachment chips for artifact detail surfaces.
 * Image attachments link to their preview URL; non-image files expose a
 * download action when a handler is provided.
 */
export function AttachmentList({
  attachments,
  className,
  onDownload,
  onDelete,
  actionVisibility = "hover",
  emptyState = null,
}: Readonly<AttachmentListProps>) {
  if (attachments.length === 0) {
    return emptyState;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {attachments.map((attachment) => (
        <AttachmentChip
          actionVisibility={actionVisibility}
          attachment={attachment}
          key={attachment.id}
          onDelete={onDelete}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

type AttachmentChipProps = {
  attachment: FileAttachment;
  onDownload?: (attachment: FileAttachment) => void;
  onDelete?: (attachment: FileAttachment) => void;
  actionVisibility: "hover" | "always";
};

function AttachmentChip({
  attachment,
  onDownload,
  onDelete,
  actionVisibility,
}: Readonly<AttachmentChipProps>) {
  const actionClassName =
    actionVisibility === "always"
      ? undefined
      : "opacity-0 group-hover:opacity-100";

  return (
    <div className="group flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm">
      {attachment.previewUrl ? (
        <a
          className="flex shrink-0 hover:opacity-90"
          href={attachment.previewUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {/* biome-ignore lint/performance/noImgElement: preview URLs are external/dynamic */}
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
        {formatAttachmentSize(attachment.sizeBytes)}
      </span>
      {!attachment.previewUrl && onDownload ? (
        <Button
          aria-label={`Download ${attachment.filename}`}
          className={cn("h-6 w-6", actionClassName)}
          onClick={() => onDownload(attachment)}
          size="icon"
          variant="ghost"
        >
          <DownloadIcon className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      {onDelete ? (
        <Button
          aria-label={`Delete ${attachment.filename}`}
          className={cn("h-6 w-6", actionClassName)}
          onClick={() => onDelete(attachment)}
          size="icon"
          variant="ghost"
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) {
    return `${Math.ceil(sizeBytes / 1024)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
