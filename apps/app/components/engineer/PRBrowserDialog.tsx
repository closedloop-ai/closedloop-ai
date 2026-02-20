"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { cn } from "@repo/design-system/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  ScanEye,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CodexReviewSettingsDialog,
  type ReviewConfig,
} from "@/components/engineer/CodexReviewSettingsDialog";
import {
  CommentChat,
  CommentEmptyState,
} from "@/components/engineer/CommentChat";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import { PathAutocomplete } from "@/components/engineer/PathAutocomplete";
import type { PRComment } from "@/components/engineer/PRCommentCard";
import { PRCommentsViewer } from "@/components/engineer/PRCommentsViewer";
import {
  ReviewChatPane,
  resolveFullPath,
  splitReviewOutput,
  stripWorktreePath,
} from "@/components/engineer/ReviewChatPane";
import { useGitHubUser } from "@/hooks/engineer/use-github-user";
import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";
import {
  markChatStarted,
  resetCommentStatus,
} from "@/lib/engineer/pr-comment-tracker";
import { type PRListItem, prListOptions } from "@/lib/engineer/queries/git";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { addRepo, reposOptions } from "@/lib/engineer/queries/repos";
import type { ConfiguredRepo } from "@/types/repos";

const SELECTION_STORAGE_KEY = "pr-browser-selection";

type SavedPRBrowserSelection = {
  repoPath: string;
  prState: "open" | "merged";
  prNumber: number; // 0 = no PR was selected
};

type CommentChatEntry = {
  comment: PRComment;
  replies: PRComment[];
  autoStart: boolean;
  provider: "claude" | "codex";
};

const MAX_CONCURRENT_COMMENT_CHATS = 5;

type ReviewEntry = {
  config: ReviewConfig;
  initialOutput?: string;
  done: boolean;
  findingCount: number;
  isSubmitting: boolean;
  isCommented: boolean;
  structuredFindings?: ReviewFinding[];
  duplicateIndices?: Set<number>;
  prCommentDupIndices?: Set<number>;
};

/** State updater: add a review entry for a provider if not already present. */
function addReviewEntry(
  prev: Record<string, ReviewEntry>,
  provider: "claude" | "codex",
  data: {
    config?: Partial<ReviewConfig>;
    provider?: string;
    log?: string;
    status?: string;
  },
  doneOverride?: boolean
): Record<string, ReviewEntry> {
  if (prev[provider]) {
    return prev;
  }
  return {
    ...prev,
    [provider]: {
      config: {
        instructions: data.config?.instructions ?? "",
        model: data.config?.model ?? "claude-opus-4-6",
        reasoningEffort: data.config?.reasoningEffort ?? "medium",
        reviewMode: data.config?.reviewMode ?? "base",
        provider: (data.provider as "claude" | "codex") ?? provider,
      },
      initialOutput: data.log || undefined,
      done: doneOverride ?? (data.status === "completed" && !!data.log),
      findingCount: 0,
      isSubmitting: false,
      isCommented: false,
    },
  };
}

/** State updater: mark a review as done with output and finding count. */
function markReviewDone(
  prev: Record<string, ReviewEntry>,
  provider: string,
  output: string,
  findingCount: number
): Record<string, ReviewEntry> {
  const entry = prev[provider];
  if (!entry) {
    return prev;
  }
  // Already marked done with same values — return same reference to avoid re-render
  if (
    entry.done &&
    entry.initialOutput === output &&
    entry.findingCount === findingCount
  ) {
    return prev;
  }
  return {
    ...prev,
    [provider]: { ...entry, initialOutput: output, done: true, findingCount },
  };
}

/** State updater: apply duplicate indices to both providers after dedup. */
function applyDedupIndices(
  prev: Record<string, ReviewEntry>,
  providerA: string,
  dupsA: Set<number>,
  providerB: string,
  dupsB: Set<number>
): Record<string, ReviewEntry> {
  const entryA = prev[providerA];
  const entryB = prev[providerB];
  if (!(entryA && entryB)) {
    return prev;
  }
  return {
    ...prev,
    [providerA]: { ...entryA, duplicateIndices: dupsA },
    [providerB]: { ...entryB, duplicateIndices: dupsB },
  };
}

type PRBrowserDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PRBrowserDialog({
  open,
  onOpenChange,
}: Readonly<PRBrowserDialogProps>) {
  const [selectedRepo, setSelectedRepo] = useState<ConfiguredRepo | null>(null);
  const [selectedPR, setSelectedPR] = useState<PRListItem | null>(null);
  const [prState, setPrState] = useState<"open" | "merged">("open");
  const [commentChats, setCommentChats] = useState<
    Record<string, CommentChatEntry>
  >({});
  const [activeCommentChatKey, setActiveCommentChatKey] = useState<
    string | null
  >(null);
  // Track which comment IDs have an actively streaming assistant response
  const [streamingCommentIds, setStreamingCommentIds] = useState<Set<string>>(
    () => new Set()
  );
  // Ephemeral preview: shown when clicking a comment card body (no persistent card)
  const [previewComment, setPreviewComment] = useState<{
    comment: PRComment;
    replies: PRComment[];
    provider: "claude" | "codex";
  } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [commentStatusKey, setCommentStatusKey] = useState(0);
  const [showReviewSettings, setShowReviewSettings] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState("~/");
  const queryClient = useQueryClient();
  const addRepoMutation = useMutation({
    mutationFn: addRepo,
    onSuccess: () => {
      setShowAddRepo(false);
      setNewRepoPath("~/");
      queryClient.invalidateQueries({ queryKey: queryKeys.repos() });
      toast.success("Repository added");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to add repo");
    },
  });
  const [reviews, setReviews] = useState<Record<string, ReviewEntry>>({});
  const patchReview = useCallback(
    (provider: string, patch: Partial<ReviewEntry>) =>
      setReviews((prev) => {
        const entry = prev[provider];
        if (!entry) {
          return prev;
        }
        return { ...prev, [provider]: { ...entry, ...patch } };
      }),
    []
  );
  const [activeReviewProvider, setActiveReviewProvider] = useState<
    string | null
  >(null);
  const [commitSha, setCommitSha] = useState<string | undefined>();
  const [prFiles, setPrFiles] = useState<string[]>([]);
  const [leftPaneFraction, setLeftPaneFraction] = useState(() => {
    if (globalThis.localStorage === undefined) {
      return 0.45;
    }
    const stored = localStorage.getItem("pr-browser-split");
    const parsed = stored ? Number(stored) : Number.NaN;
    return parsed >= 0.3 && parsed <= 0.7 ? parsed : 0.45;
  });

  const { login: githubUser } = useGitHubUser();
  const isOwnPR = selectedPR ? selectedPR.author === githubUser : false;

  const restoredRepoRef = useRef(false);
  const restoredPRRef = useRef(false);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startX: number; startFraction: number } | null>(
    null
  );

  // Fetch repos
  const { data: reposData, isLoading: isLoadingRepos } = useQuery({
    ...reposOptions(),
    enabled: open,
  });

  // Fetch PRs for selected repo
  const { data: prData, isLoading: isLoadingPRs } = useQuery({
    ...prListOptions(selectedRepo?.path || "", prState),
    enabled: open && !!selectedRepo,
  });

  const repos = useMemo(() => reposData?.repos || [], [reposData]);
  const prs = useMemo(() => prData?.prs || [], [prData]);
  const defaultRepoPath = reposData?.settings?.worktreeParentDir ?? "~/";
  const openAddRepoDialog = useCallback(() => {
    const base = defaultRepoPath.endsWith("/")
      ? defaultRepoPath
      : `${defaultRepoPath}/`;
    setNewRepoPath(base);
    setShowAddRepo(true);
  }, [defaultRepoPath]);

  // Reset restoration flags when dialog opens
  useEffect(() => {
    if (open) {
      restoredRepoRef.current = false;
      restoredPRRef.current = false;
    }
  }, [open]);

  // Restore repo + prState from localStorage
  useEffect(() => {
    if (!open || restoredRepoRef.current || repos.length === 0) {
      return;
    }
    restoredRepoRef.current = true;

    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const saved: SavedPRBrowserSelection = JSON.parse(raw);
      const matched = repos.find((r) => r.path === saved.repoPath);
      if (matched) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage
        setSelectedRepo(matched);
        setPrState(saved.prState);
      }
    } catch {
      // Corrupt data — ignore
    }
  }, [open, repos]);

  // Restore selected PR from localStorage
  useEffect(() => {
    if (!open || restoredPRRef.current || !selectedRepo || prs.length === 0) {
      return;
    }
    restoredPRRef.current = true;

    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const saved: SavedPRBrowserSelection = JSON.parse(raw);
      if (
        saved.repoPath !== selectedRepo.path ||
        saved.prState !== prState ||
        saved.prNumber === 0
      ) {
        return;
      }
      const matched = prs.find((p) => p.number === saved.prNumber);
      if (matched) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage
        setSelectedPR(matched);
      }
    } catch {
      // Corrupt data — ignore
    }
  }, [open, selectedRepo, prs, prState]);

  /**
   * Reset chatStarted for pending comments whose chats are being removed,
   * so the PR comment card re-shows "Fix with Claude/Codex" options.
   */
  const resetPendingChats = useCallback(
    (chats: Record<string, CommentChatEntry>) => {
      if (!selectedPR) {
        return;
      }
      const seen = new Set<string>();
      for (const entry of Object.values(chats)) {
        const cid = entry.comment.id;
        if (seen.has(cid)) {
          continue;
        }
        seen.add(cid);
        resetCommentStatus(selectedPR.number, cid);
      }
      setCommentStatusKey((k) => k + 1);
    },
    [selectedPR]
  );

  // Handlers
  const handleSelectRepo = (repo: ConfiguredRepo) => {
    restoredPRRef.current = true;
    resetPendingChats(commentChats);
    setSelectedRepo(repo);
    setSelectedPR(null);
    setCommentChats({});
    setActiveCommentChatKey(null);
    setPreviewComment(null);
    setPrState("open");
  };

  const handleSelectPR = (pr: PRListItem) => {
    resetPendingChats(commentChats);
    setSelectedPR(pr);
    setCommentChats({});
    setActiveCommentChatKey(null);
    setPreviewComment(null);
    setReviews({});
    setCommitSha(undefined);
    setPrFiles([]);
  };

  // Fetch head commit SHA and changed file list whenever the selected PR changes
  useEffect(() => {
    if (!(selectedRepo && selectedPR)) {
      setCommitSha(undefined);
      setPrFiles([]);
      return;
    }
    const encodedRepo = encodeURIComponent(selectedRepo.path);
    fetch(
      `/api/engineer/git/pr/head-sha?repo=${encodedRepo}&pr=${selectedPR.number}`
    )
      .then((res) => res.json())
      .then((data) => {
        if (data.sha) {
          setCommitSha(data.sha);
        }
      })
      .catch(() => {});
    fetchPRFiles(selectedRepo.path, selectedPR.number).then(setPrFiles);
  }, [selectedRepo, selectedPR]);

  const handleCommentSelected = useCallback(
    (
      comment: PRComment,
      replies: PRComment[],
      autoStart: boolean,
      provider: "claude" | "codex" = "claude"
    ) => {
      const key: string = `${comment.id}:${provider}`;

      if (autoStart) {
        // autoStart: create persistent chat entry
        setPreviewComment(null);

        // Clear stale history from disk and query cache so the auto-start
        // effect fires fresh instead of seeing old messages.
        if (selectedPR && selectedRepo) {
          const tid = `pr-${selectedPR.number}`;
          queryClient.removeQueries({
            queryKey: queryKeys.commentChatHistory(
              tid,
              comment.id,
              selectedRepo.path
            ),
          });
          fetch(
            `/api/engineer/symphony/comment-chat/${encodeURIComponent(comment.id)}?ticketId=${encodeURIComponent(tid)}&repo=${encodeURIComponent(selectedRepo.path)}`,
            { method: "DELETE" }
          ).catch(() => {});
        }

        setCommentChats((prev) => {
          // Dedup: already exists, just switch to it
          if (prev[key]) {
            return prev;
          }

          const next = { ...prev };

          // Evict oldest non-active slot if at capacity
          if (Object.keys(next).length >= MAX_CONCURRENT_COMMENT_CHATS) {
            const evictKey = findEvictableKey(next, activeCommentChatKey);
            if (evictKey) {
              delete next[evictKey];
            }
          }

          next[key] = { comment, replies, autoStart, provider };
          return next;
        });

        setActiveCommentChatKey(key);
        setActiveReviewProvider(null);
      } else {
        // Ephemeral preview — no persistent card in left pane.
        // If there's already a persistent chat for this comment+provider, switch to it instead.
        setCommentChats((prev) => {
          if (prev[key]) {
            setActiveCommentChatKey(key);
            setActiveReviewProvider(null);
            setPreviewComment(null);
          } else {
            setPreviewComment({ comment, replies, provider });
            setActiveCommentChatKey(null);
            setActiveReviewProvider(null);
          }
          return prev;
        });
      }
    },
    [activeCommentChatKey, selectedPR, selectedRepo, queryClient]
  );

  const handleCommentDismissed = useCallback((commentId: string) => {
    setCommentChats((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (k.startsWith(`${commentId}:`)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // Auto-heal effect handles updating activeCommentChatKey
  }, []);

  const handleCommentChatResolved = useCallback(
    (key: string, _commentId: string) => {
      setCommentChats((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // Clear immediately so the right pane doesn't go blank while the
      // auto-heal effect waits for the next render cycle.
      setActiveCommentChatKey(null);
      // Don't reset comment status here — the hook already wrote the final
      // status (addressed/responded) before calling onResolved. Resetting
      // would undo that and make the card flash back to "pending".
      setCommentStatusKey((k) => k + 1);
    },
    []
  );

  const handlePreviewResolved = useCallback(() => {
    setPreviewComment(null);
    setCommentStatusKey((k) => k + 1);
  }, []);

  const handleStreamingChange = useCallback(
    (commentId: string, isStreaming: boolean) => {
      setStreamingCommentIds((prev) => {
        const has = prev.has(commentId);
        if (isStreaming && !has) {
          const next = new Set(prev);
          next.add(commentId);
          return next;
        }
        if (!isStreaming && has) {
          const next = new Set(prev);
          next.delete(commentId);
          return next;
        }
        return prev;
      });
    },
    []
  );

  const handleClose = () => {
    if (selectedRepo) {
      const selection: SavedPRBrowserSelection = {
        repoPath: selectedRepo.path,
        prState,
        prNumber: selectedPR?.number ?? 0,
      };
      localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
    }
    resetPendingChats(commentChats);
    setSelectedRepo(null);
    setSelectedPR(null);
    setCommentChats({});
    setActiveCommentChatKey(null);
    setPreviewComment(null);
    setPrState("open");
    onOpenChange(false);
  };

  // Auto-select an active review when the active one is deleted
  useEffect(() => {
    if (activeReviewProvider && reviews[activeReviewProvider]) {
      return; // still valid
    }
    const providers = Object.keys(reviews);
    if (providers.length > 0) {
      setActiveReviewProvider(providers[0]);
    } else {
      setActiveReviewProvider(null);
    }
  }, [reviews, activeReviewProvider]);

  // Clear active comment chat key when the active entry is removed.
  // Unlike reviews (which have cards in the left pane), comment chats have
  // no left-pane card, so auto-selecting a hidden chat would be confusing.
  useEffect(() => {
    if (activeCommentChatKey && commentChats[activeCommentChatKey]) {
      return;
    }
    setActiveCommentChatKey(null);
  }, [commentChats, activeCommentChatKey]);

  // Auto-restore existing reviews from disk when a PR is selected (both providers)
  useEffect(() => {
    if (!(selectedRepo && selectedPR)) {
      return;
    }
    const ticketId = `pr-${selectedPR.number}`;
    let cancelled = false;

    const restoreProvider = async (provider: "claude" | "codex") => {
      try {
        const res = await fetch(
          `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(selectedRepo.path)}&provider=${provider}`
        );
        const data = await res.json();
        if (cancelled || !data.hasReview) {
          return;
        }
        if (data.status === "completed" || data.status === "running") {
          setReviews((prev) => addReviewEntry(prev, provider, data));
          setActiveReviewProvider((cur) => cur ?? provider);
        }
      } catch {
        // Ignore restore errors
      }
    };

    Promise.all([restoreProvider("claude"), restoreProvider("codex")]);
    return () => {
      cancelled = true;
    };
  }, [selectedRepo, selectedPR]);

  // Drag-to-resize split panes
  const handleSplitDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = splitContainerRef.current;
      if (!container) {
        return;
      }
      splitDragRef.current = {
        startX: e.clientX,
        startFraction: leftPaneFraction,
      };

      const containerWidth = container.getBoundingClientRect().width;

      const onMouseMove = (ev: MouseEvent) => {
        if (!splitDragRef.current) {
          return;
        }
        const delta = ev.clientX - splitDragRef.current.startX;
        const fractionDelta = delta / containerWidth;
        const newFraction = Math.min(
          0.7,
          Math.max(0.3, splitDragRef.current.startFraction + fractionDelta)
        );
        setLeftPaneFraction(newFraction);
      };

      const onMouseUp = () => {
        splitDragRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setLeftPaneFraction((cur) => {
          localStorage.setItem("pr-browser-split", String(cur));
          return cur;
        });
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [leftPaneFraction]
  );

  const reviewEntries = Object.entries(reviews);
  const hasAnyReview = reviewEntries.length > 0;
  const commentChatEntries = Object.entries(commentChats);
  const hasAnyCommentChat = commentChatEntries.length > 0;
  /** Try to restore completed reviews from disk; fall back to showing settings dialog. */
  const restoreOrShowSettings = useCallback(async () => {
    if (!(selectedRepo && selectedPR)) {
      return;
    }
    if (hasAnyReview) {
      setShowReviewSettings(true);
      return;
    }
    const ticketId = `pr-${selectedPR.number}`;
    let restored = false;
    try {
      const results = await Promise.all(
        (["claude", "codex"] as const).map((p) =>
          fetchProviderStatus(selectedRepo.path, ticketId, p)
        )
      );
      for (const { provider, data } of results) {
        if (data?.hasReview && data.status === "completed" && data.log) {
          setReviews((prev) => addReviewEntry(prev, provider, data));
          if (!restored) {
            setActiveReviewProvider(provider);
            setActiveCommentChatKey(null);
            setPreviewComment(null);
            restored = true;
          }
        }
      }
    } catch {
      // Fall through to settings
    }
    if (!restored) {
      setShowReviewSettings(true);
    }
  }, [selectedRepo, selectedPR, hasAnyReview]);

  const triggerDedup = useCallback(
    async (completingProvider: string, completingFindings: ReviewFinding[]) => {
      if (!(selectedRepo && selectedPR)) {
        return;
      }
      const ticketId = `pr-${selectedPR.number}`;
      const otherProvider =
        completingProvider === "claude" ? "codex" : "claude";

      // Fetch the other provider's findings from disk (already persisted)
      try {
        const res = await fetch(
          `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(selectedRepo.path)}&provider=${otherProvider}`
        );
        const data = await res.json();
        const otherFindings: ReviewFinding[] = data.findings ?? [];
        if (otherFindings.length === 0 || completingFindings.length === 0) {
          return;
        }

        const dedupRes = await fetch(
          `/api/engineer/codex/review-dedup/${encodeURIComponent(ticketId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoPath: selectedRepo.path,
              providerA: completingProvider,
              providerB: otherProvider,
              findingsA: completingFindings,
              findingsB: otherFindings,
            }),
          }
        );
        const dedupData = await dedupRes.json();
        const pairs: [number, number][] = dedupData.duplicates ?? [];
        if (pairs.length === 0) {
          return;
        }

        const completingDups = new Set(pairs.map((p) => p[0]));
        const otherDups = new Set(pairs.map((p) => p[1]));

        setReviews((prev) =>
          applyDedupIndices(
            prev,
            completingProvider,
            completingDups,
            otherProvider,
            otherDups
          )
        );
      } catch (err) {
        console.warn("[pr-browser] Dedup failed:", err);
      }
    },
    [selectedRepo, selectedPR]
  );

  const triggerPRCommentDedup = useCallback(
    async (provider: string, findings: ReviewFinding[]) => {
      if (!(selectedRepo && selectedPR) || findings.length === 0) {
        return;
      }
      const ticketId = `pr-${selectedPR.number}`;

      try {
        // Fetch existing PR comments
        const commentsRes = await fetch(
          `/api/engineer/git/pr/comments?repo=${encodeURIComponent(selectedRepo.path)}&pr=${selectedPR.number}`
        );
        const commentsData = await commentsRes.json();
        const allComments: Array<{
          author: string;
          body: string;
          path?: string;
          line?: number;
        }> = commentsData.comments ?? [];

        // Filter out self-authored comments (from "Leave as Comment" or manual)
        const otherComments = githubUser
          ? allComments.filter((c) => c.author !== githubUser)
          : allComments;
        if (otherComments.length === 0) {
          return;
        }

        // Transform PR comments into FindingSummary format
        const prCommentFindings = otherComments.map((c) => ({
          file: c.path,
          line: c.line,
          message: c.body,
          severity: "comment" as const,
        }));

        const dedupRes = await fetch(
          `/api/engineer/codex/review-dedup/${encodeURIComponent(ticketId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoPath: selectedRepo.path,
              providerA: provider,
              providerB: "pr-comments",
              findingsA: findings,
              findingsB: prCommentFindings,
            }),
          }
        );
        const dedupData = await dedupRes.json();
        const pairs: [number, number][] = dedupData.duplicates ?? [];
        if (pairs.length === 0) {
          return;
        }

        const dupIndices = new Set(pairs.map((p) => p[0]));

        patchReview(provider, { prCommentDupIndices: dupIndices });
      } catch (err) {
        console.warn("[pr-browser] PR comment dedup failed:", err);
      }
    },
    [selectedRepo, selectedPR, githubUser, patchReview]
  );

  const handleReviewComplete = useCallback(
    (
      provider: string,
      output: string,
      findingCount: number,
      findings?: ReviewFinding[]
    ) => {
      setReviews((prev) => {
        const updated = markReviewDone(prev, provider, output, findingCount);
        if (findings && findings.length > 0) {
          scheduleCrossProviderDedup(updated, provider, findings, triggerDedup);
        }
        return updated;
      });

      // Trigger PR comment dedup when findings exist
      if (findings && findings.length > 0) {
        setTimeout(() => triggerPRCommentDedup(provider, findings), 0);
      }
    },
    [triggerDedup, triggerPRCommentDedup]
  );

  const handleStructuredFindings = useCallback(
    (provider: string, findings: ReviewFinding[]) => {
      patchReview(provider, { structuredFindings: findings });

      // Re-run both dedup checks with structured findings (better file paths)
      if (findings.length > 0) {
        setTimeout(() => triggerPRCommentDedup(provider, findings), 0);

        setReviews((prev) => {
          scheduleCrossProviderDedup(prev, provider, findings, triggerDedup);
          return prev;
        });
      }
    },
    [triggerDedup, triggerPRCommentDedup, patchReview]
  );

  const handleDeleteReview = useCallback(
    (provider: string) => {
      // Delete review files and chat history from disk
      if (selectedPR && selectedRepo) {
        const ticketId = `pr-${selectedPR.number}`;
        fetch(
          `/api/engineer/codex/stop/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(selectedRepo.path)}&provider=${encodeURIComponent(provider)}`,
          { method: "DELETE" }
        ).catch(() => {});
        fetch(
          `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(selectedRepo.path)}`,
          { method: "DELETE" }
        ).catch(() => {});
      }
      setReviews((prev) => {
        const next = { ...prev };
        delete next[provider];
        return next;
      });
    },
    [selectedPR, selectedRepo]
  );

  const handleSubmitReviewAsComment = useCallback(
    async (provider: string) => {
      const entry = reviews[provider];
      if (!(entry?.initialOutput && selectedRepo && selectedPR)) {
        return;
      }

      patchReview(provider, { isSubmitting: true });

      try {
        const ticketId = `pr-${selectedPR.number}`;

        // Prefer structured findings (full paths from session resumption)
        const allFindings =
          entry.structuredFindings ??
          splitReviewOutput(entry.initialOutput, entry.config.provider)
            .findings;

        // Fetch persisted findings to know which are already commented
        const alreadyCommented = await fetchCommentedIndices(
          ticketId,
          selectedRepo.path,
          entry.config.provider
        );

        // Filter out duplicates AND already-commented findings
        const findings = allFindings.filter(
          (_, i) =>
            !(
              entry.duplicateIndices?.has(i) ||
              entry.prCommentDupIndices?.has(i) ||
              alreadyCommented.has(i)
            )
        );
        if (findings.length === 0) {
          toast.info("All findings already posted");
          patchReview(provider, { isCommented: true });
          return;
        }

        // Structured findings already have full repo-relative paths, skip PR file lookup
        const skipFileResolution = !!entry.structuredFindings;
        const result = await postReviewFindings(
          findings,
          provider,
          selectedRepo.path,
          selectedPR.number,
          commitSha,
          skipFileResolution
        );

        if (result.inlineFailed > 0) {
          toast.warning(
            `Posted review (${result.inlineFailed} inline comment${result.inlineFailed === 1 ? "" : "s"} failed)`
          );
        } else {
          toast.success(result.summary);
        }
        setCommentStatusKey((k) => k + 1);

        // Mark ALL findings as commented in the persisted file
        const findingsWithCommented = allFindings.map((f) => ({
          ...f,
          commented: true,
        }));
        fetch(
          `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(selectedRepo.path)}&provider=${encodeURIComponent(entry.config.provider)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: entry.config.provider,
              model: entry.config.model,
              findings: findingsWithCommented,
            }),
          }
        ).catch((err) =>
          console.warn("[pr-browser] Failed to persist commented status:", err)
        );
        // Invalidate so ReviewChatPane picks up the change
        queryClient.invalidateQueries({
          queryKey: [
            "review-findings",
            ticketId,
            selectedRepo.path,
            entry.config.provider,
          ],
        });
        // Update card UI to show "Commented"
        patchReview(provider, { isCommented: true });
      } catch {
        toast.error("Failed to post review comment");
      } finally {
        patchReview(provider, { isSubmitting: false });
      }
    },
    [reviews, selectedRepo, selectedPR, commitSha, queryClient, patchReview]
  );

  // Repo picker dropdown items
  function renderRepoItems() {
    if (isLoadingRepos) {
      return (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (repos.length === 0) {
      return (
        <>
          <div className="px-3 py-2 text-center text-muted-foreground text-sm">
            No repos configured
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => openAddRepoDialog()}
          >
            <Plus className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm">Add Repository</span>
          </DropdownMenuItem>
        </>
      );
    }
    return (
      <>
        {repos.map((repo) => (
          <DropdownMenuItem
            className="cursor-pointer"
            key={repo.path}
            onClick={() => handleSelectRepo(repo)}
          >
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">{repo.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {repo.path}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => openAddRepoDialog()}
        >
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm">Add Repository</span>
        </DropdownMenuItem>
      </>
    );
  }

  // PR picker dropdown items
  function renderPRItems() {
    if (isLoadingPRs) {
      return (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    if (prs.length === 0) {
      return (
        <div className="px-3 py-4 text-center text-muted-foreground text-sm">
          No {prState} PRs found
        </div>
      );
    }
    const Icon = prState === "merged" ? GitMerge : GitPullRequest;
    const iconClass =
      prState === "merged" ? "text-violet-500" : "text-emerald-500";
    return prs.map((pr) => (
      <DropdownMenuItem
        className="cursor-pointer"
        key={pr.number}
        onClick={() => handleSelectPR(pr)}
      >
        <Icon className={cn("size-4 shrink-0", iconClass)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
              #{pr.number}
            </span>
            <span className="truncate text-sm">{pr.title}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {pr.author}
          </div>
        </div>
      </DropdownMenuItem>
    ));
  }

  // Right pane: one ReviewChatPane per provider (hidden when not active), comment chats, or empty state
  function renderRightPane() {
    if (!(selectedRepo && selectedPR)) {
      return <CommentEmptyState />;
    }

    const showingComment =
      previewComment !== null || activeCommentChatKey !== null;

    return (
      <>
        {/* Review panes — hidden when any comment (preview or persistent) is active */}
        {reviewEntries.map(([provider, entry]) => (
          <div
            className={cn(
              "flex h-full flex-col",
              (showingComment || activeReviewProvider !== provider) && "hidden"
            )}
            key={`review-pane-${provider}`}
          >
            <ReviewChatPane
              branchName={selectedPR.headRefName}
              commitSha={commitSha}
              config={entry.config}
              duplicateIndices={entry.duplicateIndices}
              initialOutput={entry.initialOutput}
              isMerged={prState === "merged"}
              isOwnPR={isOwnPR}
              key={`review-${selectedPR.number}-${provider}-${entry.initialOutput ? "restored" : "live"}`}
              onAllCommented={() =>
                patchReview(provider, { isCommented: true })
              }
              onClose={() => setActiveReviewProvider(null)}
              onNewReview={() => {
                handleDeleteReview(provider);
                setShowReviewSettings(true);
              }}
              onReviewComplete={(output, count, findings) =>
                handleReviewComplete(provider, output, count, findings)
              }
              onStructuredFindings={(findings) =>
                handleStructuredFindings(provider, findings)
              }
              prCommentDupIndices={entry.prCommentDupIndices}
              prFiles={prFiles}
              prNumber={selectedPR.number}
              repoPath={selectedRepo.path}
            />
          </div>
        ))}
        {/* Persistent comment chats — hidden when preview is showing or not the active key */}
        {commentChatEntries.map(([key, entry]) => (
          <div
            className={cn(
              "flex h-full flex-col",
              (previewComment !== null || activeCommentChatKey !== key) &&
                "hidden"
            )}
            key={`comment-chat-${key}`}
          >
            <CommentChat
              autoProvider={entry.provider}
              autoStart={entry.autoStart}
              branchName={selectedPR.headRefName}
              comment={entry.comment}
              commentId={entry.comment.id}
              key={entry.comment.id}
              onChatCleared={() => setCommentStatusKey((k) => k + 1)}
              onDeselect={() => {
                // Remove entry (unmount) — no left-pane card to return to,
                // so keeping it hidden would just orphan a background stream.
                setCommentChats((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                });
                // Reset chatStarted so overflow menu re-shows "Fix with Claude/Codex".
                // Unconditional: resolved comments are already removed from
                // commentChats by onResolved, so this only fires for pending chats.
                if (selectedPR) {
                  resetCommentStatus(selectedPR.number, entry.comment.id);
                }
                setCommentStatusKey((k) => k + 1);
              }}
              onResolved={() =>
                handleCommentChatResolved(key, entry.comment.id)
              }
              onStreamingChange={(streaming) =>
                handleStreamingChange(entry.comment.id, streaming)
              }
              prNumber={selectedPR.number}
              replies={entry.replies}
              repoPath={selectedRepo.path}
              ticketId={`pr-${selectedPR.number}`}
            />
          </div>
        ))}
        {/* Ephemeral preview — replaced on each comment click, no persistent card */}
        {previewComment && (
          <CommentChat
            autoProvider={previewComment.provider}
            autoStart={false}
            branchName={selectedPR.headRefName}
            comment={previewComment.comment}
            commentId={previewComment.comment.id}
            key={`preview-${previewComment.comment.id}`}
            onChatCleared={() => setCommentStatusKey((k) => k + 1)}
            onDeselect={() => {
              setPreviewComment(null);
            }}
            onResolved={handlePreviewResolved}
            prNumber={selectedPR.number}
            replies={previewComment.replies}
            repoPath={selectedRepo.path}
            ticketId={`pr-${selectedPR.number}`}
          />
        )}
        {!(hasAnyReview || hasAnyCommentChat || previewComment) && (
          <CommentEmptyState />
        )}
      </>
    );
  }

  return (
    <>
      <Dialog onOpenChange={handleClose} open={open}>
        <ExpandableDialogContent
          className="flex h-[85vh] max-h-[900px] w-[95vw] flex-col p-0 sm:max-w-5xl"
          isExpanded={isExpanded}
          onToggleExpand={() => setIsExpanded((v) => !v)}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Pull Requests</DialogTitle>
            <DialogDescription>Browse PR comments and chat</DialogDescription>
          </DialogHeader>

          {/* Header bar: repo picker + open/merged toggle + PR picker */}
          <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
            {/* Repo picker */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                    "cursor-pointer border border-border bg-background transition-colors hover:bg-muted",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  )}
                >
                  <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="max-w-[160px] truncate">
                    {selectedRepo?.name || "Select repo..."}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-[300px] w-[260px]"
              >
                {renderRepoItems()}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Open/Merged toggle — only visible when a repo is selected */}
            {selectedRepo && (
              <div className="flex shrink-0 gap-0.5 rounded-md bg-muted p-0.5">
                <button
                  className={cn(
                    "cursor-pointer rounded px-2.5 py-1 font-medium text-xs transition-colors",
                    prState === "open"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => {
                    restoredPRRef.current = true;
                    resetPendingChats(commentChats);
                    setPrState("open");
                    setSelectedPR(null);
                    setCommentChats({});
                    setActiveCommentChatKey(null);
                    setPreviewComment(null);
                  }}
                >
                  Open
                </button>
                <button
                  className={cn(
                    "cursor-pointer rounded px-2.5 py-1 font-medium text-xs transition-colors",
                    prState === "merged"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => {
                    restoredPRRef.current = true;
                    resetPendingChats(commentChats);
                    setPrState("merged");
                    setSelectedPR(null);
                    setCommentChats({});
                    setActiveCommentChatKey(null);
                    setPreviewComment(null);
                  }}
                >
                  Merged
                </button>
              </div>
            )}

            {/* PR picker */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm",
                    "cursor-pointer border border-border bg-background transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                    selectedRepo
                      ? "hover:bg-muted"
                      : "cursor-not-allowed opacity-50"
                  )}
                  disabled={!selectedRepo}
                >
                  <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
                  <span className="max-w-[260px] truncate">
                    {selectedPR
                      ? `#${selectedPR.number} ${selectedPR.title}`
                      : "Select PR..."}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-[400px] w-[380px]"
              >
                {renderPRItems()}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Review button */}
            {selectedPR && selectedRepo && (
              <button
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium text-sm",
                  "cursor-pointer border border-border bg-background transition-colors hover:bg-muted",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                )}
                onClick={restoreOrShowSettings}
              >
                <Search className="size-3.5" />
                Review
              </button>
            )}

            {/* Spacer to avoid overlap with dialog expand/close buttons */}
            <div className="w-16 shrink-0" />
          </div>

          {/* Two-pane body */}
          <div className="flex min-h-0 flex-1" ref={splitContainerRef}>
            {/* Left pane: comments */}
            <div
              className="flex min-h-0 min-w-0 flex-col overflow-y-auto"
              style={{ width: `${leftPaneFraction * 100}%` }}
            >
              {selectedRepo && selectedPR ? (
                <div className="min-h-0 flex-1 p-4">
                  {reviewEntries.map(([provider, entry]) => (
                    <ReviewCard
                      duplicateCount={
                        new Set([
                          ...(entry.duplicateIndices ?? []),
                          ...(entry.prCommentDupIndices ?? []),
                        ]).size
                      }
                      findingCount={entry.findingCount}
                      isCommented={entry.isCommented}
                      isDone={entry.done}
                      isSelected={
                        activeReviewProvider === provider &&
                        activeCommentChatKey === null &&
                        previewComment === null
                      }
                      isSubmitting={entry.isSubmitting}
                      key={`card-${provider}`}
                      onDelete={() => handleDeleteReview(provider)}
                      onSelect={() => {
                        setActiveReviewProvider(provider);
                        setActiveCommentChatKey(null);
                        setPreviewComment(null);
                      }}
                      onSubmitAsComment={() =>
                        handleSubmitReviewAsComment(provider)
                      }
                      provider={provider as "claude" | "codex"}
                    />
                  ))}
                  <PRCommentsViewer
                    activeChatCommentIds={streamingCommentIds}
                    key={selectedPR.number}
                    onCommentDismissed={handleCommentDismissed}
                    onCommentSelected={handleCommentSelected}
                    onReviewCodex={async (commentId) => {
                      markChatStarted(selectedPR.number, commentId);
                      setCommentStatusKey((k) => k + 1);
                      await restoreOrShowSettings();
                    }}
                    prNumber={selectedPR.number}
                    repoPath={selectedRepo.path}
                    statusRefreshKey={commentStatusKey}
                    ticketId={`pr-${selectedPR.number}`}
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                  <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
                    <MessageSquare className="size-5 text-muted-foreground/50" />
                  </div>
                  <p className="font-mono text-muted-foreground text-sm">
                    Select a repo and PR
                  </p>
                  <p className="mt-1 max-w-[220px] text-muted-foreground/70 text-xs">
                    Use the dropdowns above to browse PR comments
                  </p>
                </div>
              )}
            </div>

            {/* Drag handle */}
            <button
              aria-label="Resize panes"
              className="w-1 shrink-0 cursor-col-resize border-y-0 border-r-0 border-l bg-transparent p-0 transition-colors hover:bg-primary/30 focus:outline-none active:bg-primary/50"
              onMouseDown={handleSplitDragStart}
              type="button"
            />

            {/* Right pane: review, chat, or empty state */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {renderRightPane()}
            </div>
          </div>
        </ExpandableDialogContent>
      </Dialog>

      <CodexReviewSettingsDialog
        defaultReviewMode="base"
        onOpenChange={setShowReviewSettings}
        onStartReview={(cfg) => {
          const provider = cfg.provider || "codex";
          setReviews((prev) => ({
            ...prev,
            [provider]: {
              config: cfg,
              done: false,
              findingCount: 0,
              isSubmitting: false,
              isCommented: false,
            },
          }));
          setActiveReviewProvider(provider);
          setActiveCommentChatKey(null);
          setPreviewComment(null);
          setShowReviewSettings(false);
        }}
        open={showReviewSettings}
      />

      {/* Add Repository dialog */}
      <Dialog
        onOpenChange={(v) => {
          setShowAddRepo(v);
          if (!v) {
            setNewRepoPath("~/");
          }
        }}
        open={showAddRepo}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Repository</DialogTitle>
            <DialogDescription>
              Enter the path to a local git repository.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <PathAutocomplete
              autoFocus
              onChange={(value) => setNewRepoPath(value)}
              onSelect={(path) => setNewRepoPath(path)}
              placeholder="~/Source/my-repo"
              value={newRepoPath}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => setShowAddRepo(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                addRepoMutation.isPending || newRepoPath.trim().length < 2
              }
              onClick={() => addRepoMutation.mutate(newRepoPath.trim())}
              type="button"
            >
              {addRepoMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Adding...
                </>
              ) : (
                "Add"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// --- Review card for left pane ---

type ReviewCardProps = {
  provider: "claude" | "codex";
  isDone: boolean;
  findingCount: number;
  duplicateCount: number;
  isSelected: boolean;
  isSubmitting: boolean;
  isCommented: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onSubmitAsComment: () => void;
};

async function fetchPRFiles(
  repoPath: string,
  prNumber: number
): Promise<string[]> {
  try {
    const res = await fetch(
      `/api/engineer/git/pr/files?repo=${encodeURIComponent(repoPath)}&pr=${prNumber}`
    );
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    return data.files ?? [];
  } catch {
    return [];
  }
}

function classifyFindings(
  findings: ReviewFinding[],
  commitSha: string | undefined,
  prFiles: string[],
  skipFileResolution: boolean
): {
  inline: Array<{ finding: ReviewFinding; fullPath: string }>;
  general: ReviewFinding[];
} {
  const inline: Array<{ finding: ReviewFinding; fullPath: string }> = [];
  const general: ReviewFinding[] = [];

  for (const finding of findings) {
    if (!(commitSha && finding.file)) {
      general.push(finding);
      continue;
    }
    const shortPath = stripWorktreePath(finding.file);
    if (skipFileResolution) {
      // Structured findings have full paths — still validate against PR files
      if (prFiles.length > 0 && !resolveFullPath(shortPath, prFiles)) {
        continue; // File not in PR, drop the finding
      }
      inline.push({ finding, fullPath: finding.file });
      continue;
    }
    const fullPath = resolveFullPath(shortPath, prFiles);
    if (fullPath === "ambiguous") {
      // Multiple PR files match — fall back to general comment
      general.push(finding);
    } else if (fullPath) {
      inline.push({ finding, fullPath });
    } else if (prFiles.length === 0) {
      // PR file list unavailable (fetch failed) — fall back to general comment
      general.push(finding);
    }
    // else: file confirmed not in PR, drop the finding
  }

  return { inline, general };
}

async function postReviewFindings(
  findings: ReviewFinding[],
  provider: string,
  repoPath: string,
  prNumber: number,
  commitSha?: string,
  skipFileResolution?: boolean
): Promise<{ inlineFailed: number; summary: string }> {
  const providerLabel = provider === "claude" ? "Claude" : "Codex";

  // Fetch PR file list to resolve short filenames to full paths (skip when structured findings have full paths)
  const prFiles =
    commitSha && !skipFileResolution
      ? await fetchPRFiles(repoPath, prNumber)
      : [];

  const { inline: inlineFindings, general: generalFindings } = classifyFindings(
    findings,
    commitSha,
    prFiles,
    !!skipFileResolution
  );

  // Post inline findings as file-level comments (batched to avoid GitHub rate limits)
  const inlineTasks = inlineFindings.map(({ finding, fullPath }) => () => {
    const body = formatSingleFinding(providerLabel, finding);
    return fetch("/api/engineer/git/pr/inline-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoPath,
        prNumber,
        body,
        path: fullPath,
        line: finding.line,
        commitSha,
      }),
    });
  });
  const inlineResults = await batchedSettled(inlineTasks, 5);

  // Post general findings (if any) as a top-level comment
  if (generalFindings.length > 0) {
    const body = formatReviewComment(providerLabel, generalFindings);
    await fetch("/api/engineer/git/pr/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath, prNumber, body }),
    });
  }

  const inlineFailed = inlineResults.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
  ).length;

  const parts: string[] = [];
  if (inlineFindings.length > 0) {
    parts.push(`${inlineFindings.length} inline`);
  }
  if (generalFindings.length > 0) {
    parts.push(`${generalFindings.length} general`);
  }
  const summary = `Review posted: ${parts.join(", ")} comment${findings.length === 1 ? "" : "s"}`;

  return { inlineFailed, summary };
}

function formatReviewComment(
  providerLabel: string,
  findings: ReviewFinding[]
): string {
  const lines: string[] = [
    `## Code Review (${providerLabel})`,
    "",
    `Found **${findings.length}** issue${findings.length === 1 ? "" : "s"}:`,
    "",
  ];

  for (const finding of findings) {
    const [title, ...descParts] = finding.message.split("\n");
    const description = descParts.join("\n").trim();
    const priorityLabel = finding.priority || "P3";
    const displayPath = finding.file ? stripWorktreePath(finding.file) : null;

    lines.push(`### [${priorityLabel}] ${title}`);
    if (displayPath) {
      const location = finding.line
        ? `${displayPath}:${finding.line}`
        : displayPath;
      lines.push(`\`${location}\``);
    }
    if (description) {
      lines.push("", description);
    }
    if (finding.suggestion) {
      lines.push("", `> **Suggestion:** ${finding.suggestion}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatSingleFinding(
  providerLabel: string,
  finding: ReviewFinding
): string {
  const [title, ...descParts] = finding.message.split("\n");
  const description = descParts.join("\n").trim();
  const priorityLabel = finding.priority || "P3";
  const parts = [`**[${priorityLabel}]** ${title} _(${providerLabel} Review)_`];
  if (description) {
    parts.push("", description);
  }
  if (finding.suggestion) {
    parts.push("", `> **Suggestion:** ${finding.suggestion}`);
  }
  return parts.join("\n");
}

function ReviewCard({
  provider,
  isDone,
  findingCount,
  duplicateCount,
  isCommented,
  isSelected,
  isSubmitting,
  onSelect,
  onDelete,
  onSubmitAsComment,
}: Readonly<ReviewCardProps>) {
  return (
    <div
      className={cn(
        "mb-3 cursor-pointer rounded-lg border p-3 transition-all",
        isDone ? "bg-muted/30" : "review-card-active",
        "hover:bg-muted/60",
        isSelected && "border-primary/30 ring-2 ring-primary/50"
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-center gap-2.5">
        <ScanEye className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium text-sm">Code Review</span>
        <span
          className={cn(
            "inline-flex rounded px-1.5 py-0.5 font-medium font-mono text-[10px]",
            provider === "claude"
              ? "bg-orange-500/10 text-orange-600 dark:text-orange-400"
              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          )}
        >
          {(provider === "claude" ? "Claude" : "Codex")
            .split("")
            .map((ch, i) => (
              <span
                className={isDone ? undefined : "inline-block"}
                key={`${ch}-${i}`}
                style={
                  isDone
                    ? undefined
                    : {
                        animation: `letter-wave 5s ease-in-out ${i * 0.12}s infinite`,
                      }
                }
              >
                {ch}
              </span>
            ))}
        </span>
        <button
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete review"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2 pl-[26px]">
        {isDone ? (
          <>
            <Check className="size-3.5 text-emerald-500" />
            <span className="text-muted-foreground text-xs">
              {findingCount} finding{findingCount === 1 ? "" : "s"}
              {duplicateCount > 0 && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">
                  ({duplicateCount} dup)
                </span>
              )}
            </span>
          </>
        ) : (
          <span className="review-shimmer-text font-medium text-xs">
            Reviewing...
          </span>
        )}
      </div>
      {isDone && findingCount > 0 && (
        <div className="mt-2 pl-[26px]">
          <button
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-[11px] transition-colors",
              postButtonStyle(isCommented, isSubmitting)
            )}
            disabled={isSubmitting || isCommented}
            onClick={(e) => {
              e.stopPropagation();
              if (!isCommented) {
                onSubmitAsComment();
              }
            }}
          >
            <PostButtonContent
              isCommented={isCommented}
              isSubmitting={isSubmitting}
            />
          </button>
        </div>
      )}
    </div>
  );
}

function PostButtonContent({
  isCommented,
  isSubmitting,
}: Readonly<{
  isCommented: boolean;
  isSubmitting: boolean;
}>) {
  if (isCommented) {
    return (
      <>
        <Check className="size-3" />
        Commented
      </>
    );
  }
  if (isSubmitting) {
    return (
      <>
        <Loader2 className="size-3 animate-spin" />
        Posting...
      </>
    );
  }
  return (
    <>
      <MessageSquarePlus className="size-3" />
      Post as Comments
    </>
  );
}

function postButtonStyle(isCommented: boolean, isSubmitting: boolean): string {
  if (isCommented) {
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 cursor-default";
  }
  if (isSubmitting) {
    return "bg-muted text-muted-foreground cursor-wait";
  }
  return "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground cursor-pointer";
}

async function fetchCommentedIndices(
  ticketId: string,
  repoPath: string,
  provider: string
): Promise<Set<number>> {
  try {
    const res = await fetch(
      `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`
    );
    const data = await res.json();
    const indices = new Set<number>();
    (data.findings ?? []).forEach((f: { commented?: boolean }, i: number) => {
      if (f.commented) {
        indices.add(i);
      }
    });
    return indices;
  } catch {
    return new Set();
  }
}

async function batchedSettled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    results.push(...batchResults);
  }
  return results;
}

function findEvictableKey(
  chats: Record<string, unknown>,
  activeKey: string | null
): string | undefined {
  return Object.keys(chats).find((k) => k !== activeKey);
}

function scheduleCrossProviderDedup(
  reviews: Record<string, ReviewEntry>,
  provider: string,
  findings: ReviewFinding[],
  triggerDedup: (provider: string, findings: ReviewFinding[]) => Promise<void>
) {
  const otherProvider = provider === "claude" ? "codex" : "claude";
  if (reviews[otherProvider]?.done) {
    setTimeout(() => triggerDedup(provider, findings), 0);
  }
}

async function fetchProviderStatus(
  repoPath: string,
  ticketId: string,
  provider: "claude" | "codex"
) {
  try {
    const res = await fetch(
      `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${provider}`
    );
    const data = await res.json();
    return { provider, data };
  } catch {
    return { provider, data: null };
  }
}
