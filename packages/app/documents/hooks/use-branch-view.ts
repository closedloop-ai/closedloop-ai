"use client";

import {
  type BranchViewComment,
  type BranchViewCommentActionResult,
  type BranchViewData,
  type BranchViewFileDiff,
  BranchViewLoadErrorCode,
  type BranchViewLoadErrorDetails,
  BranchViewPrLifecycleRepairStatus,
  BranchViewSyncErrorCode,
  BranchViewSyncPresentationState,
  type BranchViewSyncRequest,
  type BranchViewSyncResponse,
  BranchViewSyncScope,
  BranchViewSyncThrottleReason,
  type CreateBranchViewConversationCommentRequest,
  type CreateBranchViewInlineCommentRequest,
  type ReplyToCommentInput,
  type ResolveBranchViewCommentRequest,
  type UnresolveBranchViewCommentRequest,
  type UpdateBranchViewCommentRequest,
} from "@repo/api/src/types/branch-view";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { invalidateArtifactLinkQueries } from "@repo/app/documents/hooks/use-artifact-links";
// Cross-slice: branch-view comments are GitHub PR comments; the identity
// blocker guards comment-author writes from the github slice.
import { branchViewCommentOnError } from "@repo/app/github/lib/branch-view-comment-identity-blocker";
// Cross-slice: a branch belongs to a project tree, so branch mutations
// refresh the projects slice's tree cache.
import { projectTreeKeys } from "@repo/app/projects/hooks/use-project-tree";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

export const branchViewKeys = {
  all: ["branch-view"] as const,
  details: () => [...branchViewKeys.all, "detail"] as const,
  detail: (id: string) => [...branchViewKeys.details(), id] as const,
  fileDiffs: () => [...branchViewKeys.all, "file-diff"] as const,
  fileDiffsForLink: (id: string) =>
    [...branchViewKeys.fileDiffs(), id] as const,
  fileDiff: (id: string, path: string, previousPath?: string) =>
    [...branchViewKeys.fileDiffs(), id, path, previousPath ?? ""] as const,
};

export const BranchViewLoadUiMode = {
  LinkNotFound: "link_not_found",
  PullRequestUnavailable: "pull_request_unavailable",
  TransientLoadError: "transient_load_error",
  Unauthorized: "unauthorized",
  Unknown: "unknown",
} as const;
export type BranchViewLoadUiMode =
  (typeof BranchViewLoadUiMode)[keyof typeof BranchViewLoadUiMode];

export type BranchViewLoadState = {
  mode: BranchViewLoadUiMode;
  details: BranchViewLoadErrorDetails;
  message: string;
};

const GITHUB_PR_URL_PATTERN =
  /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/[1-9]\d*$/;
const UNSAFE_ROUTE_SEGMENT_PATTERN = /[/?#]/;

const safeRouteSegmentSchema = z
  .string()
  .min(1)
  .refine((value) => !UNSAFE_ROUTE_SEGMENT_PATTERN.test(value));

const githubPullRequestUrlSchema = z.string().regex(GITHUB_PR_URL_PATTERN);

const branchViewLoadErrorDetailsSchema = z.object({
  githubPullRequestUrl: z.unknown().optional(),
  featureSlug: z.unknown().optional(),
  featureTitle: z.unknown().optional(),
  producedByPlanSlug: z.unknown().optional(),
  producedByPlanTitle: z.unknown().optional(),
  projectId: z.unknown().optional(),
  projectName: z.unknown().optional(),
  teamId: z.unknown().optional(),
  teamName: z.unknown().optional(),
});
const nonEmptyStringSchema = z.string().min(1);
/** Classify Branch View load failures into app-owned UI states. */
export function getBranchViewLoadState(error: unknown): BranchViewLoadState {
  if (!(error instanceof ApiError)) {
    return {
      mode: BranchViewLoadUiMode.Unknown,
      details: {},
      message: "Branch view is unavailable",
    };
  }

  if (error.status === 401 || error.status === 403) {
    return {
      mode: BranchViewLoadUiMode.Unauthorized,
      details: parseBranchViewLoadDetails(error.details),
      message: error.message,
    };
  }

  return {
    mode: getBranchViewLoadUiMode(error),
    details: parseBranchViewLoadDetails(error.details),
    message: error.message,
  };
}

export function useBranchView(externalLinkId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: branchViewKeys.detail(externalLinkId),
    queryFn: () =>
      apiClient.get<BranchViewData>(`/branch-view/${externalLinkId}`),
    enabled: !!externalLinkId,
    refetchInterval: (query) => {
      if (query.state.status === "error") {
        return false;
      }
      const data = query.state.data;
      return data?.prLifecycleRepair?.status ===
        BranchViewPrLifecycleRepairStatus.Pending ||
        isProjectedBranchSyncRefreshing(data?.syncState)
        ? 3000
        : false;
    },
  });
}

/**
 * Delete a branch/PR artifact. Removes the platform record only — it does not
 * delete the git branch or close the GitHub PR. Invalidates the project tree
 * (the source of branch rows in the project + My Tasks views), the documents
 * list, any cached branch-view detail, and the resolved artifact-link queries
 * that reference the deleted branch — the DB cascade removes its
 * `ArtifactLink` rows, so relationship sections must not keep rendering links
 * to the dead `/build/${id}` route until their stale window expires.
 */
export function useDeleteBranch() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/branches/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      queryClient.invalidateQueries({ queryKey: branchViewKeys.all });
      invalidateArtifactLinkQueries(queryClient, id);
    },
  });
}

export function useBranchViewFileDiff(
  externalLinkId: string,
  path: string | null,
  previousPath?: string
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: branchViewKeys.fileDiff(externalLinkId, path ?? "", previousPath),
    queryFn: () => {
      const params = new URLSearchParams({ path: path! });
      if (previousPath) {
        params.set("previousPath", previousPath);
      }
      return apiClient.get<BranchViewFileDiff>(
        `/branch-view/${externalLinkId}/files/diff?${params.toString()}`
      );
    },
    enabled: !!externalLinkId && !!path,
  });
}

export function useSyncBranchView(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      input: BranchViewSyncRequest = {
        scope: BranchViewSyncScope.Branch,
      }
    ) =>
      apiClient.post<BranchViewSyncResponse>(
        `/branch-view/${externalLinkId}/sync`,
        input
      ),
    onSuccess: (response, variables) => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
      const scope =
        response.scope ?? variables.scope ?? BranchViewSyncScope.Branch;
      if (scope === BranchViewSyncScope.Branch) {
        // The per-file diff is cached under its own key; without this the changed
        // files list refreshes but the rendered diff content stays stale after a
        // resync moves the branch head.
        queryClient.invalidateQueries({
          queryKey: branchViewKeys.fileDiffsForLink(externalLinkId),
        });
      }
    },
  });
}

export type BranchViewSyncControl = {
  isBranchSyncPending: boolean;
  isCommentsSyncPending: boolean;
  refreshBranch: () => void;
  refreshComments: () => void;
  syncRetryState: BranchViewSyncRetryState | null;
};

export type BranchViewSyncRetryState = {
  retryAfterSeconds: number;
  throttleReason: BranchViewSyncThrottleReason | null;
};

export function useBranchViewSyncControl(input: {
  backgroundEnabled: boolean;
  data: BranchViewData | undefined;
  externalLinkId: string;
}): BranchViewSyncControl {
  const branchSyncMutation = useSyncBranchView(input.externalLinkId);
  const commentsSyncMutation = useSyncBranchView(input.externalLinkId);
  const {
    isPending: branchSyncIsPending,
    mutate: branchSyncMutate,
    mutateAsync: branchSyncMutateAsync,
  } = branchSyncMutation;
  const {
    isPending: commentsSyncIsPending,
    mutate: commentsSyncMutate,
    mutateAsync: commentsSyncMutateAsync,
  } = commentsSyncMutation;
  const [branchRetryUntilMs, setBranchRetryUntilMs] = useState<number | null>(
    null
  );
  const [branchRetryReason, setBranchRetryReason] =
    useState<BranchViewSyncThrottleReason | null>(null);
  const [branchRetrySeconds, setBranchRetrySeconds] = useState<number | null>(
    null
  );
  const lastBackgroundRefreshAt = useRef<string | null>(null);

  const handleBranchSyncError = useCallback((error: unknown) => {
    const retryState = getBranchSyncRetryState(error);
    if (!retryState) {
      setBranchRetryUntilMs(null);
      setBranchRetryReason(null);
      return false;
    }
    setBranchRetryReason(retryState.throttleReason);
    setBranchRetryUntilMs(Date.now() + retryState.retryAfterSeconds * 1000);
    return true;
  }, []);

  const shouldRefreshComments =
    Boolean(input.data?.currentPullRequest) ||
    (input.data?.comments.length ?? 0) > 0;

  const refreshBranch = useCallback(() => {
    if (
      branchSyncIsPending ||
      commentsSyncIsPending ||
      isProjectedBranchSyncRefreshing(input.data?.syncState)
    ) {
      return;
    }
    setBranchRetryUntilMs(null);
    setBranchRetryReason(null);
    const runCompositeRefresh = async () => {
      try {
        await branchSyncMutateAsync({ scope: BranchViewSyncScope.Branch });
      } catch (error) {
        if (handleBranchSyncError(error)) {
          return;
        }
      }

      if (!shouldRefreshComments) {
        return;
      }

      try {
        await commentsSyncMutateAsync({ scope: BranchViewSyncScope.Comments });
      } catch (error) {
        handleBranchSyncError(error);
        // The shared mutation error handler owns user-facing errors; suppress
        // the rejected promise from the fire-and-forget composite refresh.
      }
    };
    runCompositeRefresh().catch(() => undefined);
  }, [
    branchSyncIsPending,
    branchSyncMutateAsync,
    commentsSyncIsPending,
    commentsSyncMutateAsync,
    handleBranchSyncError,
    input.data?.syncState,
    shouldRefreshComments,
  ]);

  const refreshComments = useCallback(() => {
    if (branchSyncIsPending || commentsSyncIsPending) {
      return;
    }
    commentsSyncMutate(
      { scope: BranchViewSyncScope.Comments },
      { onError: handleBranchSyncError }
    );
  }, [
    branchSyncIsPending,
    commentsSyncIsPending,
    commentsSyncMutate,
    handleBranchSyncError,
  ]);

  useEffect(() => {
    if (!branchRetryUntilMs) {
      setBranchRetrySeconds(null);
      setBranchRetryReason(null);
      return;
    }

    const updateRemaining = () => {
      const remainingSeconds = Math.max(
        0,
        Math.ceil((branchRetryUntilMs - Date.now()) / 1000)
      );
      setBranchRetrySeconds(remainingSeconds || null);
      if (remainingSeconds === 0) {
        setBranchRetryUntilMs(null);
      }
    };

    updateRemaining();
    const timer = globalThis.setInterval(updateRemaining, 1000);
    return () => globalThis.clearInterval(timer);
  }, [branchRetryUntilMs]);

  useEffect(() => {
    const dueAt = input.data?.syncState?.backgroundRefreshAfterAt ?? null;
    const shouldSchedule =
      input.backgroundEnabled &&
      dueAt &&
      input.externalLinkId &&
      !branchSyncIsPending &&
      !commentsSyncIsPending &&
      !input.data?.syncState?.inProgress &&
      input.data?.syncState?.presentation !==
        BranchViewSyncPresentationState.Refreshing;
    if (!shouldSchedule) {
      return;
    }
    if (lastBackgroundRefreshAt.current === dueAt) {
      return;
    }
    if (globalThis.document?.visibilityState === "hidden") {
      return;
    }

    const delayMs = Math.max(0, new Date(dueAt).getTime() - Date.now());
    let fired = false;
    const timer = globalThis.setTimeout(() => {
      if (
        globalThis.document?.visibilityState === "hidden" ||
        branchSyncIsPending ||
        commentsSyncIsPending
      ) {
        return;
      }
      fired = true;
      lastBackgroundRefreshAt.current = dueAt;
      branchSyncMutate(
        { scope: BranchViewSyncScope.Branch },
        { onError: handleBranchSyncError }
      );
    }, delayMs);

    return () => {
      globalThis.clearTimeout(timer);
      if (!fired && lastBackgroundRefreshAt.current === dueAt) {
        lastBackgroundRefreshAt.current = null;
      }
    };
  }, [
    branchSyncIsPending,
    branchSyncMutate,
    commentsSyncIsPending,
    handleBranchSyncError,
    input.backgroundEnabled,
    input.data?.syncState?.backgroundRefreshAfterAt,
    input.data?.syncState?.inProgress,
    input.data?.syncState?.presentation,
    input.externalLinkId,
  ]);

  const syncRetryState = branchRetrySeconds
    ? {
        retryAfterSeconds: branchRetrySeconds,
        throttleReason: branchRetryReason,
      }
    : null;

  return {
    isBranchSyncPending: branchSyncIsPending,
    isCommentsSyncPending: commentsSyncIsPending,
    refreshBranch,
    refreshComments,
    syncRetryState,
  };
}

export function getBranchSyncRetryState(
  error: unknown
): BranchViewSyncRetryState | null {
  if (
    !(error instanceof ApiError) ||
    error.code !== BranchViewSyncErrorCode.SyncThrottled
  ) {
    return null;
  }
  const retryAfterSeconds = error.details?.retryAfterSeconds;
  if (
    !(
      typeof retryAfterSeconds === "number" &&
      retryAfterSeconds > 0 &&
      Number.isFinite(retryAfterSeconds)
    )
  ) {
    return null;
  }
  return {
    retryAfterSeconds: Math.ceil(retryAfterSeconds),
    throttleReason: parseBranchSyncThrottleReason(
      error.details?.throttleReason
    ),
  };
}

function parseBranchSyncThrottleReason(
  value: unknown
): BranchViewSyncThrottleReason | null {
  switch (value) {
    case BranchViewSyncThrottleReason.LocalDedupe:
    case BranchViewSyncThrottleReason.InFlight:
    case BranchViewSyncThrottleReason.ProviderRateLimit:
      return value;
    default:
      return null;
  }
}

function getBranchViewLoadUiMode(error: ApiError): BranchViewLoadUiMode {
  switch (error.code) {
    case BranchViewLoadErrorCode.LinkNotFound:
      return BranchViewLoadUiMode.LinkNotFound;
    case BranchViewLoadErrorCode.PullRequestUnavailable:
      return BranchViewLoadUiMode.PullRequestUnavailable;
    case BranchViewLoadErrorCode.TransientLoadError:
      return BranchViewLoadUiMode.TransientLoadError;
    default:
      return error.status >= 500
        ? BranchViewLoadUiMode.TransientLoadError
        : BranchViewLoadUiMode.Unknown;
  }
}

function parseBranchViewLoadDetails(
  details: ApiError["details"]
): BranchViewLoadErrorDetails {
  const parsed = branchViewLoadErrorDetailsSchema.safeParse(details);
  if (!parsed.success) {
    return {};
  }
  return {
    ...parseOptionalDetail(
      "githubPullRequestUrl",
      githubPullRequestUrlSchema,
      parsed.data.githubPullRequestUrl
    ),
    ...parseOptionalDetail(
      "featureSlug",
      safeRouteSegmentSchema,
      parsed.data.featureSlug
    ),
    ...parseOptionalDetail(
      "featureTitle",
      nonEmptyStringSchema,
      parsed.data.featureTitle
    ),
    ...parseOptionalDetail(
      "producedByPlanSlug",
      safeRouteSegmentSchema,
      parsed.data.producedByPlanSlug
    ),
    ...parseOptionalDetail(
      "producedByPlanTitle",
      nonEmptyStringSchema,
      parsed.data.producedByPlanTitle
    ),
    ...parseOptionalDetail(
      "projectId",
      safeRouteSegmentSchema,
      parsed.data.projectId
    ),
    ...parseOptionalDetail(
      "projectName",
      nonEmptyStringSchema,
      parsed.data.projectName
    ),
    ...parseOptionalDetail(
      "teamId",
      safeRouteSegmentSchema,
      parsed.data.teamId
    ),
    ...parseOptionalDetail(
      "teamName",
      nonEmptyStringSchema,
      parsed.data.teamName
    ),
  };
}

function parseOptionalDetail<K extends keyof BranchViewLoadErrorDetails>(
  key: K,
  schema: z.ZodType<BranchViewLoadErrorDetails[K]>,
  value: unknown
): Partial<BranchViewLoadErrorDetails> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { [key]: parsed.data } : {};
}

function isProjectedBranchSyncRefreshing(
  syncState: BranchViewData["syncState"] | undefined
): boolean {
  return Boolean(
    syncState?.inProgress ||
      syncState?.presentation === BranchViewSyncPresentationState.Refreshing
  );
}

export function useReplyToComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (input: ReplyToCommentInput) =>
      apiClient.post<BranchViewComment>(
        `/branch-view/${externalLinkId}/comments/reply`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

export function useCreateBranchViewConversationComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (input: CreateBranchViewConversationCommentRequest) =>
      apiClient.post<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/conversation`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

/**
 * Posts CreateBranchViewInlineCommentRequest to the Branch View inline-comment
 * route and refreshes the branch-view detail cache after every accepted result.
 */
export function useCreateBranchViewInlineComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (input: CreateBranchViewInlineCommentRequest) =>
      apiClient.post<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/inline`,
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

export function useEditBranchViewConversationComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (
      input: UpdateBranchViewCommentRequest & { githubCommentId: string }
    ) =>
      apiClient.patch<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/${input.githubCommentId}`,
        { body: input.body }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

export function useDeleteBranchViewConversationComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (githubCommentId: string) =>
      apiClient.delete<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/${githubCommentId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

/**
 * Patches the Branch View review-comment route with the shared update body
 * while preserving Branch View as the cache owner for follow-up reads.
 */
export function useEditBranchViewReviewComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (
      input: UpdateBranchViewCommentRequest & { commentId: string }
    ) =>
      apiClient.patch<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/review/${input.commentId}`,
        { body: input.body }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

/**
 * Deletes through the Branch View review-comment route without a request body
 * and invalidates the owning Branch View detail cache.
 */
export function useDeleteBranchViewReviewComment(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (commentId: string) =>
      apiClient.delete<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/review/${commentId}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

/**
 * Resolves an inline review thread with an empty body and lets the branch-view
 * detail query refetch the provider-aligned projection.
 */
export function useResolveBranchViewReviewThread(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (commentId: string) =>
      apiClient.post<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/review/${commentId}/resolve`,
        {} satisfies ResolveBranchViewCommentRequest
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}

/**
 * Reopens an inline review thread with an empty body and lets the branch-view
 * detail query refetch the provider-aligned projection.
 */
export function useUnresolveBranchViewReviewThread(externalLinkId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    onError: branchViewCommentOnError,
    mutationFn: (commentId: string) =>
      apiClient.post<BranchViewCommentActionResult>(
        `/branch-view/${externalLinkId}/comments/review/${commentId}/unresolve`,
        {} satisfies UnresolveBranchViewCommentRequest
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: branchViewKeys.detail(externalLinkId),
      });
    },
  });
}
