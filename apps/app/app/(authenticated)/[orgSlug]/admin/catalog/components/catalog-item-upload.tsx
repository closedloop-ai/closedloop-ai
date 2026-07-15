"use client";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import {
  useConfirmUpload,
  useUploadIntent,
} from "@repo/app/agents/hooks/use-catalog";
import { uploadToS3 } from "@repo/app/shared/lib/s3-upload";
import { Button } from "@repo/design-system/components/ui/button";
import { useCallback, useRef, useState } from "react";

type UploadStep =
  | { kind: "idle" }
  | { kind: "uploading"; progress: "intent" | "s3" | "confirm" }
  | { kind: "done"; item: CatalogItemDto }
  | { kind: "error"; message: string };

type Props = {
  /** The catalog item to attach the uploaded asset to. */
  catalogItemId: string;
  /** Which asset type to upload ("zip" for the plugin bundle, "logo" for the image). */
  fileType: "zip" | "logo";
  /** Called after successful three-step upload to allow parent to refresh UI. */
  onSuccess?: (item: CatalogItemDto) => void;
};

/**
 * Two-step presigned S3 upload flow for CatalogItem assets (T-17.2).
 *
 * Step 1: POST /catalog/upload-intent → presigned S3 PUT URL.
 * Step 2: Browser PUT to S3 (no Authorization header — presigned URL is self-auth).
 * Step 3: POST /catalog/confirm → server-side HeadObject verification.
 *
 * Reuses `uploadToS3` from packages/app/shared/lib/s3-upload.ts.
 */
export function CatalogItemUpload({
  catalogItemId,
  fileType,
  onSuccess,
}: Props) {
  const [step, setStep] = useState<UploadStep>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadIntent = useUploadIntent();
  const confirmUpload = useConfirmUpload();

  const acceptedTypes = fileType === "zip" ? ".zip,application/zip" : "image/*";
  const label = fileType === "zip" ? "Plugin bundle (.zip)" : "Logo image";

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      setStep({ kind: "uploading", progress: "intent" });

      try {
        // Step 1: Get presigned URL
        const intent = await uploadIntent.mutateAsync({
          catalogItemId,
          fileType,
          contentType: file.type || "application/octet-stream",
          fileSizeBytes: file.size,
        });

        setStep({ kind: "uploading", progress: "s3" });

        // Step 2: PUT file directly to S3
        await uploadToS3(
          intent.presignedUrl,
          file,
          file.type || "application/octet-stream"
        );

        setStep({ kind: "uploading", progress: "confirm" });

        // Step 3: Confirm HeadObject
        const updatedItem = await confirmUpload.mutateAsync({
          catalogItemId,
          fileType,
          s3Key: intent.s3Key,
        });

        setStep({ kind: "done", item: updatedItem });
        onSuccess?.(updatedItem);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setStep({ kind: "error", message });
      } finally {
        // Clear the file input so the same file can be re-selected
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [catalogItemId, fileType, uploadIntent, confirmUpload, onSuccess]
  );

  const progressLabel: Record<"intent" | "s3" | "confirm", string> = {
    intent: "Requesting upload URL…",
    s3: "Uploading to storage…",
    confirm: "Verifying upload…",
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        accept={acceptedTypes}
        aria-label={`Upload ${label}`}
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />

      {(step.kind === "idle" ||
        step.kind === "error" ||
        step.kind === "done") && (
        <Button
          onClick={() => fileInputRef.current?.click()}
          size="sm"
          type="button"
          variant="outline"
        >
          {step.kind === "done" ? `Replace ${label}` : `Upload ${label}`}
        </Button>
      )}

      {step.kind === "uploading" && (
        <p className="text-muted-foreground text-sm">
          {progressLabel[step.progress]}
        </p>
      )}

      {step.kind === "done" && (
        <p className="text-green-600 text-sm">{label} uploaded successfully.</p>
      )}

      {step.kind === "error" && (
        <p className="text-destructive text-sm">{step.message}</p>
      )}
    </div>
  );
}
