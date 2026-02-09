"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { UploadIcon } from "lucide-react";
import { useRef } from "react";
import {
  HiddenFileInput,
  type HiddenFileInputHandle,
} from "@/components/hidden-file-input";
import { useUploadCodebaseSummary } from "@/hooks/queries/use-projects";

type CodebaseSummaryUploadProps = {
  projectId: string;
  lastIndexedAt: Date | null;
  onUploadSuccess?: (lastIndexedAt: Date) => void;
};

export function CodebaseSummaryUpload({
  projectId,
  lastIndexedAt,
  onUploadSuccess,
}: CodebaseSummaryUploadProps) {
  const uploadMutation = useUploadCodebaseSummary();
  const fileInputRef = useRef<HiddenFileInputHandle>(null);

  const handleFileRead = (content: string) => {
    uploadMutation.mutate(
      { projectId, markdownContent: content },
      {
        onSuccess: (project) => {
          if (project.lastIndexedAt) {
            onUploadSuccess?.(new Date(project.lastIndexedAt));
          }
        },
      }
    );
  };

  const formatDate = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    }).format(date);

  return (
    <div className="space-y-2">
      <HiddenFileInput
        accept=".md"
        onFileRead={handleFileRead}
        ref={fileInputRef}
      />
      <Button
        className="w-full"
        disabled={uploadMutation.isPending}
        onClick={() => fileInputRef.current?.open()}
        variant="outline"
      >
        <UploadIcon className="mr-2 h-4 w-4" />
        {uploadMutation.isPending ? "Uploading..." : "Upload Codebase Summary"}
      </Button>
      {lastIndexedAt ? (
        <p className="text-muted-foreground text-xs">
          Last uploaded: {formatDate(new Date(lastIndexedAt))}
        </p>
      ) : null}
    </div>
  );
}
