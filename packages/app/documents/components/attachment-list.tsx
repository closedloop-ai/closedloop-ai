"use client";

import {
  AttachmentPurpose,
  type FileAttachment,
} from "@repo/api/src/types/attachment";
import { INLINE_ATTACHMENT_BADGE_LABEL } from "@repo/app/documents/lib/attachment-visibility";
import { formatAttachmentSize } from "@repo/app/documents/lib/format-attachment-size";
import { Badge } from "@repo/design-system/components/ui/badge";
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
 * Every attachment gets a download button when an `onDownload` handler is
 * provided — images included (ISS-8036), whose thumbnail links to a preview URL
 * that only ever opened the image, never saved it. Non-image types
 * (`.md`, `.txt`, `.pdf`, `.csv`, …) additionally make the filename itself
 * clickable, since they have no thumbnail to click.
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
  // On a touch pointer there is no hover to reveal the download / delete
  // actions, so `touch:opacity-100` keeps them visible; the mouse hover reveal
  // is unchanged. `focus-visible:` does the same for the keyboard — these are
  // focus stops, so without it tabbing lands on a control that renders nothing
  // (WCAG 2.4.7).
  const actionClassName =
    actionVisibility === "always"
      ? undefined
      : "opacity-0 touch:opacity-100 focus-visible:opacity-100 group-hover:opacity-100";

  // Non-image files have no thumbnail to click, so the filename itself becomes
  // the affordance — this is what makes `.md`, `.txt`, `.pdf`, etc. attachments
  // openable rather than dead text (FEA-1940). An image keeps its plain
  // filename because its thumbnail is already the click target; the download
  // button below serves both.
  const isFilenameClickable = !attachment.previewUrl && Boolean(onDownload);

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
      {isFilenameClickable ? (
        <button
          className="max-w-[180px] truncate rounded font-medium underline-offset-2 hover:underline"
          onClick={() => onDownload?.(attachment)}
          type="button"
        >
          {attachment.filename}
        </button>
      ) : (
        <span className="max-w-[180px] truncate font-medium">
          {attachment.filename}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground text-xs">
        {formatAttachmentSize(attachment.sizeBytes)}
      </span>
      {attachment.purpose === AttachmentPurpose.Inline ? (
        <Badge className="shrink-0" variant="muted">
          {INLINE_ATTACHMENT_BADGE_LABEL}
        </Badge>
      ) : null}
      {onDownload ? (
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
