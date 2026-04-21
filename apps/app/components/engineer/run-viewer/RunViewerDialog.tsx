"use client";

import { Dialog, DialogTitle } from "@repo/design-system/components/ui/dialog";
import { MessageCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import {
  buildFileTree,
  decodeText,
  extractZip,
} from "@/lib/engineer/run-viewer-utils";
import type { RunData } from "@/types/run-viewer";
import { ContentViewer } from "./ContentViewer";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { RunOverviewDashboard } from "./RunOverviewDashboard";
import { RunViewerChatPanel } from "./RunViewerChatPanel";
import { ZipUploadZone } from "./ZipUploadZone";

type RunViewerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function getUploadType(file: File): "zip" | "jsonl" | null {
  const normalizedName = file.name.toLowerCase();
  const normalizedType = file.type.toLowerCase();

  if (
    normalizedName.endsWith(".zip") ||
    normalizedType === "application/zip" ||
    normalizedType === "application/x-zip-compressed"
  ) {
    return "zip";
  }
  if (
    normalizedName.endsWith(".jsonl") ||
    normalizedType === "application/x-ndjson" ||
    normalizedType === "application/jsonl" ||
    normalizedType === "application/jsonlines"
  ) {
    return "jsonl";
  }
  return null;
}

export function RunViewerDialog({
  open,
  onOpenChange,
}: Readonly<RunViewerDialogProps>) {
  const [runData, setRunData] = useState<RunData | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState<string>("");
  const [chatOpen, setChatOpen] = useState(false);
  const [runDir, setRunDir] = useState<string | null>(null);
  const [chatWidth, setChatWidth] = useState(350);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleFileSelected = useCallback(async (file: File) => {
    setIsExtracting(true);
    setError(null);
    try {
      const uploadType = getUploadType(file);
      if (uploadType === "zip") {
        const data = await extractZip(file);
        setRunData(data);
        setSessionName(file.name.replace(/\.zip$/i, ""));
        setSelectedFile(null);

        // Upload zip server-side for Claude file tools
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/gateway/run-viewer-extract", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          const { runDir: dir } = await res.json();
          setRunDir(dir);
        }
        return;
      }

      if (uploadType === "jsonl") {
        const raw = new Uint8Array(await file.arrayBuffer());
        const filePath = file.name;
        setRunData({
          files: new Map([[filePath, raw]]),
          tree: buildFileTree([filePath]),
        });
        setSessionName(file.name.replace(/\.jsonl$/i, ""));
        setSelectedFile(filePath);
        setRunDir(null);
        return;
      }

      setError("Unsupported file type. Upload a .zip or .jsonl file.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load selected file");
    } finally {
      setIsExtracting(false);
    }
  }, []);

  const handleClose = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        // Clean up server-side extracted files
        if (runDir) {
          fetch("/api/gateway/run-viewer-extract", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runDir }),
          }).catch(() => {});
        }
        setRunData(null);
        setRunDir(null);
        setIsExtracting(false);
        setError(null);
        setSelectedFile(null);
        setSessionName("");
        setChatOpen(false);
        // Clear chat history when dialog closes
        fetch("/api/gateway/run-viewer-chat", { method: "DELETE" }).catch(
          () => {}
        );
      }
      onOpenChange(isOpen);
    },
    [onOpenChange, runDir]
  );

  // Drag-to-resize chat panel
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: chatWidth };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) {
          return;
        }
        const delta = dragRef.current.startX - ev.clientX;
        const newWidth = Math.min(
          800,
          Math.max(250, dragRef.current.startWidth + delta)
        );
        setChatWidth(newWidth);
      };

      const onMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [chatWidth]
  );

  // Reset chat width when panel closes
  useEffect(() => {
    if (!chatOpen) {
      setChatWidth(350);
    }
  }, [chatOpen]);

  const selectedFileData = selectedFile
    ? runData?.files.get(selectedFile)
    : undefined;
  const selectedFileText = useMemo(
    () => (selectedFileData ? decodeText(selectedFileData) : undefined),
    [selectedFileData]
  );

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <ExpandableDialogContent
        className="!p-0 flex flex-col overflow-hidden"
        isExpanded={true}
        showCloseButton={true}
      >
        <DialogTitle className="sr-only">Run Viewer</DialogTitle>

        {runData ? (
          <>
            {/* Header */}
            <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
              <h2 className="truncate font-semibold text-sm">{sessionName}</h2>
              <span className="text-muted-foreground text-xs">
                {runData.files.size} files
              </span>
              <span className="flex-1" />
            </div>

            {/* Body: sidebar + content + chat */}
            <div className="flex min-h-0 flex-1">
              {/* File tree sidebar */}
              <div className="w-[250px] shrink-0 overflow-hidden border-r">
                <FileTreeSidebar
                  onSelectFile={setSelectedFile}
                  selectedPath={selectedFile}
                  tree={runData.tree}
                />
              </div>

              {/* Content area */}
              <div className="min-w-0 flex-1 overflow-hidden">
                {selectedFile && selectedFileData ? (
                  <ContentViewer
                    fileData={selectedFileData}
                    filePath={selectedFile}
                  />
                ) : (
                  <RunOverviewDashboard
                    onSelectFile={setSelectedFile}
                    runData={runData}
                  />
                )}
              </div>

              {/* Chat panel with drag handle */}
              {chatOpen && (
                <div
                  className="flex shrink-0 overflow-hidden"
                  style={{ width: chatWidth }}
                >
                  {/* Drag handle */}
                  <button
                    aria-label="Resize chat panel"
                    className="w-1 shrink-0 cursor-col-resize border-y-0 border-r-0 border-l bg-transparent p-0 transition-colors hover:bg-primary/30 focus:outline-none active:bg-primary/50"
                    onMouseDown={handleDragStart}
                    type="button"
                  />
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <RunViewerChatPanel
                      onClose={() => setChatOpen(false)}
                      runDir={runDir ?? undefined}
                      selectedFileContent={selectedFileText}
                      selectedFilePath={selectedFile}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Floating chat toggle — hidden when chat panel is open */}
            {!chatOpen && (
              <button
                className="absolute right-5 bottom-5 z-10 flex size-10 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:scale-105 hover:shadow-xl"
                onClick={() => setChatOpen(true)}
                title="Chat about this run"
                type="button"
              >
                <MessageCircle className="size-5" />
              </button>
            )}
          </>
        ) : (
          <ZipUploadZone
            error={error}
            isExtracting={isExtracting}
            onFileSelected={handleFileSelected}
          />
        )}
      </ExpandableDialogContent>
    </Dialog>
  );
}
