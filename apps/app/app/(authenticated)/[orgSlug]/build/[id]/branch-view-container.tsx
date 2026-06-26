"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import {
  FeedSidebar,
  FeedTab,
} from "@repo/app/documents/components/feed-sidebar/feed-sidebar";
import type { AnyFeedSource } from "@repo/app/documents/components/feed-sidebar/feed-source";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import {
  BranchViewLoadUiMode,
  branchViewKeys,
  getBranchViewLoadState,
  useBranchView,
  useBranchViewSyncControl,
  useCreateBranchViewConversationComment,
  useDeleteBranchViewConversationComment,
  useDeleteBranchViewReviewComment,
  useEditBranchViewConversationComment,
  useEditBranchViewReviewComment,
  useReplyToComment,
  useResolveBranchViewReviewThread,
  useUnresolveBranchViewReviewThread,
} from "@repo/app/documents/hooks/use-branch-view";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { useOrganization } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  Loader2,
  RefreshCwIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import {
  type BranchViewContextValue,
  BranchViewProvider,
} from "./branch-view-context";
import { buildPrCommentChatContext, findCommentById } from "./comment-context";
import { BranchChatDrawer } from "./components/branch-chat-drawer";
import { BranchDiffView } from "./components/branch-diff-view";
import { BranchViewCommentIdentityBlockerProvider } from "./components/branch-view-comment-identity-blocker-store";
import { BranchViewContent } from "./components/branch-view-content";
import { BranchViewHeader } from "./components/branch-view-header";
import { prCommentSource } from "./feed-sources/pr-comment-source";
import type {
  BranchFileSelectionTarget,
  CommentDiffNavigationRequest,
} from "./file-targets";
import {
  type BranchLocalIdentity,
  commitAndPushBranchLocalChanges,
  fetchBranchLocalChanges,
  fetchBranchWorktree,
} from "./local-branch-changes";
import {
  type BranchViewData,
  buildFileId,
  type ChangedFileEntry,
  FileSection,
} from "./types";

const BRANCH_FEED_SOURCES: readonly AnyFeedSource[] = [prCommentSource];

type BranchViewContainerProps = {
  externalLinkId: string;
  orgSlug: string;
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

function useBranchPrFlagState(): { enabled: boolean; loading: boolean } {
  const flag = useFeatureFlag("branch-pr");
  return {
    enabled: flag?.enabled === true,
    loading: flag === undefined,
  };
}

function canRouteBranchWorktreeQuery(input: {
  computeTargetId: string | null;
  electronDetected: boolean;
  mode: EngineerRoutingMode;
}): boolean {
  return (
    (input.mode === EngineerRoutingMode.LocalElectron &&
      input.electronDetected) ||
    (input.mode === EngineerRoutingMode.CloudRelay &&
      input.computeTargetId !== null)
  );
}

function canEnableLocalGateway(input: {
  branchPrEnabled: boolean;
  data: BranchViewData | undefined;
  headBranch: string;
  prNumber: number;
  repoFullName: string;
  routeable: boolean;
}): boolean {
  return Boolean(
    input.branchPrEnabled &&
      input.data?.isAuthor === true &&
      input.repoFullName.length > 0 &&
      input.headBranch.length > 0 &&
      Number.isInteger(input.prNumber) &&
      input.prNumber > 0 &&
      input.routeable
  );
}

function buildLocalIdentity(input: {
  data: BranchViewData | undefined;
  externalLinkId: string;
  routing: ReturnType<typeof useEngineerRoutingSelection>;
  worktreePath: string | null;
}): BranchLocalIdentity | null {
  if (!(input.data && input.worktreePath)) {
    return null;
  }
  return {
    externalLinkId: input.externalLinkId,
    repoPath: input.worktreePath,
    repoFullName: input.data.repoFullName,
    headBranch: input.data.headBranch,
    prNumber: input.data.prNumber,
    routing: {
      mode: input.routing.mode,
      computeTargetId: input.routing.computeTargetId,
    },
  };
}

function useBranchLocalState(input: {
  data: BranchViewData | undefined;
  externalLinkId: string;
  headBranch: string;
  localGatewayEnabled: boolean;
  onPostCommitBranchSync: () => void;
  prNumber: number;
  repoFullName: string;
  routing: ReturnType<typeof useEngineerRoutingSelection>;
  routingKey: string;
}) {
  const queryClient = useQueryClient();
  const branchWorktreeQuery = useQuery({
    queryKey: queryKeys.branchWorktree(
      input.repoFullName,
      input.headBranch,
      input.prNumber,
      input.routingKey
    ),
    queryFn: () =>
      fetchBranchWorktree({
        repoFullName: input.repoFullName,
        headBranch: input.headBranch,
        prNumber: input.prNumber,
      }),
    enabled: input.localGatewayEnabled,
  });
  const worktreePath = branchWorktreeQuery.data?.path ?? null;
  const localIdentity = buildLocalIdentity({
    data: input.data,
    externalLinkId: input.externalLinkId,
    routing: input.routing,
    worktreePath,
  });
  const localChangesQuery = useQuery({
    queryKey: queryKeys.branchLocalChanges(
      input.repoFullName,
      input.headBranch,
      worktreePath ?? "",
      input.routingKey
    ),
    queryFn: () => {
      if (!localIdentity) {
        throw new Error("Local changes are unavailable");
      }
      return fetchBranchLocalChanges(localIdentity);
    },
    enabled: input.localGatewayEnabled && localIdentity !== null,
  });
  const commitMutation = useMutation({
    mutationFn: () => {
      if (!(input.data && localIdentity)) {
        throw new Error("Local changes are unavailable");
      }
      return commitAndPushBranchLocalChanges({
        ...localIdentity,
        message: `Update ${input.data.featureSlug ?? input.data.prTitle}`,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.branchLocalChanges(
          input.repoFullName,
          input.headBranch,
          worktreePath ?? "",
          input.routingKey
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.branchWorktree(
          input.repoFullName,
          input.headBranch,
          input.prNumber,
          input.routingKey
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: branchViewKeys.fileDiffs(),
      });
      input.onPostCommitBranchSync();
    },
  });

  return {
    branchWorktreeQuery,
    commitMutation,
    localChangesQuery,
    localIdentity,
    worktreePath,
  };
}

function useBranchViewMutations(
  externalLinkId: string
): BranchViewContextValue["mutations"] {
  const reply = useReplyToComment(externalLinkId);
  const createConversation =
    useCreateBranchViewConversationComment(externalLinkId);
  const editConversation = useEditBranchViewConversationComment(externalLinkId);
  const deleteConversation =
    useDeleteBranchViewConversationComment(externalLinkId);
  const editReview = useEditBranchViewReviewComment(externalLinkId);
  const deleteReview = useDeleteBranchViewReviewComment(externalLinkId);
  const resolveThread = useResolveBranchViewReviewThread(externalLinkId);
  const unresolveThread = useUnresolveBranchViewReviewThread(externalLinkId);
  return useMemo(
    () => ({
      reply,
      createConversation,
      editConversation,
      deleteConversation,
      editReview,
      deleteReview,
      resolveThread,
      unresolveThread,
    }),
    [
      reply,
      createConversation,
      editConversation,
      deleteConversation,
      editReview,
      deleteReview,
      resolveThread,
      unresolveThread,
    ]
  );
}

function useBranchPrFallbackRedirect(input: {
  branchPrEnabled: boolean;
  branchPrLoading: boolean;
  prHtmlUrl: string | undefined;
}) {
  // When the branch-pr flag is off, redirect to the PR's GitHub URL as soon
  // as we know it. Keeps any existing /build/[id] links (shared links,
  // bookmarks, older plan-page renders) pointing at the right place. Skip
  // the redirect while the flag is still loading.
  useEffect(() => {
    if (input.branchPrLoading || input.branchPrEnabled) {
      return;
    }
    if (!input.prHtmlUrl) {
      return;
    }
    globalThis.location.replace(input.prHtmlUrl);
  }, [input.branchPrLoading, input.branchPrEnabled, input.prHtmlUrl]);
}

function renderBranchViewGate(input: {
  branchPrEnabled: boolean;
  branchPrLoading: boolean;
  data: BranchViewData | undefined;
  error: Error | null;
  isFetching: boolean;
  isLoading: boolean;
  orgSlug: string;
  refetch: () => void;
}) {
  if (input.isLoading || (input.isFetching && input.error)) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (input.error || !input.data) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background px-4 py-10">
        <BranchViewUnavailableState
          loadState={getBranchViewLoadState(input.error)}
          onRetry={input.refetch}
          orgSlug={input.orgSlug}
        />
      </div>
    );
  }

  if (input.branchPrLoading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!input.branchPrEnabled) {
    return (
      <div className="flex min-h-full items-center justify-center gap-3 bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          Redirecting to GitHub...
        </p>
      </div>
    );
  }

  return null;
}

function requireLoadedBranchView(data: BranchViewData | undefined) {
  if (!data) {
    throw new Error("Branch view not found");
  }
  return data;
}

function getEffectiveSelectedFileTarget(input: {
  localGatewayEnabled: boolean;
  selectedFileTarget: BranchFileSelectionTarget | null;
}): BranchFileSelectionTarget | null {
  if (
    !input.localGatewayEnabled &&
    input.selectedFileTarget?.fileId.startsWith(`${FileSection.Local}:`)
  ) {
    return null;
  }
  return input.selectedFileTarget;
}

function getRouteableLocalBranchState(input: {
  localChangesQuery: ReturnType<
    typeof useBranchLocalState
  >["localChangesQuery"];
  localGatewayEnabled: boolean;
  localIdentity: BranchLocalIdentity | null;
  worktreePath: string | null;
}) {
  if (!input.localGatewayEnabled) {
    return {
      localError: null,
      localFiles: [],
      localIdentity: null,
      worktreePath: null,
    };
  }

  return {
    localError: input.localChangesQuery.error,
    localFiles: input.localChangesQuery.data ?? [],
    localIdentity: input.localIdentity,
    worktreePath: input.worktreePath,
  };
}

export function BranchViewContainer({
  externalLinkId,
  orgSlug,
}: Readonly<BranchViewContainerProps>) {
  const { data, isFetching, isLoading, error, refetch } =
    useBranchView(externalLinkId);
  const searchParams = useSearchParamsValue();
  const githubStatus = searchParams?.get("github") ?? null;
  const postGitHubConnectRefetchStarted = useRef(false);
  useEffect(() => {
    if (postGitHubConnectRefetchStarted.current) {
      return;
    }
    if (githubStatus !== "connected") {
      return;
    }
    postGitHubConnectRefetchStarted.current = true;
    refetch();
  }, [githubStatus, refetch]);
  const availableData = error ? undefined : data;
  const repoFullName = availableData?.repoFullName ?? "";
  const headBranch = availableData?.headBranch ?? "";
  const prNumber = availableData?.prNumber ?? 0;
  const routing = useEngineerRoutingSelection();
  const electronDetection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
  const routingKey = `${routing.mode}:${routing.computeTargetId ?? "none"}`;
  const routeable = canRouteBranchWorktreeQuery({
    computeTargetId: routing.computeTargetId,
    electronDetected: electronDetection.detected,
    mode: routing.mode,
  });
  const chatFlag = useFeatureFlag("interactive-chat");
  const chatFlagEnabled = chatFlag?.enabled === true;
  const branchPrFlag = useBranchPrFlagState();
  // Distinguish "flag is still loading" (undefined) from "flag resolved to
  // disabled" (?.enabled !== true). Treating the loading state as disabled
  // fires the redirect useEffect below and ships users to GitHub on every
  // fresh page load, which is wrong. Only redirect once PostHog has actually
  // reported the flag value.
  const branchPrLoading = branchPrFlag.loading;
  const branchPrEnabled = branchPrFlag.enabled;
  const syncControl = useBranchViewSyncControl({
    backgroundEnabled: branchPrEnabled && !branchPrLoading,
    data: availableData,
    externalLinkId,
  });
  const localGatewayEnabled = canEnableLocalGateway({
    branchPrEnabled,
    data: availableData,
    headBranch,
    prNumber,
    repoFullName,
    routeable,
  });
  const {
    branchWorktreeQuery,
    commitMutation,
    localChangesQuery,
    localIdentity,
    worktreePath,
  } = useBranchLocalState({
    data: availableData,
    externalLinkId,
    headBranch,
    localGatewayEnabled,
    onPostCommitBranchSync: syncControl.refreshBranch,
    prNumber,
    repoFullName,
    routing,
    routingKey,
  });
  const routeableLocalState = getRouteableLocalBranchState({
    localChangesQuery,
    localGatewayEnabled,
    localIdentity,
    worktreePath,
  });
  const showFilesystemNotice =
    localGatewayEnabled &&
    branchWorktreeQuery.isSuccess &&
    worktreePath === null;
  useBranchPrFallbackRedirect({
    branchPrEnabled,
    branchPrLoading,
    prHtmlUrl: availableData?.prHtmlUrl,
  });
  const feedSidebarFlag = useFeatureFlag("comments-v2-feed-sidebar");
  const { organization } = useOrganization();
  const organizationId = organization?.id ?? "";
  // Defer the FeedSidebar mount until Clerk hands us a real organization
  // id. Otherwise `panel:feed:branch:` collapses to a shared storage
  // slot across orgs/sessions during the hydration window. Flag-off
  // path runs in the meantime (~200ms blink).
  const feedSidebarEnabled =
    feedSidebarFlag?.enabled === true && organizationId.length > 0;
  const feedStorageKey = `panel:feed:branch:${organizationId}`;
  const [showChatPanel, setShowChatPanel] = useLocalStorageState(
    "panel:chat:branch",
    true
  );
  const [feedOpen, setFeedOpen] = useLocalStorageState(feedStorageKey, true);
  const [activeFeedTab, setActiveFeedTab] = useState<FeedTab>(FeedTab.Feed);
  const [selectedFileTarget, setSelectedFileTarget] =
    useState<BranchFileSelectionTarget | null>(null);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(
    null
  );

  // Mutations consumed by the PR comment source through BranchViewProvider.
  const branchMutations = useBranchViewMutations(externalLinkId);

  const effectiveSelectedFileTarget = getEffectiveSelectedFileTarget({
    localGatewayEnabled,
    selectedFileTarget,
  });

  const allFiles = useMemo(
    () =>
      availableData
        ? buildAllFileEntries(availableData, routeableLocalState.localFiles)
        : [],
    [availableData, routeableLocalState.localFiles]
  );
  const showDiffView = effectiveSelectedFileTarget !== null;

  const chatCommentContext = useMemo(() => {
    if (!availableData) {
      return null;
    }
    const comment = findCommentById(availableData.comments, selectedCommentId);
    if (!comment) {
      return null;
    }
    return buildPrCommentChatContext(comment);
  }, [availableData, selectedCommentId]);

  const handleSelectComment = useCallback(
    (id: string | null) => {
      setSelectedCommentId(id);
      if (id === null) {
        return;
      }
      if (feedSidebarEnabled) {
        setFeedOpen(true);
        setActiveFeedTab(FeedTab.Chat);
        return;
      }
      setShowChatPanel(true);
    },
    [feedSidebarEnabled, setFeedOpen, setShowChatPanel]
  );

  const selectFileTarget = useCallback(
    (fileId: string, line: number | null) => {
      setSelectedFileTarget((previous) => ({
        fileId,
        line,
        activationId: (previous?.activationId ?? 0) + 1,
      }));
      if (feedSidebarEnabled) {
        setFeedOpen(false);
      }
    },
    [feedSidebarEnabled, setFeedOpen]
  );

  const handleSelectCommentDiffTarget = useCallback(
    (request: CommentDiffNavigationRequest) => {
      if (!request.fileId.startsWith(`${FileSection.Committed}:`)) {
        return;
      }
      // The chip resolved path/previousPath when it rendered. Trust that
      // immutable target so a background branch-view refresh cannot turn a
      // valid click into a silent no-op.
      selectFileTarget(request.fileId, request.line);
    },
    [selectFileTarget]
  );

  const branchContextValue: BranchViewContextValue | null = useMemo(() => {
    if (!data) {
      return null;
    }
    return {
      data,
      comments: data.comments,
      committedFiles: data.committedFiles,
      headSha: data.branch?.headSha ?? data.headSha,
      fileCacheHeadSha: data.branch?.fileCacheHeadSha ?? null,
      externalLinkId,
      prNumber: data.prNumber,
      selectedCommentId,
      onSelectComment: handleSelectComment,
      onSelectCommentDiffTarget: handleSelectCommentDiffTarget,
      canCreateConversationComment: data.canCreateConversationComment,
      syncControl,
      mutations: branchMutations,
    };
  }, [
    data,
    externalLinkId,
    selectedCommentId,
    handleSelectComment,
    handleSelectCommentDiffTarget,
    syncControl,
    branchMutations,
  ]);

  const handleHeaderTogglePanel = useCallback(() => {
    if (feedSidebarEnabled) {
      setFeedOpen((prev) => {
        const next = !prev;
        if (next) {
          setSelectedFileTarget(null);
        }
        return next;
      });
      return;
    }
    setShowChatPanel((prev) => !prev);
  }, [feedSidebarEnabled, setFeedOpen, setShowChatPanel]);

  const gate = renderBranchViewGate({
    branchPrEnabled,
    branchPrLoading,
    data: availableData,
    error,
    isFetching,
    isLoading,
    orgSlug,
    refetch: () => {
      refetch();
    },
  });
  if (gate) {
    return gate;
  }
  const branchData = requireLoadedBranchView(availableData);

  const shell = renderBranchViewShell({
    activeFeedTab,
    allFiles,
    branchData,
    chatCommentContext,
    chatFlagEnabled,
    commitMutation,
    effectiveSelectedFileTarget,
    externalLinkId,
    feedOpen,
    feedSidebarEnabled,
    handleHeaderTogglePanel,
    handleSelectComment,
    handleSelectCommentDiffTarget,
    localGatewayEnabled,
    onClearSelectedComment: () => setSelectedCommentId(null),
    onCloseFeed: () => setFeedOpen(false),
    onCloseFileTarget: () => setSelectedFileTarget(null),
    onSelectActiveFeedTab: setActiveFeedTab,
    organizationId,
    routeableLocalState,
    routingKey,
    selectFileTarget,
    selectedCommentId,
    showChatPanel,
    showDiffView,
    showFilesystemNotice,
    syncControl,
  });

  if (branchContextValue) {
    return (
      <BranchViewCommentIdentityBlockerProvider
        buildId={externalLinkId}
        orgSlug={orgSlug}
      >
        <BranchViewProvider value={branchContextValue}>
          {shell}
        </BranchViewProvider>
      </BranchViewCommentIdentityBlockerProvider>
    );
  }
  return shell;
}

function getBranchHeadSha(data: BranchViewData) {
  return data.branch?.headSha ?? data.headSha;
}

type RenderBranchViewShellInput = {
  activeFeedTab: FeedTab;
  allFiles: ChangedFileEntry[];
  branchData: BranchViewData;
  chatCommentContext: ReturnType<typeof buildPrCommentChatContext> | null;
  chatFlagEnabled: boolean;
  commitMutation: ReturnType<typeof useBranchLocalState>["commitMutation"];
  effectiveSelectedFileTarget: BranchFileSelectionTarget | null;
  externalLinkId: string;
  feedOpen: boolean;
  feedSidebarEnabled: boolean;
  handleHeaderTogglePanel: () => void;
  handleSelectComment: (id: string | null) => void;
  handleSelectCommentDiffTarget: (
    request: CommentDiffNavigationRequest
  ) => void;
  localGatewayEnabled: boolean;
  onClearSelectedComment: () => void;
  onCloseFeed: () => void;
  onCloseFileTarget: () => void;
  onSelectActiveFeedTab: (next: FeedTab) => void;
  organizationId: string;
  routeableLocalState: ReturnType<typeof getRouteableLocalBranchState>;
  routingKey: string;
  selectFileTarget: (fileId: string, line: number | null) => void;
  selectedCommentId: string | null;
  showChatPanel: boolean;
  showDiffView: boolean;
  showFilesystemNotice: boolean;
  syncControl: ReturnType<typeof useBranchViewSyncControl>;
};

/**
 * Renders the header + main shell for `BranchViewContainer`. Extracted to
 * keep the container body within the cognitive-complexity budget;
 * BranchViewProvider wrapping happens at the call site so the same shell
 * is reused whether or not the branch data has loaded.
 */
function renderBranchViewShell(input: Readonly<RenderBranchViewShellInput>) {
  return (
    <div className="flex min-h-full flex-col bg-background">
      <BranchViewHeader
        data={input.branchData}
        onTogglePanel={input.handleHeaderTogglePanel}
        panelLabel={input.feedSidebarEnabled ? "Feed" : "Chat"}
      />
      <main className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-w-0 flex-1 border-border border-r",
            input.showDiffView
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto overflow-x-hidden"
          )}
        >
          {input.effectiveSelectedFileTarget ? (
            <BranchDiffView
              allFiles={input.allFiles}
              branchHeadSha={getBranchHeadSha(input.branchData)}
              canCreateInlineComment={
                input.branchData.canCreateInlineComment === true
              }
              commentPromptEligibility={
                input.branchData.commentPromptEligibility
              }
              comments={input.branchData.comments}
              expectedHeadSha={
                input.branchData.branch?.fileCacheHeadSha ?? null
              }
              externalLinkId={input.externalLinkId}
              localDiffContext={
                input.routeableLocalState.localIdentity
                  ? {
                      ...input.routeableLocalState.localIdentity,
                      routingKey: input.routingKey,
                    }
                  : null
              }
              onClose={input.onCloseFileTarget}
              onSelectFile={(fileId) => input.selectFileTarget(fileId, null)}
              producedByPlanSlug={input.branchData.producedByPlanSlug}
              producedByPlanTitle={input.branchData.producedByPlanTitle}
              selectedFileId={input.effectiveSelectedFileTarget.fileId}
              targetActivationId={
                input.effectiveSelectedFileTarget.activationId
              }
              targetLine={input.effectiveSelectedFileTarget.line}
            />
          ) : (
            <BranchViewContent
              commitError={input.commitMutation.error}
              commitUnavailableReason={
                input.localGatewayEnabled
                  ? null
                  : "Local changes are unavailable"
              }
              data={input.branchData}
              hidePrComments={input.feedSidebarEnabled}
              isCommitPending={input.commitMutation.isPending}
              localError={input.routeableLocalState.localError}
              localFiles={input.routeableLocalState.localFiles}
              onCommitAndPush={() => input.commitMutation.mutate()}
              onSelectComment={input.handleSelectComment}
              onSelectCommentDiffTarget={input.handleSelectCommentDiffTarget}
              onSelectFile={(fileId) => input.selectFileTarget(fileId, null)}
              selectedCommentId={input.selectedCommentId}
              selectedFileId={null}
              syncControl={input.syncControl}
            />
          )}
        </div>
        {renderRightRail({
          activeFeedTab: input.activeFeedTab,
          chatCommentContext: input.chatCommentContext,
          chatFlagEnabled: input.chatFlagEnabled,
          data: input.branchData,
          feedOpen: input.feedOpen,
          feedSidebarEnabled: input.feedSidebarEnabled,
          onClearSelectedComment: input.onClearSelectedComment,
          onCloseFeed: input.onCloseFeed,
          onSelectActiveFeedTab: input.onSelectActiveFeedTab,
          organizationId: input.organizationId,
          showChatPanel: input.showChatPanel,
          showFilesystemNotice: input.showFilesystemNotice,
          worktreePath: input.routeableLocalState.worktreePath,
        })}
      </main>
    </div>
  );
}

type RenderRightRailInput = {
  activeFeedTab: FeedTab;
  chatCommentContext: ReturnType<typeof buildPrCommentChatContext> | null;
  chatFlagEnabled: boolean;
  data: BranchViewData;
  feedOpen: boolean;
  feedSidebarEnabled: boolean;
  onClearSelectedComment: () => void;
  onCloseFeed: () => void;
  onSelectActiveFeedTab: (next: FeedTab) => void;
  organizationId: string;
  showChatPanel: boolean;
  showFilesystemNotice: boolean;
  worktreePath: string | null;
};

/**
 * Render the right-rail surface — either the flag-on FeedSidebar (with
 * BranchChatDrawer mounted in the chat tab slot) or the flag-off
 * BranchChatDrawer. Extracted to keep BranchViewContainer's render
 * body within the cognitive-complexity budget and to flatten the
 * earlier nested ternary.
 */
function renderRightRail(input: Readonly<RenderRightRailInput>) {
  if (input.feedSidebarEnabled) {
    const chatPanel = input.chatFlagEnabled ? (
      <BranchChatDrawer
        contextSelection={input.chatCommentContext}
        data={input.data}
        fillParent
        onClearComment={input.onClearSelectedComment}
        showFilesystemNotice={input.showFilesystemNotice}
        worktreePath={input.worktreePath}
      />
    ) : undefined;
    return (
      <FeedSidebar
        activeTab={input.activeFeedTab}
        artifactType={FeedArtifactType.Branch}
        chatPanel={chatPanel}
        onActiveTabChange={input.onSelectActiveFeedTab}
        onClose={input.onCloseFeed}
        organizationId={input.organizationId}
        sources={BRANCH_FEED_SOURCES}
        visible={input.feedOpen}
      />
    );
  }
  if (input.chatFlagEnabled && input.showChatPanel) {
    return (
      <BranchChatDrawer
        contextSelection={input.chatCommentContext}
        data={input.data}
        onClearComment={input.onClearSelectedComment}
        showFilesystemNotice={input.showFilesystemNotice}
        worktreePath={input.worktreePath}
      />
    );
  }
  return null;
}

function BranchViewUnavailableState({
  loadState,
  onRetry,
  orgSlug,
}: Readonly<{
  loadState: ReturnType<typeof getBranchViewLoadState>;
  onRetry: () => void;
  orgSlug: string;
}>) {
  const copy = getUnavailableCopy(loadState.mode);
  const actions = buildUnavailableActions({
    details: loadState.details,
    onRetry,
    orgSlug,
    showRetry:
      loadState.mode === BranchViewLoadUiMode.TransientLoadError ||
      loadState.mode === BranchViewLoadUiMode.Unknown,
  });

  return (
    <section
      aria-label="Branch view unavailable"
      className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 text-center"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
        <AlertTriangleIcon className="h-5 w-5" />
      </div>
      <div className="space-y-2">
        <h1 className="font-semibold text-foreground text-lg">{copy.title}</h1>
        <p className="text-muted-foreground text-sm leading-6">
          {copy.description}
        </p>
      </div>
      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
    </section>
  );
}

function getUnavailableCopy(
  mode: ReturnType<typeof getBranchViewLoadState>["mode"]
) {
  switch (mode) {
    case BranchViewLoadUiMode.LinkNotFound:
      return {
        title: "Branch view link expired",
        description:
          "This Branch View link no longer resolves to an available branch record.",
      };
    case BranchViewLoadUiMode.PullRequestUnavailable:
      return {
        title: "Pull request unavailable",
        description:
          "The pull request for this branch was deleted, moved, or no longer resolves from stored data.",
      };
    case BranchViewLoadUiMode.Unauthorized:
      return {
        title: "Access required",
        description:
          "You need access to this organization or Branch View before this branch can be shown.",
      };
    case BranchViewLoadUiMode.TransientLoadError:
      return {
        title: "Branch view temporarily unavailable",
        description:
          "The branch could not be loaded right now. Retry the request to check for recovered data.",
      };
    default:
      return {
        title: "Branch view unavailable",
        description:
          "This branch cannot be shown from the current response. Retry or open the related work item if one is available.",
      };
  }
}

function buildUnavailableActions(input: {
  details: ReturnType<typeof getBranchViewLoadState>["details"];
  onRetry: () => void;
  orgSlug: string;
  showRetry: boolean;
}) {
  const actions: ReactNode[] = [];
  if (input.showRetry) {
    actions.push(
      <Button key="retry" onClick={input.onRetry} size="sm" variant="outline">
        <RefreshCwIcon className="h-4 w-4" />
        Retry
      </Button>
    );
  }
  if (input.details.githubPullRequestUrl) {
    actions.push(
      <Button asChild key="github" size="sm" variant="outline">
        <a
          href={input.details.githubPullRequestUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon className="h-4 w-4" />
          Open in GitHub
        </a>
      </Button>
    );
  }
  if (input.details.producedByPlanSlug) {
    actions.push(
      <Button asChild key="plan" size="sm" variant="outline">
        <Link
          href={`/${input.orgSlug}/implementation-plans/${input.details.producedByPlanSlug}`}
        >
          View plan
        </Link>
      </Button>
    );
  }
  if (input.details.featureSlug) {
    actions.push(
      <Button asChild key="feature" size="sm" variant="outline">
        <Link href={`/${input.orgSlug}/features/${input.details.featureSlug}`}>
          View feature
        </Link>
      </Button>
    );
  }
  if (input.details.teamId && input.details.projectId) {
    actions.push(
      <Button asChild key="project" size="sm" variant="outline">
        <Link
          href={`/${input.orgSlug}/teams/${input.details.teamId}/projects/${input.details.projectId}`}
        >
          Back to project
        </Link>
      </Button>
    );
  }
  return actions;
}
