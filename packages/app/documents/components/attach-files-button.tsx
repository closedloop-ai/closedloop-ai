"use client";

import {
  ALLOWED_EXTENSIONS,
  isMediaMimeType,
  maxAttachmentSizeBytesForMimeType,
} from "@repo/api/src/types/attachment";
import {
  useDeleteAttachment,
  useRequestAttachmentUpload,
} from "@repo/app/documents/hooks/use-attachments";
import { formatAttachmentSize } from "@repo/app/documents/lib/format-attachment-size";
import { uploadToS3 } from "@repo/app/shared/lib/s3-upload";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2Icon, PaperclipIcon } from "lucide-react";
import { useRef, useState } from "react";

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
  // The cleanup delete below runs only after a failed S3 upload, and the user
  // is told about the upload, not the cleanup (ISS-11741).
  const deleteAttachment = useDeleteAttachment(documentId, {
    suppressDefaultErrorToast: true,
  });

  function resetFileInput() {
    setIsUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    // Reject oversized files before requesting a presigned URL, mirroring the
    // inline-image path in rich-text-editor-host.tsx. Without this the client
    // would round-trip a presign request plus a full single-PUT upload only to
    // fail (or silently exceed limits), with no early feedback to the user.
    //
    // ISS-10415: the ceiling is per type, and the message names the one this
    // file was measured against — a single document-ceiling check here rejected
    // every real screen recording, and a single hardcoded "10 MiB" would state
    // a limit that does not apply to the file the user picked.
    const maxSizeBytes = maxAttachmentSizeBytesForMimeType(file.type);
    if (file.size > maxSizeBytes) {
      const sizeLabel = formatAttachmentSize(maxSizeBytes);
      toast.error(
        isMediaMimeType(file.type)
          ? `Video and audio files must be ${sizeLabel} or smaller`
          : `Files must be ${sizeLabel} or smaller`
      );
      resetFileInput();
      return;
    }

    setIsUploading(true);
    requestUpload.mutate(
      {
        documentId,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      },
      {
        onSuccess: ({ attachmentId, uploadUrl }) => {
          uploadToS3(uploadUrl, file, file.type)
            .catch((uploadError) => {
              toast.error(
                uploadError instanceof Error
                  ? uploadError.message
                  : "Upload failed"
              );
              deleteAttachment.mutate(attachmentId);
            })
            .finally(resetFileInput);
        },
        onError: resetFileInput,
      }
    );
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
