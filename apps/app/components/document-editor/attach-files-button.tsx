"use client";

import { ALLOWED_EXTENSIONS } from "@repo/api/src/types/attachment";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2Icon, PaperclipIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  useDeleteAttachment,
  useRequestAttachmentUpload,
} from "@/hooks/queries/use-attachments";
import { uploadToS3 } from "@/lib/s3-upload";

type AttachFilesButtonProps = {
  documentId: string;
};

/**
 * Ghost button that opens a native file picker and uploads the selected file
 * to the document's attachment bucket. Designed to sit inside
 * `MetadataPanel variant="bar"`.
 */
export function AttachFilesButton({
  documentId,
}: Readonly<AttachFilesButtonProps>) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const requestUpload = useRequestAttachmentUpload();
  const deleteAttachment = useDeleteAttachment(documentId);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploading(true);
    try {
      const { attachmentId, uploadUrl } = await requestUpload.mutateAsync({
        documentId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      try {
        await uploadToS3(uploadUrl, file, file.type);
      } catch (uploadError) {
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
    <>
      <input
        accept={ALLOWED_EXTENSIONS}
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <Button
        className="gap-1.5"
        disabled={isUploading}
        onClick={() => fileInputRef.current?.click()}
        size="sm"
        variant="outline"
      >
        {isUploading ? (
          <Loader2Icon className="h-4 w-4 animate-spin" />
        ) : (
          <PaperclipIcon className="h-4 w-4" />
        )}
        Attach files
      </Button>
    </>
  );
}
