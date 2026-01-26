"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { UploadIcon } from "lucide-react";
import { useRef } from "react";
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const content = await file.text();
    uploadMutation.mutate(
      { projectId, markdownContent: content },
      {
        onSuccess: (project) => {
          if (project.lastIndexedAt) {
            onUploadSuccess?.(new Date(project.lastIndexedAt));
          }
        },
        onSettled: () => {
          // Reset the input so the same file can be selected again
          if (fileInputRef.current) {
            fileInputRef.current.value = "";
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
      <input
        accept=".md"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />
      <Button
        className="w-full"
        disabled={uploadMutation.isPending}
        onClick={handleButtonClick}
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
