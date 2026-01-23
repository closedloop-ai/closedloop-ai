"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { uploadCodebaseSummary } from "@/app/actions/projects";

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
  const [isUploading, setIsUploading] = useState(false);
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

    setIsUploading(true);
    try {
      const content = await file.text();
      const result = await uploadCodebaseSummary(projectId, content);

      if (result.success && result.data.lastIndexedAt) {
        onUploadSuccess?.(new Date(result.data.lastIndexedAt));
      } else if (!result.success) {
        console.error("Failed to upload codebase summary:", result.error);
      }
    } catch (error) {
      console.error("Error reading file:", error);
    } finally {
      setIsUploading(false);
      // Reset the input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
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
        disabled={isUploading}
        onClick={handleButtonClick}
        variant="outline"
      >
        <UploadIcon className="mr-2 h-4 w-4" />
        {isUploading ? "Uploading..." : "Upload Codebase Summary"}
      </Button>
      {lastIndexedAt ? (
        <p className="text-muted-foreground text-xs">
          Last uploaded: {formatDate(new Date(lastIndexedAt))}
        </p>
      ) : null}
    </div>
  );
}
