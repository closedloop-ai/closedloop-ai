"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircle, Loader2, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";

type ZipUploadZoneProps = {
  onFileSelected: (file: File) => void;
  isExtracting: boolean;
  error: string | null;
};

export function ZipUploadZone({
  onFileSelected,
  isExtracting,
  error,
}: Readonly<ZipUploadZoneProps>) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith(".zip")) {
        onFileSelected(file);
      }
    },
    [onFileSelected]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        onFileSelected(file);
      }
    },
    [onFileSelected]
  );

  if (isExtracting) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground text-sm">Extracting archive...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div
        className={`flex w-full max-w-md cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-12 transition-colors ${
          isDragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-muted-foreground/50"
        }`}
        onClick={() => inputRef.current?.click()}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <Upload
          className={`size-10 ${isDragOver ? "text-primary" : "text-muted-foreground"}`}
        />
        <div className="text-center">
          <p className="font-medium text-sm">
            {isDragOver ? "Drop zip file here" : "Drop a run zip file here"}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            or click to browse
          </p>
        </div>
      </div>

      <input
        accept=".zip"
        className="hidden"
        onChange={handleInputChange}
        ref={inputRef}
        type="file"
      />

      {error && (
        <div className="flex items-center gap-2 text-destructive text-sm">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
          <Button
            className="ml-2"
            onClick={() => inputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
