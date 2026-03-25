"use client";

import { ALLOWED_EXTENSIONS } from "@repo/api/src/types/attachment";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { DownloadIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import {
  useAttachments,
  useDeleteAttachment,
  useDownloadAttachment,
  useRequestAttachmentUpload,
} from "@/hooks/queries/use-attachments";
import { uploadToS3 } from "@/lib/s3-upload";
import { CollapsibleSection } from "./collapsible-section";

export function AttachmentsSection({ artifactId }: { artifactId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: attachments } = useAttachments(artifactId);
  const requestUpload = useRequestAttachmentUpload();
  const deleteAttachment = useDeleteAttachment(artifactId);
  const downloadAttachment = useDownloadAttachment();

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploading(true);
    try {
      const { attachmentId, uploadUrl } = await requestUpload.mutateAsync({
        artifactId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      try {
        await uploadToS3(uploadUrl, file, file.type);
      } catch (uploadError) {
        // Compensate: delete the orphaned DB record
        await deleteAttachment.mutateAsync(attachmentId);
        throw uploadError;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <CollapsibleSection
      onOpenChange={setIsOpen}
      open={isOpen}
      title="Attachments"
    >
      <input
        accept={ALLOWED_EXTENSIONS}
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <div className="space-y-2">
        {attachments && attachments.length > 0 ? (
          attachments.map((attachment) => (
            <div
              className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm"
              key={attachment.id}
            >
              {attachment.previewUrl ? (
                /* biome-ignore lint/performance/noImgElement: S3 presigned URLs are external/dynamic */
                /* biome-ignore lint/correctness/useImageSize: dimensions set via CSS */
                <img
                  alt={attachment.filename}
                  className="max-h-48 w-full rounded object-contain"
                  src={attachment.previewUrl}
                />
              ) : null}
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{attachment.filename}</p>
                  <p className="text-muted-foreground text-xs">
                    {Math.ceil(attachment.sizeBytes / 1024)} KB
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {attachment.previewUrl ? null : (
                    <Button
                      onClick={() =>
                        downloadAttachment.mutate(
                          { artifactId, attachmentId: attachment.id },
                          { onError: () => toast.error("Download failed") }
                        )
                      }
                      size="icon"
                      variant="ghost"
                    >
                      <DownloadIcon className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    onClick={() =>
                      deleteAttachment.mutate(attachment.id, {
                        onError: () => toast.error("Delete failed"),
                      })
                    }
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">No attachments yet</p>
        )}
      </div>
      <Button
        className="w-full"
        disabled={isUploading}
        onClick={() => fileInputRef.current?.click()}
        size="sm"
        variant="outline"
      >
        {isUploading ? (
          <>
            <Loader2Icon className="h-4 w-4 animate-spin" />
            Uploading...
          </>
        ) : (
          "Attach File"
        )}
      </Button>
    </CollapsibleSection>
  );
}
