"use client";

import { cn } from "@repo/design-system/lib/utils";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { useBranchView } from "@/hooks/queries/use-branch-view";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { buildPrCommentChatContext, findCommentById } from "./comment-context";
import { BranchDiffView } from "./components/branch-diff-view";
import { BranchViewContent } from "./components/branch-view-content";
import { BranchViewHeader } from "./components/branch-view-header";
import {
  type BranchViewData,
  buildFileId,
  type ChangedFileEntry,
  FileSection,
} from "./types";

type BranchViewContainerProps = {
  externalLinkId: string;
};

function buildAllFileEntries(
  data: BranchViewData,
  localFiles: BranchViewData["committedFiles"]
): ChangedFileEntry[] {
  const local = localFiles.map((file) => ({
    fileId: buildFileId(FileSection.Local, file.path),
    section: FileSection.Local as FileSection,
    file,
  }));
  const committed = data.committedFiles.map((file) => ({
    fileId: buildFileId(FileSection.Committed, file.path),
    section: FileSection.Committed as FileSection,
    file,
  }));
  return [...local, ...committed];
}

export function BranchViewContainer({
  externalLinkId,
}: Readonly<BranchViewContainerProps>) {
  const { data, isLoading, error } = useBranchView(externalLinkId);
  const [showChatPanel, setShowChatPanel] = useLocalStorageState(
    "panel:metadata:branch",
    true
  );
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null
  );

  // Local files will be populated in Phase 6 via engineer relay
  const localFiles: BranchViewData["committedFiles"] = [];

  const allFiles = useMemo(
    () => (data ? buildAllFileEntries(data, localFiles) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localFiles is static today; add to deps when Phase 6 makes it dynamic
    [data]
  );
  const showDiffView = selectedFileId !== null;

  const chatCommentContext = useMemo(() => {
    if (!data) {
      return null;
    }
    const comment = findCommentById(data.comments, selectedCommentId);
    if (!comment) {
      return null;
    }
    return buildPrCommentChatContext(comment);
  }, [data, selectedCommentId]);

  const handleSelectComment = useCallback(
    (id: string | null) => {
      setSelectedCommentId(id);
      if (id !== null) {
        setShowChatPanel(true);
      }
    },
    [setShowChatPanel]
  );

  if (isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">
          {error?.message ?? "Branch view not found"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-background">
      <BranchViewHeader
        data={data}
        onToggleChatPanel={() => setShowChatPanel((prev) => !prev)}
        showChatPanel={showChatPanel}
      />
      <main className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-w-0 flex-1 border-border border-r",
            showDiffView
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto overflow-x-hidden"
          )}
        >
          {showDiffView ? (
            <BranchDiffView
              allFiles={allFiles}
              externalLinkId={externalLinkId}
              onClose={() => setSelectedFileId(null)}
              onSelectFile={setSelectedFileId}
              selectedFileId={selectedFileId}
            />
          ) : (
            <BranchViewContent
              data={data}
              localFiles={localFiles}
              onSelectComment={handleSelectComment}
              onSelectFile={setSelectedFileId}
              selectedCommentId={selectedCommentId}
              selectedFileId={null}
            />
          )}
        </div>
        {showChatPanel ? (
          <ArtifactChatPanel
            artifactId={data.externalLinkId}
            artifactType="branch"
            contextSelection={chatCommentContext}
          />
        ) : null}
      </main>
    </div>
  );
}
