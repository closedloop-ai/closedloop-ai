"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBranchView } from "@/hooks/queries/use-branch-view";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { buildPrCommentChatContext, findCommentById } from "./comment-context";
import { BranchChatDrawer } from "./components/branch-chat-drawer";
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

type BranchWorktreeResponse = {
  path: string | null;
  repoPath: string | null;
};

async function fetchBranchWorktree(params: {
  repoFullName: string;
  headBranch: string;
  prNumber: number;
}): Promise<BranchWorktreeResponse> {
  const searchParams = new URLSearchParams({
    repoFullName: params.repoFullName,
    headBranch: params.headBranch,
    prNumber: String(params.prNumber),
  });
  const response = await fetch(
    `/api/chat/branch-worktree?${searchParams.toString()}`
  );
  if (!response.ok) {
    throw new Error("Failed to resolve branch worktree");
  }
  const raw = (await response.json()) as Partial<BranchWorktreeResponse>;
  return {
    path: typeof raw.path === "string" ? raw.path : null,
    repoPath: typeof raw.repoPath === "string" ? raw.repoPath : null,
  };
}

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
  const repoFullName = data?.repoFullName ?? "";
  const headBranch = data?.headBranch ?? "";
  const prNumber = data?.prNumber ?? 0;
  const branchWorktreeQuery = useQuery({
    queryKey: queryKeys.branchWorktree(repoFullName, headBranch, prNumber),
    queryFn: () =>
      fetchBranchWorktree({
        repoFullName,
        headBranch,
        prNumber,
      }),
    enabled:
      repoFullName.length > 0 &&
      headBranch.length > 0 &&
      Number.isInteger(prNumber),
  });
  const worktreePath = branchWorktreeQuery.data?.path ?? null;
  const showFilesystemNotice =
    branchWorktreeQuery.isSuccess && worktreePath === null;
  const chatFlag = useFeatureFlag("interactive-chat");
  const chatFlagEnabled = chatFlag?.enabled === true;
  const branchPrFlag = useFeatureFlag("branch-pr");
  const branchPrEnabled = branchPrFlag?.enabled === true;

  // When the branch-pr flag is off, redirect to the PR's GitHub URL as soon
  // as we know it. Keeps any existing /build/[id] links (shared links,
  // bookmarks, older plan-page renders) pointing at the right place.
  useEffect(() => {
    if (branchPrEnabled) {
      return;
    }
    if (!data?.prHtmlUrl) {
      return;
    }
    globalThis.location.replace(data.prHtmlUrl);
  }, [branchPrEnabled, data?.prHtmlUrl]);
  const [showChatPanel, setShowChatPanel] = useLocalStorageState(
    "panel:chat:branch",
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

  if (!branchPrEnabled) {
    return (
      <div className="flex min-h-full items-center justify-center gap-3 bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          Redirecting to GitHub...
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
        {chatFlagEnabled && showChatPanel ? (
          <BranchChatDrawer
            contextSelection={chatCommentContext}
            data={data}
            showFilesystemNotice={showFilesystemNotice}
            worktreePath={worktreePath}
          />
        ) : null}
      </main>
    </div>
  );
}
