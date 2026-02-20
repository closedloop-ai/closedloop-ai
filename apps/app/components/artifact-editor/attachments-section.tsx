"use client";

import { ALLOWED_EXTENSIONS } from "@repo/api/src/types/attachment";
import { Button } from "@repo/design-system/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import {
  attachmentKeys,
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
  const queryClient = useQueryClient();

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
      const { uploadUrl } = await requestUpload.mutateAsync({
        artifactId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      await uploadToS3(uploadUrl, file, file.type);
      await queryClient.invalidateQueries({
        queryKey: attachmentKeys.list(artifactId),
      });
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
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              key={attachment.id}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{attachment.filename}</p>
                <p className="text-muted-foreground text-xs">
                  {Math.ceil(attachment.sizeBytes / 1024)} KB
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  onClick={() =>
                    downloadAttachment.mutate({
                      artifactId,
                      attachmentId: attachment.id,
                    })
                  }
                  size="icon"
                  variant="ghost"
                >
                  <DownloadIcon className="h-4 w-4" />
                </Button>
                <Button
                  onClick={() => deleteAttachment.mutate(attachment.id)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
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
            <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            Uploading...
          </>
        ) : (
          "Attach File"
        )}
      </Button>
    </CollapsibleSection>
  );
}
