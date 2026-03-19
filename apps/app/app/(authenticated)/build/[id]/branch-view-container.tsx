"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useCallback, useMemo, useState } from "react";
import { ArtifactChatPanel } from "@/components/artifact-editor/artifact-chat-panel";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { buildPrCommentChatContext, findCommentById } from "./comment-context";
import { BranchDiffView } from "./components/branch-diff-view";
import { BranchViewContent } from "./components/branch-view-content";
import { BranchViewHeader } from "./components/branch-view-header";
import type { StubBranchViewData, StubChangedFile } from "./types";

type BranchViewContainerProps = {
  data: StubBranchViewData;
};

function getAllChangedFiles(data: StubBranchViewData): StubChangedFile[] {
  return [...data.localFiles, ...data.committedFiles];
}

export function BranchViewContainer({
  data,
}: Readonly<BranchViewContainerProps>) {
  const [showChatPanel, setShowChatPanel] = useLocalStorageState(
    "panel:metadata:branch",
    true
  );
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null
  );
  const allFiles = getAllChangedFiles(data);
  const showDiffView = selectedFilePath !== null;

  const chatCommentContext = useMemo(() => {
    const comment = findCommentById(data.comments, selectedCommentId);
    if (!comment) {
      return null;
    }
    return buildPrCommentChatContext(comment);
  }, [data.comments, selectedCommentId]);

  const handleSelectComment = useCallback(
    (id: string | null) => {
      setSelectedCommentId(id);
      if (id !== null) {
        setShowChatPanel(true);
      }
    },
    [setShowChatPanel]
  );

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
              onClose={() => setSelectedFilePath(null)}
              onSelectFile={setSelectedFilePath}
              selectedFilePath={selectedFilePath}
            />
          ) : (
            <BranchViewContent
              data={data}
              onSelectComment={handleSelectComment}
              onSelectFile={setSelectedFilePath}
              selectedCommentId={selectedCommentId}
              selectedPath={null}
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
