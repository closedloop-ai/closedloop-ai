"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Dialog, DialogTitle } from "@repo/design-system/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@repo/design-system/components/ui/drawer";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Brain,
  CheckCircle,
  FileText,
  GitBranch,
  ImageIcon,
  Loader2,
  MessageSquare,
  Quote,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import Image from "next/image";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { CollapsibleBlock } from "@/components/chat/CollapsibleBlock";
import { CollapsibleBlockGroup } from "@/components/chat/CollapsibleBlockGroup";
import { LearningsUsedDialog } from "@/components/chat/LearningsUsedDialog";
import { MessageContent } from "@/components/chat/MessageContent";
import { SlashCommandDropdown } from "@/components/chat/SlashCommandDropdown";
import type { ChatMessage, ContentBlock } from "@/components/chat/types";
import { UserMessageContent } from "@/components/chat/UserMessageContent";
import { ChangedFilesViewer } from "@/components/engineer/ChangedFilesViewer";
import {
  CommentChat,
  CommentEmptyState,
} from "@/components/engineer/CommentChat";
import { DEFAULT_CODEX_MODEL } from "@/components/engineer/codex-review/constants";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import {
  dispatchMentionKeyDown,
  FileMentionAutocomplete,
  type MentionState,
} from "@/components/engineer/FileMentionAutocomplete";
import type { PRComment } from "@/components/engineer/PRCommentCard";
import { PRCommentsViewer } from "@/components/engineer/PRCommentsViewer";
import { RepoFileAutocomplete } from "@/components/engineer/RepoFileAutocomplete";
import { useChatStream } from "@/hooks/chat/use-chat-stream";
import { useCodexAvailable } from "@/hooks/engineer/use-codex-available";
import { useCodexDebate } from "@/hooks/engineer/use-codex-debate";
import { useLearnings } from "@/hooks/engineer/use-learnings";
import { useSlashCommands } from "@/hooks/engineer/use-slash-commands";
import { useIsMobile } from "@/hooks/engineer/useMediaQuery";
import {
  CHAT_SENTINEL,
  formatTime,
  getWorktreePath,
  type LearningUsed,
  MAX_CONFERRAL_DEPTH,
  parseConferralMention,
  parseDebateStatus,
  parseLearningsUsed,
  parseSuggestedActions,
  type SuggestedAction,
  sanitizeHistoryForModel,
  stripAssistantProtocol,
} from "@/lib/chat/chat-utils";
import {
  createCodexStreamState,
  readCodexStream,
} from "@/lib/engineer/codex-stream";
import {
  closedloopChatHistoryOptions,
  closedloopPlanOptions,
  closedloopStatusOptions,
  type PlanResponse,
} from "@/lib/engineer/queries/closedloop";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { reposOptions } from "@/lib/engineer/queries/repos";
import { getTextContent } from "@/lib/engineer/utils";

export type LeftPaneTab = "plan" | "changes" | "comments";

type ClosedLoopChatProps = {
  isOpen: boolean;
  onClose: () => void;
  ticketId: string;
  ticketTitle?: string;
  repoPath: string;
  contextRepoPaths?: string[];
  prInfo?: { url: string; number: number } | null;
  /** Tab to show when the dialog first opens */
  initialTab?: LeftPaneTab;
};

/**
 * ClosedLoop Chat Dialog
 * A side-by-side view with the implementation plan on the left and chat on the right
 */
export function ClosedLoopChat({
  isOpen,
  onClose,
  ticketId,
  ticketTitle,
  repoPath,
  contextRepoPaths,
  prInfo,
  initialTab,
}: Readonly<ClosedLoopChatProps>) {
  const isMobile = useIsMobile();
  const [input, setInput] = useState("");
  const [activeTab, setActiveTab] = useState<LeftPaneTab>("plan");
  const [hasSetInitialTab, setHasSetInitialTab] = useState(false);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [selectedMentions, setSelectedMentions] = useState<string[]>([]);
  const [selectedContext, setSelectedContext] =
    useState<SelectedContext | null>(null);
  const [currentDiffFile, setCurrentDiffFile] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isClearChatDialogOpen, setIsClearChatDialogOpen] = useState(false);
  const [leftPaneFraction, setLeftPaneFraction] = useState(() => {
    if (globalThis.localStorage === undefined) {
      return 0.5;
    }
    const stored = localStorage.getItem("closedloop-chat-split");
    const parsed = stored ? Number(stored) : Number.NaN;
    return parsed >= 0.3 && parsed <= 0.7 ? parsed : 0.5;
  });
  // const [previewImage, setPreviewImage] = useState<PendingImage | null>(null); // TODO: re-enable with Radix-compatible approach
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedStreamingBlocks, setExpandedStreamingBlocks] = useState<
    Set<string>
  >(new Set());
  const toggleStreamingBlock = useCallback((id: string) => {
    setExpandedStreamingBlocks((prev) => toggleSetItem(prev, id));
  }, []);
  const [commentStatusKey, setCommentStatusKey] = useState(0);
  const [selectedComment, setSelectedComment] = useState<{
    comment: PRComment;
    replies: PRComment[];
    autoStart: boolean;
  } | null>(null);
  const [isForwarding, setIsForwarding] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const streamingPidRef = useRef<number | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startX: number; startFraction: number } | null>(
    null
  );
  const pendingImagesRef = useRef<PendingImage[]>(pendingImages);
  const stream = useChatStream();
  const codexChatStream = useChatStream();
  const learnings = useLearnings({ ticketId, repoPath, activeTab });
  const { data: codexData } = useCodexAvailable();
  const { data: reposData } = useQuery(reposOptions());
  const worktreeParentDir = reposData?.settings?.worktreeParentDir;

  // Compute repos list for multi-repo file autocomplete
  const hasContextRepos = contextRepoPaths && contextRepoPaths.length > 0;
  const mentionRepos = useMemo(() => {
    if (!hasContextRepos) {
      return [];
    }
    const primaryName = repoPath.split("/").pop() || repoPath;
    const repos = [{ name: primaryName, path: repoPath }];
    for (const p of contextRepoPaths) {
      repos.push({ name: p.split("/").pop() || p, path: p });
    }
    return repos;
  }, [repoPath, contextRepoPaths, hasContextRepos]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Load chat history
  // refetchOnWindowFocus disabled: history is refreshed via explicit invalidation
  // (invalidateAfterResponse) after stream completion/stop, not on tab focus.
  // Tab-focus refetches caused duplicate messages when pendingUserMessage was still set.
  const { data: history, isLoading: isLoadingHistory } = useQuery({
    ...closedloopChatHistoryOptions(ticketId, repoPath),
    enabled: isOpen,
    refetchOnWindowFocus: false,
  });

  // Debate hook (Codex model defaults to DEFAULT_CODEX_MODEL)
  const debate = useCodexDebate({
    ticketId,
    repoPath,
    model: DEFAULT_CODEX_MODEL,
    chatHistory: history,
    claudeStream: stream,
  });

  // Load plan content
  const { data: plan, isLoading: isLoadingPlan } = useQuery({
    ...closedloopPlanOptions(ticketId, repoPath),
    enabled: isOpen,
  });

  // Load ClosedLoop status to detect completion
  const { data: closedloopStatus } = useQuery({
    ...closedloopStatusOptions(ticketId, repoPath),
    enabled: isOpen,
    refetchInterval: 5000, // Poll every 5 seconds while dialog is open
  });

  // Comments-only mode: PR linked but no ClosedLoop session
  const isCommentsOnly = !!prInfo && !closedloopStatus?.exists;

  // Determine if ClosedLoop run is completed (show tabs when completed)
  const isCompleted =
    closedloopStatus?.status === "COMPLETED" ||
    closedloopStatus?.status === "AWAITING_USER";

  // Reset tab when dialog opens (use initialTab if provided, else "plan")
  useEffect(() => {
    if (isOpen && !hasSetInitialTab) {
      const defaultTab = isCommentsOnly ? "comments" : (initialTab ?? "plan");
      setActiveTab(defaultTab);
      setHasSetInitialTab(true);
    }
    // Reset when dialog closes
    if (!isOpen) {
      setHasSetInitialTab(false);
    }
  }, [isOpen, isCommentsOnly, hasSetInitialTab, initialTab]);

  // Clear stale context and selected comment when tabs change
  useEffect(() => {
    setSelectedContext(null);
    setCurrentDiffFile(null);
    // Clear selected comment when switching away from comments tab
    if (activeTab !== "comments") {
      setSelectedComment(null);
    }
  }, [activeTab]);

  // Auto-scroll to bottom when new messages arrive
  const initialScrollDone = useRef(false);
  const scrollToBottom = useCallback((instant?: boolean) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  // Instant scroll on first load, smooth thereafter
  useEffect(() => {
    if (
      !initialScrollDone.current &&
      history?.messages &&
      history.messages.length > 0
    ) {
      initialScrollDone.current = true;
      // Use requestAnimationFrame to ensure DOM has laid out the messages
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      scrollToBottom();
    }
  }, [history?.messages, scrollToBottom]);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Track text selection in the left pane for context
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleSelectionChange = () => {
      const selection = globalThis.getSelection();
      const text = selection?.toString().trim();

      // Only update context when there's actual selected text in the left pane
      // Don't clear on empty selection (user might have clicked into input)
      if (text && selection?.anchorNode) {
        const isInLeftPane = leftPaneRef.current?.contains(
          selection.anchorNode
        );
        if (isInLeftPane) {
          setSelectedContext({
            text,
            source: activeTab,
            file:
              activeTab === "changes"
                ? (currentDiffFile ?? undefined)
                : undefined,
          });
        }
      }
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", handleSelectionChange);
  }, [isOpen, activeTab, currentDiffFile]);

  // --- Conferral infrastructure ---
  const conferralDepthRef = useRef(0);
  const conferralInProgressRef = useRef(false);
  const conferralTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up conferral timer on unmount
  useEffect(() => {
    return () => {
      if (conferralTimerRef.current) {
        clearTimeout(conferralTimerRef.current);
      }
    };
  }, []);

  const resetConferral = useCallback(() => {
    conferralDepthRef.current = 0;
    if (conferralTimerRef.current) {
      clearTimeout(conferralTimerRef.current);
      conferralTimerRef.current = null;
    }
  }, []);

  // Conferral callback refs (defined after sendToCodex, assigned below)
  const sendConferralToCodexRef = useRef<
    (prompt: string, context: string) => void
  >(() => {});
  const sendConferralToClaudeRef = useRef<
    (prompt: string, context: string) => void
  >(() => {});

  // Invalidate queries after a response or stop.
  // Awaits chat history so streaming content stays visible until fresh data arrives.
  const invalidateAfterResponse = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.closedloopPlan(ticketId, repoPath),
    });
    const worktreePath = getWorktreePath(repoPath, ticketId, worktreeParentDir);
    queryClient.invalidateQueries({
      queryKey: queryKeys.gitStatus(worktreePath),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.gitBranchDiff(worktreePath),
    });
    // Invalidate all git-diff queries for this worktree (partial key match)
    queryClient.invalidateQueries({
      queryKey: ["git-diff", worktreePath],
    });
  }, [queryClient, ticketId, repoPath, worktreeParentDir]);

  // Handle /reflect command
  const handleReflect = useCallback(() => {
    setInput("");
    setSelectedMentions([]);
    learnings.triggerExtract();
  }, [learnings]);

  // Shared callbacks for stream.sendMessage
  const streamCallbacks = useMemo(
    () => ({
      onComplete: async (accumulatedText: string) => {
        await invalidateAfterResponse();
        // Detect Claude → Codex conferral
        if (!debate.debateMode) {
          const mention = parseConferralMention(accumulatedText, "claude");
          if (mention) {
            conferralTimerRef.current = setTimeout(
              () =>
                sendConferralToCodexRef.current(
                  mention.prompt,
                  accumulatedText
                ),
              0
            );
          }
        }
      },
      onPid: (pid: number) => {
        streamingPidRef.current = pid;
      },
      onLearnings: learnings.poll,
      onLearningsUsed: (used: LearningUsed[]) => {
        fetch("/api/gateway/symphony/record-learning-use", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId, repoPath, learnings: used }),
        }).catch((err) => console.error("Failed to record learning use:", err));
      },
    }),
    [
      invalidateAfterResponse,
      learnings.poll,
      ticketId,
      repoPath,
      debate.debateMode,
    ]
  );

  // Handle /merge and /rebase slash commands
  const handleGitSlashCommand = useCallback(
    async (command: "/merge" | "/rebase", branch: string) => {
      if (stream.isStreaming) {
        return;
      }

      setInput("");
      setSelectedMentions([]);

      const prompt =
        command === "/merge"
          ? buildMergePrompt(branch)
          : buildRebasePrompt(branch);
      const displayText =
        command === "/merge"
          ? `Merge ${branch} into current branch`
          : `Rebase current branch onto ${branch}`;
      const displayContent = `<context source="${command.slice(1)}">\n${prompt}\n</context>\n\n${displayText}`;

      stream.setPendingUserMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: displayContent,
        timestamp: new Date().toISOString(),
      });

      setExpandedStreamingBlocks(new Set());
      streamingPidRef.current = null;
      const url = `/api/gateway/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      await stream.sendMessage(
        url,
        {
          message: prompt,
          displayContent,
          activeTab,
          contextRepoPaths,
          codexAvailable: codexData?.available,
        },
        streamCallbacks
      );
      streamingPidRef.current = null;
    },
    [
      stream,
      ticketId,
      repoPath,
      activeTab,
      contextRepoPaths,
      codexData?.available,
      streamCallbacks,
    ]
  );

  // Send a message to Codex via the freeform chat endpoint
  const sendToCodex = useCallback(
    async (codexPrompt: string, displayContent: string, isForward = false) => {
      const userMsg = {
        id: `user-${Date.now()}`,
        role: "user" as const,
        content: displayContent,
        timestamp: new Date().toISOString(),
      };
      stream.setPendingUserMessage(userMsg);

      setInput("");
      setSelectedMentions([]);
      if (inputRef.current) {
        inputRef.current.value = "";
      }

      // Save user message to chat history so it persists after the pending state clears
      await fetch(
        `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userMsg }),
        }
      ).catch(() => {
        /* best-effort */
      });

      const url = `/api/gateway/codex/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;

      // Build recent chat history for context (last 10 messages, sanitize protocol metadata)
      const recentHistory = sanitizeHistoryForModel(
        (history?.messages || []).slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
          sender: m.sender,
        }))
      );

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: codexPrompt,
            repoPath,
            chatHistory: recentHistory,
            activeTab,
            contextRepoPaths,
            isForward,
            chatContextId: "general",
            model: DEFAULT_CODEX_MODEL,
          }),
        });
      } catch (err) {
        toast.error("Failed to reach Codex", {
          description: err instanceof Error ? err.message : "Network error",
        });
        stream.setPendingUserMessage(null);
        return;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        toast.error("Failed to send to Codex", {
          description: `${response.status}: ${body.slice(0, 200)}`,
        });
        stream.setPendingUserMessage(null);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        stream.setPendingUserMessage(null);
        return;
      }

      const state = createCodexStreamState();
      await readCodexStream(reader, state, {
        setPending: codexChatStream.setPendingUserMessage,
        saveFinalMessage: async (msg) => {
          await fetch(
            `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: msg }),
            }
          );
          await queryClient.invalidateQueries({
            queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath),
          });
        },
        onError: (error) => {
          console.error("[codex-chat] Server error:", error);
          toast.error("Codex error", { description: error });
        },
        onEmptyResponse: (exitCode) => {
          toast.error("Codex returned no response", {
            description: `Exit code: ${exitCode ?? "unknown"}`,
          });
        },
        onComplete: (finalContent) => {
          if (!debate.debateMode) {
            const mention = parseConferralMention(finalContent, "codex");
            if (mention) {
              conferralTimerRef.current = setTimeout(
                () =>
                  sendConferralToClaudeRef.current(
                    mention.prompt,
                    finalContent
                  ),
                0
              );
            }
          }
        },
      });

      // Clean up pending user message
      stream.setPendingUserMessage(null);
    },
    [
      ticketId,
      repoPath,
      stream,
      codexChatStream,
      queryClient,
      activeTab,
      contextRepoPaths,
      history?.messages,
      debate.debateMode,
    ]
  );

  // --- Conferral callbacks ---
  const sendConferralToCodex = useCallback(
    async (prompt: string, claudeContext: string) => {
      if (
        conferralDepthRef.current >= MAX_CONFERRAL_DEPTH ||
        conferralInProgressRef.current ||
        debate.debateMode
      ) {
        return;
      }
      conferralDepthRef.current += 1;
      conferralInProgressRef.current = true;
      try {
        const wrappedPrompt = `Claude has asked for your input on the following:\n\n${prompt}\n\n<context source="claude-response">\n${claudeContext}\n</context>`;
        await sendToCodex(
          wrappedPrompt,
          CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX
        );
      } finally {
        conferralInProgressRef.current = false;
      }
    },
    [debate.debateMode, sendToCodex]
  );
  sendConferralToCodexRef.current = sendConferralToCodex;

  const sendConferralToClaude = useCallback(
    async (prompt: string, codexContext: string) => {
      if (
        conferralDepthRef.current >= MAX_CONFERRAL_DEPTH ||
        conferralInProgressRef.current ||
        debate.debateMode
      ) {
        return;
      }
      conferralDepthRef.current += 1;
      conferralInProgressRef.current = true;
      try {
        const wrappedPrompt = `Codex has asked for your input on the following:\n\n${prompt}\n\n<context source="codex-response">\n${codexContext}\n</context>`;
        stream.setPendingUserMessage({
          id: `user-${Date.now()}`,
          role: "user",
          content: CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE,
          timestamp: new Date().toISOString(),
        });
        const url = `/api/gateway/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
        await stream.sendMessage(
          url,
          {
            message: wrappedPrompt,
            displayContent: CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE,
            activeTab,
            contextRepoPaths,
            codexAvailable: codexData?.available,
          },
          streamCallbacks
        );
      } finally {
        conferralInProgressRef.current = false;
      }
    },
    [
      debate.debateMode,
      stream,
      ticketId,
      repoPath,
      activeTab,
      contextRepoPaths,
      codexData?.available,
      streamCallbacks,
    ]
  );
  sendConferralToClaudeRef.current = sendConferralToClaude;

  // Start debate mode from /debate command — just enters the mode with a status message
  const startDebateFromSlash = useCallback(async () => {
    if (!codexData?.available) {
      toast.error("Codex is not available", {
        description: "Install Codex CLI to use debate mode.",
      });
      return;
    }
    if (debate.debateMode) {
      toast("Already in debate mode");
      return;
    }
    const statusMsg: ChatMessage = {
      id: `status-${Date.now()}`,
      role: "user",
      content: CHAT_SENTINEL.DEBATE_STARTED,
      timestamp: new Date().toISOString(),
    };
    await fetch(
      `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: statusMsg }),
      }
    ).catch(() => {
      /* best-effort */
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath),
    });
    debate.startDebateMode();
  }, [codexData?.available, debate, ticketId, repoPath, queryClient]);

  // End debate mode from /end-debate command — exits the mode with a status message
  const endDebateFromSlash = useCallback(async () => {
    if (!debate.debateMode) {
      toast("Not in debate mode");
      return;
    }
    const statusMsg: ChatMessage = {
      id: `status-${Date.now()}`,
      role: "user",
      content: CHAT_SENTINEL.DEBATE_ENDED,
      timestamp: new Date().toISOString(),
    };
    await fetch(
      `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: statusMsg }),
      }
    ).catch(() => {
      /* best-effort */
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath),
    });
    debate.handleEndDebate();
    toast.success("Debate ended");
  }, [debate, ticketId, repoPath, queryClient]);

  // Clear input field and optionally flush the DOM textarea value
  const clearInput = () => {
    setInput("");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  // Handle @codex mention — returns true if the input was consumed
  const handleCodexMention = async (trimmedInput: string): Promise<boolean> => {
    const codexMatch = /^@codex\s+/i.exec(trimmedInput);
    if (!codexMatch) {
      return false;
    }

    const codexPrompt = trimmedInput.slice(codexMatch[0].length);
    if (!codexPrompt) {
      return false;
    }

    if (!codexData?.available) {
      toast.error("Codex is not available", {
        description: "Install Codex CLI to use @codex mentions.",
      });
      return true;
    }

    // In debate mode, route to the existing Codex debate conversation
    if (debate.debateMode) {
      await debate.sendHumanToCodex(codexPrompt, trimmedInput);
      setInput("");
      setSelectedMentions([]);
      return true;
    }

    setInput("");
    setSelectedMentions([]);
    // Force-clear the textarea DOM value immediately — React's batched
    // state update sometimes doesn't flush before the await below yields.
    if (inputRef.current) {
      inputRef.current.value = "";
    }
    await sendToCodex(codexPrompt, trimmedInput);
    return true;
  };

  // Try handling input as a slash command — returns true if consumed
  const handleSlashInput = async (trimmedInput: string): Promise<boolean> => {
    if (trimmedInput === "/reflect") {
      clearInput();
      handleReflect();
      return true;
    }
    if (/^\/debate$/i.test(trimmedInput)) {
      clearInput();
      startDebateFromSlash();
      return true;
    }
    if (/^\/end-debate$/i.test(trimmedInput)) {
      clearInput();
      endDebateFromSlash();
      return true;
    }
    const mergeMatch = /^\/merge\s+(\S+)$/i.exec(trimmedInput);
    if (mergeMatch) {
      await handleGitSlashCommand("/merge", mergeMatch[1]);
      return true;
    }
    const rebaseMatch = /^\/rebase\s+(\S+)$/i.exec(trimmedInput);
    if (rebaseMatch) {
      await handleGitSlashCommand("/rebase", rebaseMatch[1]);
      return true;
    }
    return false;
  };

  // Handle sending a message
  const handleSend = async () => {
    resetConferral();
    const trimmedInput = input.trim();

    if (await handleSlashInput(trimmedInput)) {
      return;
    }
    if (await handleCodexMention(trimmedInput)) {
      return;
    }

    const hasImages = pendingImages.some((img) => img.status === "uploaded");
    if (!(trimmedInput || hasImages) || stream.isStreaming) {
      return;
    }
    if (pendingImages.some((img) => img.status === "uploading")) {
      return;
    }

    const uploadedImages = pendingImages.filter(
      (img) => img.status === "uploaded" && img.savedPath
    );
    const { messageToSend, displayContent } = buildMessageContents(
      trimmedInput,
      selectedContext,
      uploadedImages
    );

    stream.setPendingUserMessage({
      id: `user-${Date.now()}`,
      role: "user",
      content: displayContent,
      timestamp: new Date().toISOString(),
      mentions: selectedMentions.length > 0 ? [...selectedMentions] : undefined,
    });

    setInput("");
    setSelectedMentions([]);
    setExpandedStreamingBlocks(new Set());

    for (const img of pendingImages) {
      URL.revokeObjectURL(img.thumbnailUrl);
    }
    setPendingImages([]);
    setSelectedContext(null);
    globalThis.getSelection()?.removeAllRanges();

    streamingPidRef.current = null;
    const url = `/api/gateway/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
    await stream.sendMessage(
      url,
      {
        message: messageToSend,
        activeTab,
        contextRepoPaths,
        codexAvailable: codexData?.available,
      },
      streamCallbacks
    );
    streamingPidRef.current = null;
  };

  const handleStop = async () => {
    // Stop Claude stream if active
    if (stream.isStreaming) {
      const partialContent = stream.streamingContent.trim();
      stream.stopStreaming();

      // Kill the server-side process if we have a PID
      const pid = streamingPidRef.current;
      if (pid) {
        try {
          await fetch("/api/gateway/symphony/kill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pid }),
          });
        } catch {
          // Best effort
        }
      }

      // Save partial assistant response if there was any content
      if (partialContent) {
        try {
          await fetch(
            `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: {
                  id: `assistant-${Date.now()}`,
                  role: "assistant",
                  content: `${partialContent}\n\n_(stopped by user)_`,
                  timestamp: new Date().toISOString(),
                },
              }),
            }
          );
        } catch {
          // Best effort
        }
      }
    }

    // Stop Codex debate stream if active
    debate.stopCodex();

    invalidateAfterResponse();
  };

  // Forward a specific Codex message to Claude for review
  const forwardMessageToClaude = useCallback(
    async (targetMsg: ChatMessage) => {
      if (stream.isStreaming) {
        return;
      }
      resetConferral();
      setIsForwarding(true);

      setInput("");

      // Strip all protocol metadata from Codex's content
      const contentWithoutActions = stripAssistantProtocol(targetMsg.content);

      // Show a subtle forwarded indicator (not a full user bubble)
      const forwardedMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: CHAT_SENTINEL.FORWARDED_TO_CLAUDE,
        timestamp: new Date().toISOString(),
      };
      stream.setPendingUserMessage(forwardedMsg);

      // Save the forwarded indicator to chat history so it persists
      await fetch(
        `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: forwardedMsg }),
        }
      ).catch(() => {
        /* best-effort */
      });

      // Frame the Codex content for Claude
      const claudePrompt = `Codex (OpenAI) provided the following feedback:\n\n${contentWithoutActions}\n\nReview this critically. The goal is to converge on the best solution, not just provide a second opinion. Prefer simpler approaches where they work. If Codex's suggestion adds unnecessary complexity, say so and propose a leaner alternative. If it's solid, confirm that and explain why. Be specific — cite code, name files, reference actual behavior.`;

      setExpandedStreamingBlocks(new Set());
      streamingPidRef.current = null;
      const url = `/api/gateway/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      await stream.sendMessage(
        url,
        {
          message: claudePrompt,
          activeTab,
          contextRepoPaths,
          codexAvailable: codexData?.available,
        },
        streamCallbacks
      );
      streamingPidRef.current = null;
    },
    [
      stream,
      ticketId,
      repoPath,
      activeTab,
      contextRepoPaths,
      codexData?.available,
      streamCallbacks,
      resetConferral,
    ]
  );

  // Forward last Codex response to Claude for review
  const handleSendCodexToClaude = useCallback(async () => {
    const msgs = history?.messages || [];
    // Find last codex message
    let lastCodexMsg: ChatMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].sender === "codex") {
        lastCodexMsg = msgs[i];
        break;
      }
    }
    if (!lastCodexMsg) {
      toast.error("No Codex response to forward");
      return;
    }
    await forwardMessageToClaude(lastCodexMsg);
  }, [history?.messages, forwardMessageToClaude]);

  // Send a message programmatically (for action buttons)
  const sendActionMessage = useCallback(
    async (action: SuggestedAction) => {
      const messageText = action.message;
      // Check if debate hook handles this action
      if (debate.handleAction(messageText)) {
        return;
      }

      // Forward Codex response to Claude
      if (messageText === "__send_to_claude__") {
        await handleSendCodexToClaude();
        return;
      }

      if (!messageText.trim() || stream.isStreaming) {
        return;
      }

      const trimmedMessage = messageText.trim();

      stream.setPendingUserMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmedMessage,
        timestamp: new Date().toISOString(),
      });

      setExpandedStreamingBlocks(new Set());
      streamingPidRef.current = null;

      const url = `/api/gateway/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      await stream.sendMessage(
        url,
        {
          message: trimmedMessage,
          activeTab,
          contextRepoPaths,
          codexAvailable: codexData?.available,
        },
        streamCallbacks
      );
      streamingPidRef.current = null;
    },
    [
      debate,
      handleSendCodexToClaude,
      stream,
      ticketId,
      repoPath,
      activeTab,
      contextRepoPaths,
      codexData?.available,
      streamCallbacks,
    ]
  );

  // Handle input change with @ mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;
    setInput(newValue);

    // Prune mentions that are no longer in the text
    setSelectedMentions((prev) => prev.filter((m) => newValue.includes(m)));

    // Find if we're in a mention context
    const mentionStart = detectMentionStart(newValue, cursorPos);

    if (mentionStart >= 0) {
      const query = newValue.slice(mentionStart + 1, cursorPos);
      setMentionState({
        isOpen: true,
        query,
        startIndex: mentionStart,
        selectedIndex: 0,
      });
    } else {
      setMentionState(null);
    }

    // Slash command detection
    slash.detectSlash(newValue, cursorPos);
  };

  // Handle file selection from autocomplete
  const handleFileSelect = (file: string) => {
    if (!mentionState) {
      return;
    }

    // Special handling for @codex selection from autocomplete
    if (file === "@codex") {
      const beforeMention = input.slice(0, mentionState.startIndex);
      const afterMention = input.slice(
        mentionState.startIndex + 1 + mentionState.query.length
      );
      const newValue = `${beforeMention}@codex ${afterMention}`;
      setInput(newValue);
      setMentionState(null);
      // Don't add to selectedMentions — @codex is a routing directive, not a file context
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const newCursorPos = beforeMention.length + "@codex ".length;
          inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
      return;
    }

    const beforeMention = input.slice(0, mentionState.startIndex);
    const afterMention = input.slice(
      mentionState.startIndex + 1 + mentionState.query.length
    );
    const newValue = `${beforeMention + file} ${afterMention}`;

    setInput(newValue);
    setMentionState(null);
    setSelectedMentions((prev) =>
      prev.includes(file) ? prev : [...prev, file]
    );

    // Focus input and set cursor after inserted file
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        const newCursorPos = beforeMention.length + file.length + 1;
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    }, 0);
  };

  // Close mention autocomplete
  const closeMention = () => {
    setMentionState(null);
  };

  // Upload an image file
  const uploadImage = useCallback(
    async (file: File) => {
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const thumbnailUrl = URL.createObjectURL(file);

      const pendingImg: PendingImage = {
        id,
        file,
        thumbnailUrl,
        status: "uploading",
      };

      setPendingImages((prev) => [...prev, pendingImg]);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch(
          `/api/gateway/symphony/upload/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          { method: "POST", body: formData }
        );

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Upload failed");
        }

        const data = await res.json();
        const uploaded = data.files[0];

        setPendingImages((prev) =>
          prev.map((img) =>
            img.id === id
              ? {
                  ...img,
                  status: "uploaded",
                  savedPath: uploaded.path,
                  apiUrl: uploaded.apiUrl,
                }
              : img
          )
        );
      } catch (err) {
        setPendingImages((prev) =>
          prev.map((img) =>
            img.id === id
              ? {
                  ...img,
                  status: "error",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : img
          )
        );
      }
    },
    [ticketId, repoPath]
  );

  // Remove a pending image
  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) {
        URL.revokeObjectURL(img.thumbnailUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  // Paste handler for images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            uploadImage(file);
          }
        }
      }
    },
    [uploadImage]
  );

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          uploadImage(file);
        }
      }
    },
    [uploadImage]
  );

  // Drag-to-resize split panes (desktop only)
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
          localStorage.setItem("closedloop-chat-split", String(cur));
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

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      for (const img of pendingImagesRef.current) {
        URL.revokeObjectURL(img.thumbnailUrl);
      }
    };
  }, []);

  // Slash command handler — execute the selected command
  const handleSlashCommandSelect = useCallback(
    (command: string) => {
      if (command === "/reflect") {
        handleReflect();
      } else if (/^\/debate$/i.test(command)) {
        setInput("");
        startDebateFromSlash();
      } else if (/^\/end-debate$/i.test(command)) {
        setInput("");
        endDebateFromSlash();
      } else if (/^\/merge$/i.test(command) || /^\/rebase$/i.test(command)) {
        // Insert command into input so user can type the branch name
        const text = `${command} `;
        setInput(text);
        if (inputRef.current) {
          inputRef.current.value = text;
          inputRef.current.focus();
        }
      }
    },
    [handleReflect, startDebateFromSlash, endDebateFromSlash]
  );

  const slash = useSlashCommands(SLASH_COMMANDS, handleSlashCommandSelect);

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionState?.isOpen) {
      const consumed = dispatchMentionKeyDown(
        e,
        mentionState,
        mentionFiles,
        setMentionState,
        handleFileSelect
      );
      if (consumed) {
        return;
      }
    }

    if (
      slash.slashState?.isOpen &&
      slash.filteredCommands.length > 0 &&
      slash.handleKeyDown(e)
    ) {
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Clear entire chat
  const handleClearChat = async () => {
    try {
      const response = await fetch(
        `/api/gateway/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.closedloopChatHistory(ticketId, repoPath),
        });
      }
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  // Combine history messages with pending user message for display.
  // Transform <attached-images> blocks in history to markdown images for rendering.
  // Deduplication: if history grew since we sent (i.e., our message was saved and refetched),
  // the pending message is already in history — don't append it again.
  const historyMessages = useMemo(
    () =>
      (history?.messages || []).map((msg) => {
        let content = msg.content;
        if (msg.role === "user" && content.includes("<attached-images>")) {
          content = transformAttachedImages(content, ticketId, repoPath);
        }
        if (msg.role === "assistant" && content.includes("<debate-status>")) {
          content = parseDebateStatus(content).cleanContent;
        }
        return content === msg.content ? msg : { ...msg, content };
      }),
    [history?.messages, ticketId, repoPath]
  );
  const messages = useMemo(() => {
    if (!stream.pendingUserMessage) {
      return historyMessages;
    }
    const alreadyInHistory = historyMessages.some(
      (m) =>
        m.role === "user" && m.content === stream.pendingUserMessage!.content
    );
    return alreadyInHistory
      ? historyMessages
      : [...historyMessages, stream.pendingUserMessage];
  }, [historyMessages, stream.pendingUserMessage]);

  // Copy a message's text content to clipboard
  const handleCopyMessage = useCallback(
    async (index: number) => {
      const msg = messages[index];
      if (!msg) {
        return;
      }
      const cleanText = stripAssistantProtocol(msg.content);
      try {
        await navigator.clipboard.writeText(cleanText);
        toast.success("Copied to clipboard");
      } catch {
        toast.error("Failed to copy");
      }
    },
    [messages]
  );

  // Forward a specific Codex message to Claude (by index)
  const handleForwardCodexMessage = useCallback(
    async (index: number) => {
      const msg = messages[index];
      if (msg?.sender !== "codex") {
        return;
      }
      await forwardMessageToClaude(msg);
    },
    [messages, forwardMessageToClaude]
  );

  // Forward a Claude assistant message to Codex
  const handleForwardMessage = useCallback(
    async (index: number) => {
      const msg = messages[index];
      if (msg?.role !== "assistant") {
        return;
      }
      if (stream.isStreaming) {
        return;
      }
      resetConferral();
      setIsForwarding(true);
      if (!codexData?.available) {
        toast.error("Codex is not available", {
          description: "Install Codex CLI to use forwarding.",
        });
        return;
      }
      const cleanContent = stripAssistantProtocol(msg.content);
      const codexPrompt = `Claude (Anthropic) provided the following response:\n\n${cleanContent}\n\nReview this critically. The goal is to converge on the best solution, not just provide a second opinion. Prefer simpler approaches where they work. If Claude's suggestion is overcomplicated, say so and propose a leaner alternative. If it's solid, confirm that and explain why. Be specific — cite code, name files, reference actual behavior.`;
      await sendToCodex(codexPrompt, CHAT_SENTINEL.FORWARDED_TO_CODEX, true);
    },
    [
      messages,
      stream.isStreaming,
      codexData?.available,
      sendToCodex,
      resetConferral,
    ]
  );

  // Clear forwarding flag when all streams finish
  const isAnyStreamingTop =
    stream.isStreaming ||
    !!debate.codexStream.pendingUserMessage ||
    !!codexChatStream.pendingUserMessage;
  const prevStreamingRef = useRef(isAnyStreamingTop);
  useEffect(() => {
    if (prevStreamingRef.current && !isAnyStreamingTop) {
      setIsForwarding(false);
    }
    prevStreamingRef.current = isAnyStreamingTop;
  }, [isAnyStreamingTop]);
  const canForward = !(isAnyStreamingTop || isForwarding);

  // Tab bar for Plan/Changes/PR Comments
  const tabBar = (isCompleted || isCommentsOnly) && (
    <div className="flex shrink-0 border-border border-b bg-muted/30">
      {!isCommentsOnly && (
        <button
          className={cn(
            "flex-1 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors focus:outline-none",
            activeTab === "plan"
              ? "border-primary border-b-2 bg-background text-primary"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          onClick={() => setActiveTab("plan")}
          type="button"
        >
          <div className="flex items-center justify-center gap-2">
            <FileText className="size-3.5" />
            Plan
          </div>
        </button>
      )}
      {!isCommentsOnly && (
        <button
          className={cn(
            "flex-1 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors focus:outline-none",
            activeTab === "changes"
              ? "border-emerald-500 border-b-2 bg-background text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          onClick={() => setActiveTab("changes")}
          type="button"
        >
          <div className="flex items-center justify-center gap-2">
            <GitBranch className="size-3.5" />
            Changes
          </div>
        </button>
      )}
      {prInfo && (
        <button
          className={cn(
            "flex-1 px-4 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors focus:outline-none",
            activeTab === "comments"
              ? "border-sky-500 border-b-2 bg-background text-sky-600 dark:text-sky-400"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
          onClick={() => setActiveTab("comments")}
          type="button"
        >
          <div className="flex items-center justify-center gap-2">
            <MessageSquare className="size-3.5" />
            PR Comments
          </div>
        </button>
      )}
    </div>
  );

  // Plan/Changes/Comments content
  const showPlan =
    (activeTab === "plan" && !isCommentsOnly) ||
    !(isCompleted || isCommentsOnly);
  const showComments = !showPlan && activeTab === "comments" && !!prInfo;
  const leftPaneContent = (
    <div className="flex min-h-0 flex-1 flex-col" ref={leftPaneRef}>
      {showPlan && (
        <PlanViewerContent
          isLoading={isLoadingPlan}
          plan={plan}
          repoPath={repoPath}
          showHeader={!isCompleted}
          ticketId={ticketId}
        />
      )}
      {showComments && prInfo && (
        <div className="flex-1 overflow-hidden p-4">
          <PRCommentsViewer
            onCommentDismissed={(id) => {
              if (selectedComment?.comment.id === id) {
                setSelectedComment(null);
              }
            }}
            onCommentSelected={
              isMobile
                ? undefined
                : (comment, replies, autoStart) =>
                    setSelectedComment({ comment, replies, autoStart })
            }
            prNumber={prInfo.number}
            repoPath={repoPath}
            statusRefreshKey={commentStatusKey}
            // Only use callback mode on desktop - mobile keeps the modal behavior
            ticketId={ticketId}
          />
        </div>
      )}
      {!(showPlan || showComments) && (
        <ChangedFilesViewer
          onSelectedFileChange={setCurrentDiffFile}
          repoPath={repoPath}
          ticketId={ticketId}
        />
      )}
    </div>
  );

  // Chat header
  const chatHeader = (
    <ClosedLoopChatHeader
      autoDebate={debate.autoDebate}
      currentRound={debate.currentRound}
      debateMode={debate.debateMode}
      isStreaming={stream.isStreaming}
      learningsCount={learnings.count}
      learningsStatus={learnings.status}
      maxRounds={debate.maxRounds}
    />
  );

  // Messages area
  const messagesArea = (
    <ChatMessagesArea
      activeTab={activeTab}
      canForward={canForward}
      codexChatStream={codexChatStream}
      debate={debate}
      expandedStreamingBlocks={expandedStreamingBlocks}
      handleCopyMessage={handleCopyMessage}
      handleForwardCodexMessage={handleForwardCodexMessage}
      handleForwardMessage={handleForwardMessage}
      historyMessages={historyMessages}
      isLoadingHistory={isLoadingHistory}
      isMobile={isMobile}
      messages={messages}
      messagesEndRef={messagesEndRef}
      onToggleStreamingBlock={toggleStreamingBlock}
      savedContextPercent={history?.contextPercent}
      sendActionMessage={sendActionMessage}
      stream={stream}
    />
  );

  const hasUploadingImages = pendingImages.some(
    (img) => img.status === "uploading"
  );
  const hasUploadedImages = pendingImages.some(
    (img) => img.status === "uploaded"
  );
  const canSend =
    (input.trim() || hasUploadedImages) &&
    !stream.isStreaming &&
    !hasUploadingImages;

  // Input area
  const inputArea = (
    <ClosedLoopChatInputArea
      activeTab={activeTab}
      autoDebate={debate.autoDebate}
      canSend={canSend}
      debateMode={debate.debateMode}
      hasContextRepos={hasContextRepos}
      historyCount={historyMessages.length}
      input={input}
      inputContainerRef={inputContainerRef}
      inputRef={inputRef}
      isAnyStreaming={isAnyStreamingTop}
      isDragOver={isDragOver}
      mentionRepos={mentionRepos}
      mentionState={mentionState}
      messageCount={messages.length}
      onClearChat={() => setIsClearChatDialogOpen(true)}
      onClearContext={() => {
        setSelectedContext(null);
        globalThis.getSelection()?.removeAllRanges();
      }}
      onCloseMention={closeMention}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onFileSelect={handleFileSelect}
      onInputChange={handleInputChange}
      onKeyDown={handleKeyDown}
      onMentionFilesChange={setMentionFiles}
      onMentionIndexChange={(index) =>
        setMentionState((prev) =>
          prev ? { ...prev, selectedIndex: index } : null
        )
      }
      onPaste={handlePaste}
      onRemoveImage={removeImage}
      onSend={handleSend}
      onStop={handleStop}
      onToggleAutoDebate={() => debate.setAutoDebate(!debate.autoDebate)}
      pendingImages={pendingImages}
      repoPath={repoPath}
      selectedContext={selectedContext}
      selectedMentions={selectedMentions}
      slash={slash}
      ticketId={ticketId}
    />
  );

  // TODO: Image preview overlay disabled — Radix Dialog captures pointer events
  // at the document level, preventing dismiss. Revisit with a Radix-based approach.

  // Right pane content for desktop layout
  let rightPaneContent: React.ReactNode;
  if (activeTab === "comments" && selectedComment) {
    rightPaneContent = (
      <CommentChat
        autoStart={selectedComment.autoStart}
        comment={selectedComment.comment}
        commentId={selectedComment.comment.id}
        key={selectedComment.comment.id}
        onDeselect={() => setSelectedComment(null)}
        onResolved={() => {
          setSelectedComment(null);
          setCommentStatusKey((v) => v + 1);
        }}
        prNumber={prInfo?.number ?? 0}
        replies={selectedComment.replies}
        repoPath={repoPath}
        ticketId={ticketId}
      />
    );
  } else if (activeTab === "comments") {
    rightPaneContent = <CommentEmptyState />;
  } else {
    rightPaneContent = (
      <>
        {chatHeader}
        {messagesArea}
        {inputArea}
      </>
    );
  }

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      learnings.handleClose();
      onClose();
    }
  };

  const clearChatDialog = (
    <AlertDialog
      onOpenChange={setIsClearChatDialogOpen}
      open={isClearChatDialogOpen}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear chat history?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove all saved messages from this ClosedLoop chat.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              handleClearChat();
              setIsClearChatDialogOpen(false);
            }}
          >
            Clear Chat
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // Mobile: Full-screen drawer with vertical layout
  if (isMobile) {
    return (
      <>
        <Drawer onOpenChange={handleDialogOpenChange} open={isOpen}>
          <DrawerContent className="flex h-[90vh] max-h-[90vh] flex-col">
            <DrawerTitle className="sr-only">
              Closedloop.dev Chat for {ticketId}
            </DrawerTitle>
            {ticketTitle && (
              <div className="flex shrink-0 items-center gap-2 border-border border-b bg-muted/30 px-4 py-2.5">
                <span className="shrink-0 font-mono font-semibold text-[11px] text-primary">
                  {ticketId}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {ticketTitle}
                </span>
              </div>
            )}

            {/* Tabs at top */}
            {tabBar}

            {/* Plan/Changes content - scrollable */}
            <div className="min-h-0 flex-1 overflow-y-auto border-border border-b">
              {leftPaneContent}
            </div>

            {/* Chat section */}
            <div className="flex max-h-[45vh] shrink-0 flex-col">
              {chatHeader}
              <div className="max-h-[200px] min-h-[100px] flex-1 overflow-y-auto">
                {messagesArea}
              </div>
              {inputArea}
            </div>
          </DrawerContent>
        </Drawer>
        {clearChatDialog}
      </>
    );
  }

  // Desktop: Side-by-side dialog (unchanged)
  return (
    <>
      <Dialog onOpenChange={handleDialogOpenChange} open={isOpen}>
        <ExpandableDialogContent
          className="flex h-[85vh] max-h-[900px] w-[95vw] max-w-3xl flex-col gap-0 overflow-hidden border-border bg-background p-0 lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl"
          isExpanded={isExpanded}
          onToggleExpand={() => setIsExpanded((v) => !v)}
        >
          <DialogTitle className="sr-only">
            ClosedLoop Chat for {ticketId}
          </DialogTitle>
          {ticketTitle && (
            <div className="flex min-h-0 shrink-0 items-center gap-2 border-border border-b bg-muted/30 px-5 py-4 pr-24">
              <span className="shrink-0 font-mono font-semibold text-[11px] text-primary">
                {ticketId}
              </span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {ticketTitle}
              </span>
            </div>
          )}

          {/* Two-column layout */}
          <div className="flex min-h-0 flex-1" ref={splitContainerRef}>
            {/* Left: Plan or Changes Viewer */}
            <div
              className="flex min-h-0 min-w-0 flex-col"
              style={{ width: `${leftPaneFraction * 100}%` }}
            >
              {tabBar}
              {leftPaneContent}
            </div>

            {/* Drag handle */}
            <button
              aria-label="Resize panes"
              className="w-1 shrink-0 cursor-col-resize border-y-0 border-r-0 border-l bg-transparent p-0 transition-colors hover:bg-primary/30 focus:outline-none active:bg-primary/50"
              onMouseDown={handleSplitDragStart}
              type="button"
            />

            {/* Right: Chat or CommentChat */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {rightPaneContent}
            </div>
          </div>
        </ExpandableDialogContent>
      </Dialog>
      {clearChatDialog}
    </>
  );
}

type PendingImage = {
  id: string;
  file: File;
  thumbnailUrl: string;
  status: "uploading" | "uploaded" | "error";
  savedPath?: string;
  apiUrl?: string;
  error?: string;
};

type SelectedContext = {
  text: string;
  source: "plan" | "changes" | "comments";
  file?: string; // Only present when source is "changes"
};

/* ---------- Status indicator config for special chat messages ---------- */

const STATUS_INDICATORS: Record<
  string,
  { text: string; className: string; py: string }
> = {
  [CHAT_SENTINEL.FORWARDED_TO_CLAUDE]: {
    text: "Forwarded Codex response to Claude",
    className: "text-muted-foreground/60",
    py: "py-1",
  },
  [CHAT_SENTINEL.FORWARDED_TO_CODEX]: {
    text: "Forwarded Claude response to Codex",
    className: "text-muted-foreground/60",
    py: "py-1",
  },
  [CHAT_SENTINEL.DEBATE_STARTED]: {
    text: "Debate mode started",
    className: "text-amber-600/70 dark:text-amber-400/70",
    py: "py-1.5",
  },
  [CHAT_SENTINEL.DEBATE_ENDED]: {
    text: "Debate mode ended",
    className: "text-amber-600/70 dark:text-amber-400/70",
    py: "py-1.5",
  },
  [CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX]: {
    text: "Claude asked Codex for input",
    className: "text-blue-600/70 dark:text-blue-400/70",
    py: "py-1",
  },
  [CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE]: {
    text: "Codex asked Claude for input",
    className: "text-blue-600/70 dark:text-blue-400/70",
    py: "py-1",
  },
};

/* ---------- Extracted ReactMarkdown component overrides (module-level) ---------- */

function MdH1({ children }: Readonly<{ children?: React.ReactNode }>) {
  return (
    <h1 className="mt-4 mb-2 border-border border-b pb-1 font-bold text-base first:mt-0">
      {children}
    </h1>
  );
}
function MdH2({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <h2 className="mt-4 mb-2 font-semibold text-sm">{children}</h2>;
}
function MdH3({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <h3 className="mt-3 mb-1 font-semibold text-xs">{children}</h3>;
}
function MdTable({ children }: Readonly<{ children?: React.ReactNode }>) {
  return (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  );
}
function MdThead({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <thead className="bg-muted/50">{children}</thead>;
}
function MdTh({ children }: Readonly<{ children?: React.ReactNode }>) {
  return (
    <th className="border border-border px-2 py-1.5 text-left font-semibold">
      {children}
    </th>
  );
}
function MdTd({ children }: Readonly<{ children?: React.ReactNode }>) {
  return (
    <td className="border border-border px-2 py-1.5 text-muted-foreground">
      {children}
    </td>
  );
}
function MdTr({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <tr className="even:bg-muted/30">{children}</tr>;
}
function MdPre({ children }: Readonly<{ children?: React.ReactNode }>) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-2 text-xs">
      {children}
    </pre>
  );
}
function MdUl({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <ul className="list-disc space-y-0.5 pl-4 text-xs">{children}</ul>;
}
function MdOl({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <ol className="list-decimal space-y-0.5 pl-4 text-xs">{children}</ol>;
}
function MdP({ children }: Readonly<{ children?: React.ReactNode }>) {
  return <p className="my-2 text-muted-foreground text-xs">{children}</p>;
}
function MdCode({
  className,
  children,
  ...props
}: Readonly<{ className?: string; children?: React.ReactNode }>) {
  if (!className) {
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 text-primary text-xs"
        {...props}
      >
        {children}
      </code>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}
function MdLi({
  children,
  ...props
}: Readonly<{ children?: React.ReactNode }>) {
  if (typeof children === "string") {
    if (children.startsWith("[ ]")) {
      return (
        <li className="flex items-start gap-2 text-xs" {...props}>
          <span className="mt-0.5 size-3 shrink-0 rounded border border-border" />
          <span className="text-muted-foreground">{children.slice(4)}</span>
        </li>
      );
    }
    if (children.startsWith("[x]") || children.startsWith("[X]")) {
      return (
        <li className="flex items-start gap-2 text-xs" {...props}>
          <CheckCircle className="mt-0.5 size-3 shrink-0 text-emerald-500" />
          <span className="text-muted-foreground line-through">
            {children.slice(4)}
          </span>
        </li>
      );
    }
  }
  return (
    <li className="text-muted-foreground text-xs" {...props}>
      {children}
    </li>
  );
}

function MdHr() {
  return <hr className="my-4 border-border/50" />;
}

function createMdImg(ticketId: string, repoPath: string) {
  return function MdImg({
    src,
    alt,
  }: React.ImgHTMLAttributes<HTMLImageElement>) {
    const imgSrc =
      typeof src === "string" ? transformImageSrc(src, ticketId, repoPath) : "";
    return (
      <Image
        alt={alt || ""}
        className="my-3 h-auto max-w-full rounded-lg"
        height={600}
        src={imgSrc}
        unoptimized
        width={800}
      />
    );
  };
}

/**
 * Memoized plan viewer content (no container) to prevent re-renders when chat input changes
 */
const PlanViewerContent = memo(function PlanViewerContent({
  ticketId,
  repoPath,
  plan,
  isLoading,
  showHeader = true,
}: Readonly<{
  ticketId: string;
  repoPath: string;
  plan: PlanResponse | undefined;
  isLoading: boolean;
  showHeader?: boolean;
}>) {
  const mdComponents = useMemo(
    () => ({
      h1: MdH1,
      h2: MdH2,
      h3: MdH3,
      table: MdTable,
      thead: MdThead,
      th: MdTh,
      td: MdTd,
      tr: MdTr,
      pre: MdPre,
      ul: MdUl,
      ol: MdOl,
      p: MdP,
      code: MdCode,
      li: MdLi,
      hr: MdHr,
      img: createMdImg(ticketId, repoPath),
    }),
    [ticketId, repoPath]
  );

  return (
    <>
      {/* Plan header - only shown when not in tab mode */}
      {showHeader && (
        <div className="shrink-0 border-border border-b bg-muted/30 px-5 py-4">
          <div className="flex items-center gap-3">
            <FileText className="size-5 text-primary" />
            <div>
              <h2 className="font-medium font-mono text-sm tracking-tight">
                implementation.plan
              </h2>
              <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
                {ticketId}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Plan content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!(isLoading || plan?.planExists) && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <FileText className="mb-3 size-8 text-muted-foreground/50" />
            <p className="font-mono text-muted-foreground text-sm">
              No plan available
            </p>
          </div>
        )}
        {!isLoading && plan?.planExists && (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-mono">
            <ReactMarkdown
              components={mdComponents}
              remarkPlugins={[remarkGfm]}
            >
              {plan.content || "No content available"}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </>
  );
});

/**
 * Transform <attached-images> blocks (server format) into markdown image syntax.
 * The server stores raw file paths; this converts them to API URLs for display.
 */
function transformAttachedImages(
  content: string,
  ticketId: string,
  repoPath: string
): string {
  return content.replaceAll(
    /<attached-images>[\s\S]*?<\/attached-images>/g,
    (match) => {
      const paths = match
        .replaceAll(/<\/?attached-images>/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.startsWith("/") && /\.(png|jpe?g|gif|webp)$/i.test(line)
        );

      return paths
        .map((filePath) => {
          const filename = filePath.split("/").pop() || "";
          const apiUrl = `/api/gateway/symphony/attachments/${encodeURIComponent(ticketId)}/${encodeURIComponent(filename)}?repo=${encodeURIComponent(repoPath)}`;
          return `![${filename}](${apiUrl})`;
        })
        .join("\n");
    }
  );
}

/**
 * Extract inline images (![alt](url)) from message content.
 * Returns the images and the text with images removed.
 */
function extractInlineImages(content: string): {
  text: string;
  images: { alt: string; url: string }[];
} {
  const images: { alt: string; url: string }[] = [];
  const text = content
    .replaceAll(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      images.push({ alt, url });
      return "";
    })
    .trim();
  return { text, images };
}

// Stable ReactMarkdown component overrides (defined outside component to avoid re-creation on each render)
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = getTextContent(children).replace(/\n$/, "");

    // Block code with language
    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs chat-code-block"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    // Block code without language (check if multiline)
    if (codeString.includes("\n")) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs chat-code-block"
          language="text"
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }

    // Inline code
    return (
      <code
        className="break-all rounded bg-muted-foreground/20 px-1.5 py-0.5 font-mono text-[12px] text-primary"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  p({ children }) {
    return <p className="font-mono text-[13px] leading-relaxed">{children}</p>;
  },
  ul({ children }) {
    return <ul className="list-disc pl-4 font-mono text-[13px]">{children}</ul>;
  },
  ol({ children }) {
    return (
      <ol className="list-decimal pl-4 font-mono text-[13px]">{children}</ol>
    );
  },
  li({ children }) {
    return <li className="font-mono text-[13px]">{children}</li>;
  },
  hr() {
    return <hr className="my-4 border-border/50" />;
  },
  a({ href, children }) {
    return (
      <a
        className="text-primary hover:underline"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
    );
  },
};

/**
 * Assistant message content with blocks and markdown
 */
function AssistantMessageContent({
  content,
  blocks,
  isStreaming = false,
}: Readonly<{
  content: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
}>) {
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());

  const toggleBlock = useCallback((id: string) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Separate thinking blocks from tool blocks (tool_use and tool_result)
  const { thinkingBlocks, toolBlocks } = useMemo(() => {
    const all = blocks?.filter((b) => b.type !== "text") || [];
    return {
      thinkingBlocks: all.filter((b) => b.type === "thinking"),
      toolBlocks: all.filter((b) => b.type !== "thinking"),
    };
  }, [blocks]);

  // Parse and strip <learnings-used> blocks
  const { cleanContent, learnings } = useMemo(
    () => parseLearningsUsed(content),
    [content]
  );

  return (
    <div className="prose prose-sm dark:prose-invert prose-headings:my-2 prose-li:my-0.5 prose-ol:my-1.5 prose-p:my-1.5 prose-ul:my-1.5 max-w-none">
      {/* Render thinking blocks individually */}
      {thinkingBlocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          {thinkingBlocks.map((block, idx) => {
            const blockId = block.id || `thinking-${idx}`;
            return (
              <CollapsibleBlock
                icon={Sparkles}
                id={blockId}
                isExpanded={expandedBlocks.has(blockId)}
                key={blockId}
                onToggle={toggleBlock}
                title="Extended thinking..."
                variant="thinking"
              >
                {block.thinking || ""}
              </CollapsibleBlock>
            );
          })}
        </div>
      )}

      {/* Render tool blocks grouped with collapsible previous operations */}
      {toolBlocks.length > 0 && (
        <div className="not-prose mb-2 space-y-2">
          <CollapsibleBlockGroup
            blocks={toolBlocks}
            expandedBlocks={expandedBlocks}
            onToggleBlock={toggleBlock}
          />
        </div>
      )}
      {/* Render text content */}
      {cleanContent && (
        <ReactMarkdown
          components={markdownComponents}
          remarkPlugins={[remarkGfm]}
        >
          {cleanContent}
        </ReactMarkdown>
      )}
      {isStreaming && (
        <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary" />
      )}
      {!isStreaming && learnings.length > 0 && (
        <div className="not-prose mt-2">
          <LearningsUsedDialog learnings={learnings} />
        </div>
      )}
    </div>
  );
}

/**
 * Individual message bubble component
 */
const MessageBubble = memo(
  function MessageBubble({
    message,
    index,
    isStreaming = false,
    isLastAssistantMessage = false,
    contextPercent,
    onSendAction,
    onCopy,
    onForward,
  }: Readonly<{
    message: ChatMessage;
    index: number;
    isStreaming?: boolean;
    isLastAssistantMessage?: boolean;
    contextPercent?: number | null;
    onSendAction?: (action: SuggestedAction) => void;
    onCopy?: (index: number) => void;
    onForward?: (index: number) => void;
  }>) {
    const isUser = message.role === "user";

    // Parse suggested actions from assistant messages
    // Always strip the actions block for display, but only show buttons for the last message
    const { actions, contentWithoutActions } = useMemo(() => {
      if (isUser || isStreaming) {
        return { actions: [], contentWithoutActions: message.content };
      }
      const parsed = parseSuggestedActions(message.content);
      // Only return actions if this is the last assistant message
      return {
        actions: isLastAssistantMessage ? parsed.actions : [],
        contentWithoutActions: stripAssistantProtocol(
          parsed.contentWithoutActions
        ),
      };
    }, [isUser, isStreaming, isLastAssistantMessage, message.content]);

    return (
      <ChatBubble
        actions={actions}
        contextPercent={isLastAssistantMessage ? contextPercent : undefined}
        forwardLabel="Forward to Codex"
        index={index}
        isStreaming={isStreaming}
        messageRole={message.role}
        onAction={onSendAction}
        onCopy={onCopy ? () => onCopy(index) : undefined}
        onForward={!isUser && onForward ? () => onForward(index) : undefined}
        roleLabel={isUser ? "you" : "claude"}
        timestamp={message.timestamp}
      >
        {isUser ? (
          <UserMessageContent content={message.content}>
            {(text) => (
              <ClosedLoopUserText mentions={message.mentions} text={text} />
            )}
          </UserMessageContent>
        ) : (
          // Assistant messages: blocks + markdown with syntax highlighting
          <AssistantMessageContent
            blocks={message.blocks}
            content={contentWithoutActions}
            isStreaming={isStreaming}
          />
        )}
      </ChatBubble>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.index === next.index &&
    prev.isStreaming === next.isStreaming &&
    prev.isLastAssistantMessage === next.isLastAssistantMessage &&
    prev.contextPercent === next.contextPercent &&
    (prev.onSendAction == null) === (next.onSendAction == null) &&
    (prev.onCopy == null) === (next.onCopy == null) &&
    (prev.onForward == null) === (next.onForward == null)
);

/**
 * Renders a single non-status chat message (debate, sender-labeled, or default).
 * Extracted to reduce cognitive complexity of the message list renderer.
 */
type ChatMessageItemProps = Readonly<{
  msg: ChatMessage;
  idx: number;
  messages: ChatMessage[];
  historyMessages: ChatMessage[];
  stream: ReturnType<typeof useChatStream>;
  debate: ReturnType<typeof useCodexDebate>;
  codexChatStream: ReturnType<typeof useChatStream>;
  sendActionMessage: (action: SuggestedAction) => void;
  handleCopyMessage: (index: number) => void;
  handleForwardMessage: (index: number) => void;
  handleForwardCodexMessage: (index: number) => void;
  canForward: boolean;
  savedContextPercent?: number | null;
}>;

function ChatMessageItem(props: ChatMessageItemProps) {
  const { msg, idx, messages, stream, debate, codexChatStream } = props;
  const lastAssistantIdx = findLastAssistantIndex(messages);
  const isAnyStreaming =
    stream.isStreaming ||
    !!debate.codexStream.pendingUserMessage ||
    !!codexChatStream.pendingUserMessage;
  const isLastAssistant = idx === lastAssistantIdx && !stream.isStreaming;
  const isLast = idx === messages.length - 1;
  const debateActions = debate.getDebateActions(msg, isLast, isAnyStreaming);

  if (debateActions.length > 0) {
    return renderDebateActionsBubble(props, debateActions);
  }

  if ((debate.debateMode && msg.sender) || msg.sender === "codex") {
    return renderSenderLabeledBubble(props, isLastAssistant, isAnyStreaming);
  }

  return renderDefaultBubble(props, isLastAssistant);
}

/** Render a ChatBubble for messages with active debate actions. */
function renderDebateActionsBubble(
  props: ChatMessageItemProps,
  debateActions: SuggestedAction[]
) {
  const {
    msg,
    idx,
    debate,
    sendActionMessage,
    handleCopyMessage,
    handleForwardMessage,
    handleForwardCodexMessage,
    canForward,
  } = props;
  const sender = debate.getEffectiveSender(msg);
  const contentWithoutActions = stripAssistantProtocol(msg.content);
  return (
    <ChatBubble
      actions={debateActions}
      forwardLabel={getForwardLabel(sender)}
      index={idx}
      messageRole={getSenderRole(sender, msg.role)}
      onAction={sendActionMessage}
      onCopy={() => handleCopyMessage(idx)}
      onForward={getForwardHandler(
        canForward,
        msg.role,
        sender,
        idx,
        handleForwardMessage,
        handleForwardCodexMessage
      )}
      sender={sender}
      timestamp={msg.timestamp}
    >
      <MessageContent blocks={msg.blocks} content={contentWithoutActions} />
    </ChatBubble>
  );
}

/** Render a ChatBubble for sender-labeled messages (codex in debate or @codex chat). */
function renderSenderLabeledBubble(
  props: ChatMessageItemProps,
  isLastAssistant: boolean,
  isAnyStreaming: boolean
) {
  const {
    msg,
    idx,
    sendActionMessage,
    handleCopyMessage,
    handleForwardMessage,
    handleForwardCodexMessage,
    canForward,
  } = props;
  const { actions: codexActions } = parseSuggestedActions(msg.content);
  const contentWithoutActions = stripAssistantProtocol(msg.content);
  return (
    <ChatBubble
      actions={isLastAssistant && !isAnyStreaming ? codexActions : undefined}
      forwardLabel={getForwardLabel(msg.sender)}
      index={idx}
      messageRole={getSenderRole(msg.sender, msg.role)}
      onAction={isLastAssistant ? sendActionMessage : undefined}
      onCopy={() => handleCopyMessage(idx)}
      onForward={getForwardHandler(
        canForward,
        msg.role,
        msg.sender,
        idx,
        handleForwardMessage,
        handleForwardCodexMessage
      )}
      sender={msg.sender}
      timestamp={msg.timestamp}
    >
      <MessageContent blocks={msg.blocks} content={contentWithoutActions} />
    </ChatBubble>
  );
}

/** Render the default MessageBubble for standard messages. */
function renderDefaultBubble(
  props: ChatMessageItemProps,
  isLastAssistant: boolean
) {
  const {
    msg,
    idx,
    historyMessages,
    sendActionMessage,
    handleCopyMessage,
    handleForwardMessage,
    canForward,
  } = props;
  const isInHistory = idx < historyMessages.length;
  return (
    <MessageBubble
      contextPercent={
        isLastAssistant
          ? (props.stream.contextPercent ??
            props.savedContextPercent ??
            undefined)
          : undefined
      }
      index={idx}
      isLastAssistantMessage={isLastAssistant}
      message={msg}
      onCopy={isInHistory ? handleCopyMessage : undefined}
      onForward={
        canForward && isInHistory && msg.role === "assistant"
          ? handleForwardMessage
          : undefined
      }
      onSendAction={isLastAssistant ? sendActionMessage : undefined}
    />
  );
}

/** Map sender to bubble role — codex messages display as "user" side. */
function getSenderRole(
  sender: string | undefined,
  fallbackRole: "user" | "assistant"
): "user" | "assistant" {
  return sender === "codex" ? "user" : fallbackRole;
}

/** Get the forward button label based on sender. */
function getForwardLabel(sender: string | undefined): string {
  return sender === "codex" ? "Forward to Claude" : "Forward to Codex";
}

/** Build the forward handler, or undefined if forwarding isn't available. */
function getForwardHandler(
  canForward: boolean,
  msgRole: string,
  sender: string | undefined,
  idx: number,
  handleForwardMessage: (index: number) => void,
  handleForwardCodexMessage: (index: number) => void
): (() => void) | undefined {
  if (!canForward || msgRole !== "assistant") {
    return undefined;
  }
  return sender === "codex"
    ? () => handleForwardCodexMessage(idx)
    : () => handleForwardMessage(idx);
}

/**
 * Find the index of the last assistant message in the array.
 */
function findLastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return i;
    }
  }
  return -1;
}

/**
 * Chat button to be placed in toolbars
 */
export function ClosedLoopChatButton({
  onClick,
  hasMessages = false,
}: Readonly<{
  onClick: () => void;
  hasMessages?: boolean;
}>) {
  return (
    <button
      className={cn(
        "relative flex size-8 items-center justify-center rounded-lg",
        "border border-border bg-muted",
        "text-muted-foreground hover:border-primary/30 hover:text-primary",
        "transition-all duration-200 hover:scale-105",
        "shadow-sm"
      )}
      onClick={onClick}
      title="Chat with ClosedLoop"
      type="button"
    >
      <MessageSquare className="size-4" />
      {hasMessages && (
        <span className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-background bg-primary" />
      )}
    </button>
  );
}

/**
 * Transform local file paths to API URLs for attachments
 */
function transformImageSrc(
  src: string,
  ticketId: string,
  repoPath: string
): string {
  // Match full path (.closedloop-ai/work/attachments/...) or relative path (attachments/...)
  const attachmentsMatch =
    /(?:\.closedloop-ai\/work\/)?attachments\/(.+)$/.exec(src);
  if (attachmentsMatch) {
    const filename = attachmentsMatch[1];
    return `/api/gateway/symphony/attachments/${encodeURIComponent(ticketId)}/${encodeURIComponent(filename)}?repo=${encodeURIComponent(repoPath)}`;
  }
  return src;
}

/* ---------- Extracted helpers to reduce ClosedLoopChat cognitive complexity ---------- */

/**
 * Build the message content to send (with optional context and image paths)
 * and the display content (with markdown image references).
 */
function buildMessageContents(
  trimmedInput: string,
  selectedContext: SelectedContext | null,
  uploadedImages: PendingImage[]
): { messageToSend: string; displayContent: string } {
  let messageToSend = trimmedInput;
  let displayContent = trimmedInput;

  if (selectedContext) {
    const fileAttr = selectedContext.file
      ? ` file="${selectedContext.file}"`
      : "";
    const contextBlock = `<context source="${selectedContext.source}"${fileAttr}>\n${selectedContext.text}\n</context>\n\n${trimmedInput}`;
    messageToSend = contextBlock;
    displayContent = contextBlock;
  }

  if (uploadedImages.length > 0) {
    const imagePaths = uploadedImages.map((img) => img.savedPath).join("\n");
    messageToSend += `\n\n<attached-images>\nThe user has attached the following images. Use the Read tool to view each image file:\n${imagePaths}\n</attached-images>`;
  }
  if (uploadedImages.length > 0) {
    const imgMarkdown = uploadedImages
      .map((img) => `![${img.file.name}](${img.apiUrl})`)
      .join("\n");
    displayContent = displayContent
      ? `${displayContent}\n\n${imgMarkdown}`
      : imgMarkdown;
  }

  return { messageToSend, displayContent };
}

/**
 * Placeholder text for the chat input based on active tab.
 */
function getInputPlaceholder(activeTab: LeftPaneTab): string {
  if (activeTab === "changes") {
    return "Ask about changes... (@ to mention files, paste images)";
  }
  if (activeTab === "comments") {
    return "Ask about PR comments... (@ to mention files, paste images)";
  }
  return "Ask about the plan... (@ to mention files, paste images)";
}

/**
 * Empty-state hint for messages area based on active tab.
 */
function getEmptyStateHint(activeTab: LeftPaneTab, isMobile: boolean): string {
  if (isMobile) {
    return "Ask questions or request changes";
  }
  if (activeTab === "changes") {
    return "Ask about changes on the left";
  }
  if (activeTab === "comments") {
    return "Ask about PR comments on the left";
  }
  return "Reference the plan on the left to ask questions";
}

/**
 * Tokenize text into plain text, mention, and inline code segments.
 */
type TokenType = "text" | "mention" | "code";

function findEarliestMention(
  remaining: string,
  mentions: string[]
): { idx: number; text: string } {
  let bestIdx = -1;
  let bestText = "";
  for (const m of mentions) {
    const idx = remaining.indexOf(m);
    if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestText = m;
    }
  }
  return { idx: bestIdx, text: bestText };
}

function pickEarliestToken(
  remaining: string,
  mentions: string[],
  codePattern: RegExp
): { idx: number; text: string; type: TokenType } | null {
  const mention = findEarliestMention(remaining, mentions);
  const codeExec = codePattern.exec(remaining);

  if (
    mention.idx >= 0 &&
    (codeExec === null || mention.idx <= codeExec.index)
  ) {
    return { idx: mention.idx, text: mention.text, type: "mention" };
  }
  if (codeExec !== null) {
    return { idx: codeExec.index, text: codeExec[0], type: "code" };
  }
  return null;
}

function tokenizeInput(
  text: string,
  mentions: string[]
): { text: string; type: TokenType }[] {
  const tokens: { text: string; type: TokenType }[] = [];
  let remaining = text;
  const codePattern = /```[\s\S]*?```|`[^`\n]+`/;

  while (remaining.length > 0) {
    const earliest = pickEarliestToken(remaining, mentions, codePattern);
    if (earliest === null) {
      tokens.push({ text: remaining, type: "text" });
      break;
    }

    if (earliest.idx > 0) {
      tokens.push({ text: remaining.slice(0, earliest.idx), type: "text" });
    }
    tokens.push({ text: earliest.text, type: earliest.type });
    remaining = remaining.slice(earliest.idx + earliest.text.length);
  }

  return tokens;
}

/**
 * Strip surrounding backticks from a code token for display.
 * For triple-backtick blocks, also extracts an optional language hint
 * (e.g., ```bash ... ``` → { code: "...", lang: "bash" }).
 */
function stripBackticks(s: string): { code: string; lang: string | null } {
  if (s.startsWith("```") && s.endsWith("```")) {
    const inner = s.slice(3, -3);
    const langMatch = /^(\w+)\n/.exec(inner);
    if (langMatch) {
      return { code: inner.slice(langMatch[0].length), lang: langMatch[1] };
    }
    // Also handle language on same line with no newline: ```bash code```
    const inlineMatch = /^(\w+)\s/.exec(inner);
    if (inlineMatch) {
      return { code: inner.slice(inlineMatch[0].length), lang: inlineMatch[1] };
    }
    return { code: inner, lang: null };
  }
  if (s.startsWith("`") && s.endsWith("`")) {
    return { code: s.slice(1, -1), lang: null };
  }
  return { code: s, lang: null };
}

/**
 * Render user message text with styled mentions and inline code.
 */
function renderUserMessageText(text: string, mentions: string[]) {
  const tokens = addTokenOffsets(tokenizeInput(text, mentions));
  return (
    <>
      {tokens.map((tok) => {
        if (tok.type === "mention") {
          return (
            <code
              className="rounded bg-white/20 px-1 py-0.5 text-[12px]"
              key={tok.offset}
            >
              {tok.text}
            </code>
          );
        }
        if (tok.type === "code") {
          const { code, lang } = stripBackticks(tok.text);
          if (tok.text.startsWith("```")) {
            if (lang) {
              return (
                <SyntaxHighlighter
                  className="!my-2 !rounded-lg !text-xs chat-code-block"
                  key={tok.offset}
                  language={lang}
                  PreTag="div"
                  style={oneDark}
                >
                  {code}
                </SyntaxHighlighter>
              );
            }
            return (
              <pre
                className="my-2 whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-white/90 text-xs"
                key={tok.offset}
              >
                <code>{code}</code>
              </pre>
            );
          }
          return (
            <code
              className="break-all rounded border border-white/10 bg-white/15 px-1.5 py-0.5 font-mono text-[12px]"
              key={tok.offset}
            >
              {code}
            </code>
          );
        }
        return (
          <span key={tok.offset}>{highlightAtCodex(tok.text, tok.offset)}</span>
        );
      })}
    </>
  );
}

/**
 * Highlight @codex mentions within plain text fragments.
 */
function highlightAtCodex(text: string, baseOffset: number): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(/@codex\b/gi)) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span
        className="rounded bg-white/20 px-1 py-0.5 font-semibold"
        key={`${baseOffset}-codex-${match.index}`}
      >
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) {
    return text;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

/**
 * Render input overlay with visible text, highlighted mentions/code,
 * and backtick delimiters hidden. The textarea text is made transparent
 * when this overlay is active, so this layer provides the visible text.
 */
function renderChatHighlights(text: string, mentions: string[]) {
  // Highlight @codex at the start of input
  const codexPrefixMatch = /^@codex\s/i.exec(text);
  if (codexPrefixMatch) {
    const prefix = codexPrefixMatch[0];
    const rest = text.slice(prefix.length);
    const restTokens = addTokenOffsets(tokenizeInput(rest, mentions));
    return (
      <>
        <span className="rounded bg-[oklch(0.91_0.008_260)] text-[oklch(0.45_0.025_260)] dark:bg-[oklch(0.25_0.012_260)] dark:text-[oklch(0.65_0.025_260)]">
          {prefix.trimEnd()}
        </span>
        <span> </span>
        {restTokens.map((tok) => {
          if (tok.type === "mention") {
            return (
              <span className="rounded bg-sky-500/25 px-0.5" key={tok.offset}>
                {tok.text}
              </span>
            );
          }
          if (tok.type === "code") {
            return (
              <span className="rounded bg-foreground/10" key={tok.offset}>
                {tok.text}
              </span>
            );
          }
          return <span key={tok.offset}>{tok.text}</span>;
        })}
      </>
    );
  }

  // Highlight slash commands at the start of input
  const slashMatch = /^\/\S*$/i.exec(text);
  if (slashMatch) {
    return (
      <span className="rounded bg-violet-500/15 text-violet-600 dark:text-violet-400">
        {text}
      </span>
    );
  }

  const tokens = addTokenOffsets(tokenizeInput(text, mentions));
  if (tokens.length === 0) {
    return <span>{"\u00A0"}</span>;
  }
  return (
    <>
      {tokens.map((tok) => {
        if (tok.type === "mention") {
          return (
            <span className="rounded bg-sky-500/25 px-0.5" key={tok.offset}>
              {tok.text}
            </span>
          );
        }
        if (tok.type === "code") {
          return (
            <span className="rounded bg-foreground/10" key={tok.offset}>
              {tok.text}
            </span>
          );
        }
        return <span key={tok.offset}>{tok.text}</span>;
      })}
    </>
  );
}

/**
 * Attach a unique character offset to each token for use as a React key.
 * Tokens are non-overlapping contiguous substrings, so each offset is unique.
 */
function addTokenOffsets(
  tokens: { text: string; type: TokenType }[]
): { text: string; type: TokenType; offset: number }[] {
  let pos = 0;
  return tokens.map((tok) => {
    const offset = pos;
    pos += tok.text.length;
    return { ...tok, offset };
  });
}

const SLASH_COMMANDS = [
  { command: "/debate", description: "Start a Claude vs Codex debate" },
  { command: "/end-debate", description: "End the current debate" },
  { command: "/reflect", description: "Extract learnings from this session" },
  { command: "/merge", description: "Merge <branch> into current branch" },
  { command: "/rebase", description: "Rebase current branch onto <branch>" },
] as const;

function buildMergePrompt(branch: string) {
  return `Please merge ${branch} into the current branch. Follow these steps:

1. Run \`git fetch origin\` to get the latest changes
2. Show the current branch name with \`git branch --show-current\`
3. Run \`git merge ${branch}\`
4. If the merge is clean:
   - Summarize what was merged (number of commits, key changes)
   - Offer to push with a suggested action button
5. If there are conflicts:
   - List all conflicted files
   - For each conflict, show the relevant diff hunks and explain what each side changed
   - Ask for approval before resolving any conflicts
   - After resolving, offer to push`;
}

function buildRebasePrompt(branch: string) {
  return `Please rebase the current branch onto ${branch}. Follow these steps:

1. Run \`git fetch origin\` to get the latest changes
2. Show the current branch name with \`git branch --show-current\`
3. Run \`git rebase ${branch}\`
4. If the rebase is clean:
   - Summarize what happened (number of commits replayed, key changes)
   - Offer to force-push with \`--force-with-lease\` using a suggested action button
5. If there are conflicts:
   - List all conflicted files
   - For each conflict, show the relevant diff hunks and explain what each side changed
   - Ask for approval before resolving any conflicts
   - After resolving each step, continue the rebase with \`git rebase --continue\`
   - After the full rebase completes, offer to force-push with \`--force-with-lease\``;
}

/**
 * Symphony-specific user text renderer with inline images, mentions, and @codex highlighting.
 */
function ClosedLoopUserText({
  text,
  mentions,
}: Readonly<{ text: string; mentions?: string[] }>) {
  const { text: userText, images } = extractInlineImages(text);
  const hasMentionsOrCode =
    (mentions?.length ?? 0) > 0 ||
    userText.includes("`") ||
    /@codex\b/i.test(userText);

  return (
    <>
      {userText && (
        <div className="whitespace-pre-wrap break-words">
          {hasMentionsOrCode
            ? renderUserMessageText(userText, mentions ?? [])
            : userText}
        </div>
      )}
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5", userText && "mt-2")}>
          {images.map((img) => (
            <Image
              alt={img.alt}
              className="h-16 max-w-[120px] rounded-md border border-white/20 object-cover"
              height={64}
              key={img.url}
              src={img.url}
              unoptimized
              width={120}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Look backwards from cursor for an @ that starts a mention.
 * Returns the index of @ if found, or -1.
 */
function ClosedLoopChatHeader({
  isStreaming,
  debateMode,
  autoDebate,
  currentRound,
  maxRounds,
  learningsStatus,
  learningsCount,
}: Readonly<{
  isStreaming: boolean;
  debateMode: boolean;
  autoDebate: boolean;
  currentRound: number;
  maxRounds: number;
  learningsStatus: string;
  learningsCount: number;
}>) {
  return (
    <div className="relative shrink-0 border-border border-b bg-muted/30 px-5 py-4 pr-10">
      <div className="flex items-center gap-3">
        <div className="relative">
          <MessageSquare className="size-5 text-primary" />
          {isStreaming && (
            <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-primary" />
          )}
        </div>
        <div className="flex-1">
          <h2 className="font-medium font-mono text-sm tracking-tight">
            closedloop.chat
          </h2>
          {debateMode ? (
            <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
              debate mode active
              {autoDebate && ` · Round ${currentRound}/${maxRounds}`}
            </p>
          ) : (
            <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
              ask questions or request changes
            </p>
          )}
        </div>
      </div>
      {learningsStatus === "processing" && (
        <span
          className="absolute right-2 bottom-1.5 flex items-center gap-1 text-muted-foreground text-xs"
          title="Extracting learnings from this conversation..."
        >
          <Brain className="h-3.5 w-3.5 animate-pulse" />
        </span>
      )}
      {learningsStatus === "completed" && learningsCount > 0 && (
        <span
          className="absolute right-2 bottom-1.5 flex items-center gap-1 text-muted-foreground text-xs"
          title={`${learningsCount} learning${learningsCount === 1 ? "" : "s"} captured from this conversation`}
        >
          <Brain className="h-3.5 w-3.5" />
          {learningsCount}
        </span>
      )}
    </div>
  );
}

type StreamingBubbleProps = Readonly<{
  stream: ReturnType<typeof useChatStream>;
  debateMode: boolean;
  codexDebateMsg: ChatMessage | null;
  codexChatMsg: ChatMessage | null;
  expandedStreamingBlocks: Set<string>;
  onToggleStreamingBlock: (id: string) => void;
  streamStartedAt: string;
  codexDebateStreamStartedAt: string;
  codexChatStreamStartedAt: string;
}>;

function StreamingBubble({
  stream,
  debateMode,
  codexDebateMsg,
  codexChatMsg,
  expandedStreamingBlocks,
  onToggleStreamingBlock,
  streamStartedAt,
  codexDebateStreamStartedAt,
  codexChatStreamStartedAt,
}: StreamingBubbleProps) {
  return (
    <>
      {stream.isStreaming &&
        (stream.streamingContent || stream.streamingBlocks.length > 0) && (
          <div className="flex flex-col items-start gap-1">
            {/* Role indicator */}
            <div className="flex items-center gap-2 px-1">
              <span className="font-mono text-[10px] text-primary uppercase tracking-wider">
                {debateMode ? "Claude" : "closedloop.dev"}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {formatTime(streamStartedAt)}
              </span>
            </div>
            {/* Streaming content bubble */}
            <div
              className={cn(
                "min-w-0 max-w-[90%] overflow-hidden rounded-xl px-4 py-2.5 text-sm leading-relaxed",
                "border-primary/30 bg-[#E5E5EA] text-foreground dark:bg-[#38383D]"
              )}
            >
              {stream.streamingBlocks.length > 0 && (
                <StreamingBlocks
                  blocks={stream.streamingBlocks}
                  expandedBlocks={expandedStreamingBlocks}
                  onToggleBlock={onToggleStreamingBlock}
                />
              )}
              {stream.streamingContent && (
                <div className="prose prose-sm dark:prose-invert prose-headings:my-2 prose-li:my-0.5 prose-ol:my-1.5 prose-p:my-1.5 prose-ul:my-1.5 max-w-none">
                  <ReactMarkdown
                    components={markdownComponents}
                    remarkPlugins={[remarkGfm]}
                  >
                    {stream.streamingContent}
                  </ReactMarkdown>
                  <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary" />
                </div>
              )}
            </div>
          </div>
        )}
      {stream.isStreaming &&
        !stream.streamingContent &&
        stream.streamingBlocks.length === 0 &&
        !stream.error && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <div className="flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
            </div>
            <span className="font-mono text-muted-foreground text-xs">
              thinking...
            </span>
          </div>
        )}
      {codexDebateMsg && (
        <ChatBubble
          isStreaming
          messageRole="assistant"
          sender="codex"
          timestamp={codexDebateStreamStartedAt}
        >
          <MessageContent
            blocks={codexDebateMsg.blocks}
            content={codexDebateMsg.content}
            isStreaming
          />
        </ChatBubble>
      )}
      {codexChatMsg && (
        <ChatBubble
          isStreaming
          messageRole="assistant"
          sender="codex"
          timestamp={codexChatStreamStartedAt}
        >
          <MessageContent
            blocks={codexChatMsg.blocks}
            content={codexChatMsg.content}
            isStreaming
          />
        </ChatBubble>
      )}
      {stream.error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 font-mono text-red-600 text-xs dark:text-red-400">
          Error: {stream.error}
        </div>
      )}
    </>
  );
}

/**
 * Renders thinking and tool blocks inside the streaming bubble.
 */
function StreamingBlocks({
  blocks,
  expandedBlocks,
  onToggleBlock,
}: Readonly<{
  blocks: ContentBlock[];
  expandedBlocks: Set<string>;
  onToggleBlock: (id: string) => void;
}>) {
  const thinkingBlocks = blocks.filter((b) => b.type === "thinking");
  const toolBlocks = blocks.filter((b) => b.type !== "thinking");
  return (
    <div className="mb-2 space-y-2">
      {thinkingBlocks.map((block) => {
        const blockId = block.id || `thinking-${block.thinking?.slice(0, 20)}`;
        return (
          <CollapsibleBlock
            icon={Sparkles}
            id={blockId}
            isExpanded={expandedBlocks.has(blockId)}
            key={blockId}
            onToggle={onToggleBlock}
            title="Extended thinking..."
            variant="thinking"
          >
            {block.thinking ||
              (typeof block.content === "string" ? block.content : "") ||
              ""}
          </CollapsibleBlock>
        );
      })}
      {toolBlocks.length > 0 && (
        <CollapsibleBlockGroup
          blocks={toolBlocks}
          expandedBlocks={expandedBlocks}
          onToggleBlock={onToggleBlock}
        />
      )}
    </div>
  );
}

type ChatMessagesAreaProps = Readonly<{
  isLoadingHistory: boolean;
  messages: ChatMessage[];
  historyMessages: ChatMessage[];
  stream: ReturnType<typeof useChatStream>;
  debate: ReturnType<typeof useCodexDebate>;
  codexChatStream: ReturnType<typeof useChatStream>;
  sendActionMessage: (action: SuggestedAction) => void;
  handleCopyMessage: (index: number) => void;
  handleForwardMessage: (index: number) => void;
  handleForwardCodexMessage: (index: number) => void;
  canForward: boolean;
  expandedStreamingBlocks: Set<string>;
  onToggleStreamingBlock: (id: string) => void;
  activeTab: LeftPaneTab;
  isMobile: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  savedContextPercent?: number | null;
}>;

function ChatMessagesArea({
  isLoadingHistory,
  messages,
  historyMessages,
  stream,
  debate,
  codexChatStream,
  sendActionMessage,
  handleCopyMessage,
  handleForwardMessage,
  handleForwardCodexMessage,
  canForward,
  expandedStreamingBlocks,
  onToggleStreamingBlock,
  activeTab,
  isMobile,
  messagesEndRef,
  savedContextPercent,
}: ChatMessagesAreaProps) {
  const isEmpty =
    !isLoadingHistory && messages.length === 0 && !stream.isStreaming;
  const hasMessages = !(isLoadingHistory || isEmpty);

  return (
    <div className="chat-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      {isLoadingHistory && (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {isEmpty && (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
            <Sparkles className="size-5 text-muted-foreground" />
          </div>
          <p className="font-mono text-muted-foreground text-sm">
            No messages yet
          </p>
          <p className="mt-1 max-w-[240px] text-muted-foreground/70 text-xs">
            {getEmptyStateHint(activeTab, isMobile)}
          </p>
        </div>
      )}
      {hasMessages && (
        <>
          {messages.map((msg, idx) => {
            const indicator = STATUS_INDICATORS[msg.content];
            if (indicator) {
              return (
                <div
                  className={`flex justify-center ${indicator.py} fade-in animate-in duration-300`}
                  key={msg.id}
                  style={{ animationDelay: `${idx * 50}ms` }}
                >
                  <span
                    className={`font-mono text-[11px] ${indicator.className} italic`}
                  >
                    {indicator.text}
                  </span>
                </div>
              );
            }

            return (
              <ChatMessageItem
                canForward={canForward}
                codexChatStream={codexChatStream}
                debate={debate}
                handleCopyMessage={handleCopyMessage}
                handleForwardCodexMessage={handleForwardCodexMessage}
                handleForwardMessage={handleForwardMessage}
                historyMessages={historyMessages}
                idx={idx}
                key={msg.id}
                messages={messages}
                msg={msg}
                savedContextPercent={savedContextPercent}
                sendActionMessage={sendActionMessage}
                stream={stream}
              />
            );
          })}
          <StreamingBubble
            codexChatMsg={codexChatStream.pendingUserMessage}
            codexChatStreamStartedAt={codexChatStream.streamStartedAt}
            codexDebateMsg={debate.codexStream.pendingUserMessage}
            codexDebateStreamStartedAt={debate.codexStream.streamStartedAt}
            debateMode={debate.debateMode}
            expandedStreamingBlocks={expandedStreamingBlocks}
            onToggleStreamingBlock={onToggleStreamingBlock}
            stream={stream}
            streamStartedAt={stream.streamStartedAt}
          />
          <div ref={messagesEndRef} />
        </>
      )}
    </div>
  );
}

type ClosedLoopChatInputAreaProps = Readonly<{
  selectedContext: SelectedContext | null;
  onClearContext: () => void;
  pendingImages: PendingImage[];
  onRemoveImage: (id: string) => void;
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  mentionState: MentionState | null;
  hasContextRepos: boolean | undefined;
  mentionRepos: { name: string; path: string }[];
  onFileSelect: (file: string) => void;
  onCloseMention: () => void;
  onMentionIndexChange: (index: number) => void;
  onMentionFilesChange: (files: string[]) => void;
  ticketId: string;
  repoPath: string;
  slash: ReturnType<typeof useSlashCommands>;
  input: string;
  selectedMentions: string[];
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  inputContainerRef: React.RefObject<HTMLDivElement | null>;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  activeTab: LeftPaneTab;
  isAnyStreaming: boolean;
  canSend: boolean | "" | 0;
  onSend: () => void;
  onStop: () => void;
  debateMode: boolean;
  autoDebate: boolean;
  onToggleAutoDebate: () => void;
  messageCount: number;
  historyCount: number;
  onClearChat: () => void;
}>;

function ClosedLoopChatInputArea({
  selectedContext,
  onClearContext,
  pendingImages,
  onRemoveImage,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  mentionState,
  hasContextRepos,
  mentionRepos,
  onFileSelect,
  onCloseMention,
  onMentionIndexChange,
  onMentionFilesChange,
  ticketId,
  repoPath,
  slash,
  input,
  selectedMentions,
  inputRef,
  inputContainerRef,
  onInputChange,
  onKeyDown,
  onPaste,
  activeTab,
  isAnyStreaming,
  canSend,
  onSend,
  onStop,
  debateMode,
  autoDebate,
  onToggleAutoDebate,
  messageCount,
  historyCount,
  onClearChat,
}: ClosedLoopChatInputAreaProps) {
  const needsHighlight =
    selectedMentions.length > 0 ||
    input.includes("`") ||
    /^@codex\s/i.test(input) ||
    /^\/\S*$/i.test(input);

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Fieldset intentionally acts as the chat image drop zone.
    <fieldset
      aria-label="Message input with image drop zone"
      className={cn(
        "shrink-0 border-border border-t bg-muted/30 transition-all duration-200",
        isDragOver && "bg-primary/5 ring-2 ring-primary/50 ring-inset"
      )}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Selected context display */}
      {selectedContext && (
        <div className="mx-4 mt-3 mb-0 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5">
          <div className="flex items-start gap-2">
            <Quote className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 font-mono text-[10px] text-amber-600/70 dark:text-amber-400/70">
                from {selectedContext.source}
                {selectedContext.file && ` · ${selectedContext.file}`}
              </div>
              <p className="line-clamp-2 font-mono text-amber-900 text-xs dark:text-amber-100">
                {selectedContext.text}
              </p>
            </div>
            <button
              className="shrink-0 text-amber-600/60 transition-colors hover:text-amber-600 dark:text-amber-400/60 dark:hover:text-amber-400"
              onClick={onClearContext}
              title="Remove context"
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Image thumbnail strip */}
      {pendingImages.length > 0 && (
        <div className="mx-4 mt-3 flex flex-wrap gap-2">
          {pendingImages.map((img) => (
            <div
              className="group/thumb relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border bg-muted"
              key={img.id}
              // TODO: preview disabled — Radix Dialog captures pointer events
            >
              <Image
                alt={img.file.name}
                className="size-full object-cover"
                height={48}
                src={img.thumbnailUrl}
                unoptimized
                width={48}
              />
              {/* Upload spinner overlay */}
              {img.status === "uploading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <Loader2 className="size-4 animate-spin text-white" />
                </div>
              )}
              {/* Error overlay */}
              {img.status === "error" && (
                <div
                  className="absolute inset-0 flex items-center justify-center bg-red-500/40"
                  title={img.error}
                >
                  <AlertCircle className="size-4 text-white" />
                </div>
              )}
              {/* Remove button on hover */}
              <button
                className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/thumb:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveImage(img.id);
                }}
                type="button"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="mx-4 mt-3 rounded-lg border-2 border-primary/40 border-dashed bg-primary/5 p-3 text-center">
          <ImageIcon className="mx-auto mb-1 size-5 text-primary/60" />
          <p className="font-mono text-primary/70 text-xs">Drop images here</p>
        </div>
      )}

      <div className="relative flex items-end gap-3 p-4 pt-3">
        <span className="shrink-0 pb-2.5 font-bold font-mono text-primary text-sm">
          {">"}
        </span>
        <div className="relative flex-1" ref={inputContainerRef}>
          {mentionState?.isOpen &&
            (hasContextRepos ? (
              <RepoFileAutocomplete
                isOpen={mentionState.isOpen}
                onClose={onCloseMention}
                onFilesChange={(files) => {
                  onMentionFilesChange(files.map((f) => f.display));
                }}
                onSelect={(display) => onFileSelect(display)}
                onSelectedIndexChange={onMentionIndexChange}
                query={mentionState.query}
                repos={mentionRepos}
                selectedIndex={mentionState.selectedIndex}
              />
            ) : (
              <FileMentionAutocomplete
                isOpen={mentionState.isOpen}
                onClose={onCloseMention}
                onFilesChange={onMentionFilesChange}
                onSelect={onFileSelect}
                onSelectedIndexChange={onMentionIndexChange}
                query={mentionState.query}
                repoPath={repoPath}
                selectedIndex={mentionState.selectedIndex}
                ticketId={ticketId}
              />
            ))}
          {/* Slash command autocomplete dropdown */}
          {slash.slashState?.isOpen && slash.filteredCommands.length > 0 && (
            <SlashCommandDropdown
              commands={slash.filteredCommands}
              onSelect={slash.selectCommand}
              selectedIndex={slash.slashState.selectedIndex}
            />
          )}
          {needsHighlight && (
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-0 py-2 pr-10 font-mono text-sm leading-relaxed",
                "pointer-events-none overflow-hidden whitespace-pre-wrap break-words"
              )}
            >
              {renderChatHighlights(input, selectedMentions)}
            </div>
          )}
          <textarea
            className={cn(
              "block w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground",
              "py-2 pr-10 font-mono leading-relaxed",
              "focus:outline-none focus:ring-0",
              needsHighlight && "text-transparent caret-foreground"
            )}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={getInputPlaceholder(activeTab)}
            ref={inputRef}
            rows={1}
            spellCheck={false}
            style={{
              minHeight: "40px",
              maxHeight: "50vh",
              overflow: "hidden",
            }}
            value={input}
          />
          {isAnyStreaming ? (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "cursor-pointer transition-all duration-200",
                "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
              )}
              onClick={onStop}
              title="Stop response"
              type="button"
            >
              <Square className="size-2.5 fill-current" />
            </button>
          ) : (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "transition-all duration-200",
                canSend
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
                  : "cursor-not-allowed bg-muted text-muted-foreground"
              )}
              disabled={!canSend}
              onClick={onSend}
              type="button"
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {debateMode && (
        <div className="mt-2 flex items-center justify-end gap-1.5 px-5">
          <span className="font-mono text-[10px] text-muted-foreground">
            Full-auto
          </span>
          <button
            aria-checked={autoDebate}
            aria-label="Full-auto debate mode"
            className={cn(
              "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border border-border transition-colors",
              autoDebate ? "bg-primary" : "bg-muted"
            )}
            onClick={onToggleAutoDebate}
            role="switch"
            title="Allow Claude & Codex to hash it out back and forth"
            type="button"
          >
            <span
              className={cn(
                "pointer-events-none block size-3 rounded-full bg-background shadow-sm transition-transform",
                autoDebate ? "translate-x-3" : "translate-x-0"
              )}
            />
          </button>
        </div>
      )}
      <div
        className={cn(
          "flex items-center justify-between px-5",
          debateMode ? "mt-1" : "mt-2"
        )}
      >
        <span className="font-mono text-[10px] text-muted-foreground">
          Shift+Enter for new line
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {messageCount} message{messageCount === 1 ? "" : "s"}
          </span>
          {historyCount > 0 && (
            <button
              className="cursor-pointer font-mono text-[10px] text-muted-foreground/50 transition-colors hover:text-destructive"
              onClick={onClearChat}
              title="Clear chat history"
              type="button"
            >
              clear
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}

function toggleSetItem<T>(set: Set<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) {
    next.delete(item);
  } else {
    next.add(item);
  }
  return next;
}

function detectMentionStart(text: string, cursorPos: number): number {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const char = text[i];
    if (char === "@") {
      // @ at start or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1])) {
        return i;
      }
      return -1;
    }
    // Stop if we hit whitespace (no @ in this word)
    if (/\s/.test(char)) {
      return -1;
    }
  }
  return -1;
}
