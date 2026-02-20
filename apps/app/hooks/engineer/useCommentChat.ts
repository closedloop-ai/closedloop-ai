"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ContentBlock } from "@/components/engineer/chat";
import type { PRComment } from "@/components/engineer/PRCommentCard";
import { getWorktreePath, parseLearningsUsed } from "@/lib/engineer/chat-utils";
import {
  markCommentAddressed,
  markCommentResponded,
  resetCommentStatus,
} from "@/lib/engineer/pr-comment-tracker";
import { gitStatusOptions } from "@/lib/engineer/queries/git";
import { queryKeys } from "@/lib/engineer/queries/keys";
import {
  type ChatMessage,
  commentChatHistoryOptions,
} from "@/lib/engineer/queries/symphony";

export type UseCommentChatOptions = {
  commentId: string;
  ticketId: string;
  repoPath: string;
  prNumber: number;
  branchName?: string;
  comment: PRComment;
  replies?: PRComment[];
  enabled?: boolean;
  autoStart?: boolean;
  onResolved?: () => void;
  onChatCleared?: () => void;
};

export type UseCommentChatReturn = {
  // State
  input: string;
  setInput: (value: string) => void;
  isStreaming: boolean;
  isWaitingForResponse: boolean;
  /** Stable timestamp captured once when streaming begins */
  streamStartedAt: string;
  /** Context window usage percentage (0-100), updated after each turn */
  contextPercent: number | null;
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  error: string | null;
  hasAcceptedChanges: boolean;
  isCommitting: boolean;
  hasResponded: boolean;
  isHeaderCollapsed: boolean;
  toggleHeaderCollapse: () => void;

  // Queries
  history: { messages: ChatMessage[] } | undefined;
  isLoadingHistory: boolean;
  isFetchingHistory: boolean;
  gitFiles:
    | { modified: string[]; created: string[]; deleted: string[] }
    | undefined;
  hasChangedFiles: boolean;

  // Computed
  messages: ChatMessage[];
  historyMessageCount: number;
  worktreePath: string;

  // Actions
  sendMessage: (
    messageText: string,
    overrideDisplayContent?: string
  ) => Promise<void>;
  handleStop: () => void;
  handleSend: () => void;
  handleAcceptChanges: () => void;
  handleCommitAndResolve: () => Promise<void>;
  handleSendResponse: (
    responseText: string,
    messageId: string
  ) => Promise<void>;
  handleDeleteMessage: (index: number) => Promise<void>;
  handleClearChat: () => Promise<void>;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  triggerLearningsExtraction: () => void;

  // Refs
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;

  // Learnings
  learningsStatus: "none" | "processing" | "completed";
  learningsCount: number;
  pollLearningsStatus: () => void;
};

/**
 * Hook for managing comment-specific chat state and actions.
 * Extracted from CommentChatDialog for reuse in CommentChat.
 */
export function useCommentChat({
  ticketId,
  repoPath,
  prNumber,
  branchName,
  comment,
  replies,
  enabled = true,
  autoStart = true,
  onResolved,
  onChatCleared,
}: UseCommentChatOptions): UseCommentChatReturn {
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStartedAt, setStreamStartedAt] = useState("");
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingBlocks, setStreamingBlocks] = useState<ContentBlock[]>([]);
  const [pendingUserMessage, setPendingUserMessage] =
    useState<ChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasAcceptedChanges, setHasAcceptedChanges] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  const [hasAutoStarted, setHasAutoStarted] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(true);
  const [learningsStatus, setLearningsStatus] = useState<
    "none" | "processing" | "completed"
  >("none");
  const [learningsCount, setLearningsCount] = useState(0);

  const toggleHeaderCollapse = useCallback(
    () => setIsHeaderCollapsed((prev) => !prev),
    []
  );
  const hadChangesRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const learningsPollingRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const queryClient = useQueryClient();

  // worktreePath starts as a client-side guess; updated by the server's
  // worktree_resolved event once the actual effective dir is known.
  const [worktreePath, setWorktreePath] = useState(() =>
    getWorktreePath(repoPath, ticketId)
  );

  // Build query-string suffix for branch-aware API calls
  const branchParams = branchName
    ? `&branch=${encodeURIComponent(branchName)}&prNumber=${prNumber}`
    : "";

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Load comment-specific chat history
  const {
    data: history,
    isLoading: isLoadingHistory,
    isFetching: isFetchingHistory,
  } = useQuery({
    ...commentChatHistoryOptions(
      ticketId,
      comment.id,
      repoPath,
      {
        author: comment.author,
        body: comment.body,
        path: comment.path,
        line: comment.line,
      },
      branchName,
      prNumber
    ),
    enabled,
    // Poll while a response may still be generating server-side.
    // - Regular flow: last message is from user → poll until assistant appears
    // - Debate flow: last message is a recent debate turn → poll for counter-response
    refetchInterval: (query) => {
      if (isStreaming) {
        return false;
      }
      const msgs = query.state.data?.messages;
      const last = msgs?.[msgs.length - 1];
      if (!last) {
        return false;
      }
      if (last.role === "user") {
        return 2000;
      }
      // During debate, poll for counter-responses from the other side (up to 5 min)
      if (
        (last.sender === "claude" || last.sender === "codex") &&
        last.timestamp
      ) {
        const age = Date.now() - new Date(last.timestamp).getTime();
        if (age < 5 * 60 * 1000) {
          return 3000;
        }
      }
      return false;
    },
  });

  // Query git status to detect changed files
  const { data: gitFiles } = useQuery({
    ...gitStatusOptions(worktreePath),
    enabled,
    refetchInterval: 5000,
  });

  // Calculate if there are changed files to show
  const hasChangedFiles = gitFiles
    ? gitFiles.modified.length +
        gitFiles.created.length +
        gitFiles.deleted.length >
      0
    : false;

  // Latch: once we see changes, remember it for the rest of the session
  if (hasChangedFiles) {
    hadChangesRef.current = true;
  }

  // Scroll helpers
  const initialScrollDone = useRef(false);
  const scrollToBottom = useCallback((instant?: boolean) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  // One-time instant scroll when history first loads
  useEffect(() => {
    if (
      !initialScrollDone.current &&
      history?.messages &&
      history.messages.length > 0
    ) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => scrollToBottom(true));
    }
  }, [history?.messages, scrollToBottom]);

  // Scroll to bottom when the user sends a message
  useEffect(() => {
    if (pendingUserMessage) {
      scrollToBottom();
    }
  }, [pendingUserMessage, scrollToBottom]);

  // Focus input when enabled
  useEffect(() => {
    if (enabled && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [enabled]);

  // Learnings polling
  const stopLearningsPolling = useCallback(() => {
    if (learningsPollingRef.current) {
      clearInterval(learningsPollingRef.current);
      learningsPollingRef.current = null;
    }
  }, []);

  const pollLearningsStatus = useCallback(() => {
    stopLearningsPolling();
    setLearningsStatus("processing");

    learningsPollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/engineer/symphony/learnings-status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`
        );
        const data = await res.json();
        if (data.status === "completed") {
          setLearningsStatus("completed");
          setLearningsCount(data.count || 0);
          stopLearningsPolling();
        } else if (data.status === "error") {
          setLearningsStatus("none");
          stopLearningsPolling();
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000);

    // Stop polling after 2 minutes max; reset status if still processing
    setTimeout(() => {
      stopLearningsPolling();
      setLearningsStatus((prev) => (prev === "processing" ? "none" : prev));
    }, 120_000);
  }, [ticketId, repoPath, stopLearningsPolling]);

  // Abort in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Cleanup polling on unmount
  useEffect(() => stopLearningsPolling, [stopLearningsPolling]);

  // Process a single parsed stream event
  const processStreamEvent = (
    event: {
      type: string;
      content?: string;
      error?: string;
      name?: string;
      id?: string;
      input?: unknown;
      contextPercent?: number;
      effectiveDir?: string;
    },
    accumulated: string
  ): string => {
    if (event.type === "worktree_resolved" && event.effectiveDir) {
      setWorktreePath(event.effectiveDir);
      return accumulated;
    }
    if (event.type === "usage" && event.contextPercent != null) {
      setContextPercent(event.contextPercent);
      return accumulated;
    }
    if (event.type === "text" && event.content) {
      const next = accumulated + event.content;
      setStreamingContent(next);
      return next;
    }
    if (event.type === "tool_use" && event.name && event.id) {
      setStreamingBlocks((prev) => [
        ...prev,
        {
          type: "tool_use",
          id: event.id!,
          name: event.name,
          input: event.input,
        },
      ]);
      return accumulated;
    }
    if (event.type === "thinking" && event.content) {
      setStreamingBlocks((prev) => [
        ...prev,
        { type: "thinking", thinking: event.content },
      ]);
      return accumulated;
    }
    if (event.type === "error" && event.error) {
      setError(event.error);
      return accumulated;
    }
    if (event.type === "learnings") {
      pollLearningsStatus();
      return accumulated;
    }
    if (event.type === "result" || event.type === "done") {
      queryClient.invalidateQueries({
        queryKey: queryKeys.commentChatHistory(ticketId, comment.id, repoPath),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.gitStatus(worktreePath),
      });
    }
    return accumulated;
  };

  // Read a streaming response and dispatch events
  const readStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<string> => {
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        try {
          accumulated = processStreamEvent(JSON.parse(line), accumulated);
        } catch {
          // Not JSON - ignore
        }
      }
    }

    return accumulated;
  };

  // Send a message
  const sendMessage = useCallback(
    async (messageText: string, overrideDisplayContent?: string) => {
      if (!messageText.trim() || isStreaming) {
        return;
      }

      const trimmedInput = messageText.trim();

      // Server-side buildContextPrompt wraps the first message with full context,
      // so the client just sends the user's actual input.
      const isFirstMessage =
        !history?.messages || history.messages.length === 0;
      const messageToSend = trimmedInput;

      // Build display content: wrap PR comment details in a <context> block for the first message
      let displayContent: string | undefined = overrideDisplayContent;
      if (!displayContent && isFirstMessage) {
        const parts: string[] = [];
        if (comment.path) {
          parts.push(
            `File: ${comment.path}${comment.line ? ` (line ${comment.line})` : ""}`
          );
        }
        parts.push(`@${comment.author}: ${comment.body}`);
        displayContent = `<context source="pr-comment">\n${parts.join("\n")}\n</context>\n\n${trimmedInput}`;
      }

      // Optimistically show the user message immediately
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: displayContent ?? trimmedInput,
        timestamp: new Date().toISOString(),
      };
      setPendingUserMessage(userMessage);

      setStreamStartedAt(new Date().toISOString());
      setIsStreaming(true);
      setStreamingContent("");
      setStreamingBlocks([]);
      setError(null);

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const response = await fetch(
          `/api/engineer/symphony/comment-chat/${encodeURIComponent(comment.id)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}${branchParams}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: messageToSend,
              displayContent,
              branchName,
              prNumber,
              commentContext: {
                author: comment.author,
                body: comment.body,
                path: comment.path,
                line: comment.line,
                url: comment.url,
                replies: replies?.map((r) => ({
                  author: r.author,
                  body: r.body,
                })),
              },
            }),
            signal: abortController.signal,
          }
        );

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const accumulated = await readStream(reader);

        // Record any learnings cited by the LLM
        const { learnings } = parseLearningsUsed(accumulated);
        if (learnings.length > 0) {
          fetch("/api/engineer/symphony/record-learning-use", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketId, repoPath, learnings }),
          }).catch((err) =>
            console.error("Failed to record learning use:", err)
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped the stream
        } else {
          console.error("Chat error:", err);
          setError(
            err instanceof Error ? err.message : "Failed to send message"
          );
        }
      } finally {
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingBlocks([]);
        setPendingUserMessage(null);
        abortControllerRef.current = null;
        setStreamStartedAt("");
      }
    },
    [
      isStreaming,
      history?.messages,
      comment,
      replies,
      ticketId,
      repoPath,
      branchName,
      branchParams,
      prNumber,
      readStream,
    ]
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-start the propose fix process when enabled with no history
  useEffect(() => {
    if (
      enabled &&
      autoStart &&
      !isLoadingHistory &&
      !isFetchingHistory &&
      !hasAutoStarted &&
      !isStreaming &&
      history?.messages?.length === 0
    ) {
      setHasAutoStarted(true);
      sendMessage(
        "Investigate this PR comment and propose a fix. Show what you found before proposing changes."
      );
    }
  }, [
    enabled,
    autoStart,
    isLoadingHistory,
    isFetchingHistory,
    hasAutoStarted,
    isStreaming,
    history?.messages?.length,
    sendMessage,
  ]);

  // Handle stopping the stream
  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  // Handle sending from the input field
  const handleSend = () => {
    if (input.trim()) {
      sendMessage(input);
      setInput("");
    }
  };

  // Handle "Accept Changes"
  const handleAcceptChanges = () => {
    setHasAcceptedChanges(true);
    sendMessage(
      "Proceed with changes. After applying, provide a <pr_response> acknowledging the fix so I can reply to the reviewer."
    );
  };

  // Fire-and-forget learnings extraction from comment chat history
  const triggerLearningsExtraction = useCallback(() => {
    const chatFile = `comment-chats/${comment.id.replaceAll(/[^a-zA-Z0-9-_]/g, "_")}.json`;

    // Step 1: Trigger extraction from comment chat history
    fetch("/api/engineer/symphony/extract-learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, repoPath, chatFile }),
    }).catch((err) => {
      console.error("Failed to trigger learning extraction:", err);
    });

    // Step 2: Queue processing (waitForExtraction so server waits for step 1)
    fetch("/api/engineer/symphony/process-learnings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, repoPath, waitForExtraction: true }),
    }).catch((err) => {
      console.error("Failed to queue learnings processing:", err);
    });

    // Step 3: Notify page header to show pulsing brain icon
    globalThis.dispatchEvent(
      new CustomEvent("learnings-processing", {
        detail: { ticketId, repoPath },
      })
    );
  }, [comment.id, ticketId, repoPath]);

  // Handle "Commit & Mark Resolved"
  const handleCommitAndResolve = async () => {
    setIsCommitting(true);
    try {
      // 1. Commit changes (must succeed before we can resolve)
      const commitResponse = await fetch("/api/engineer/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          repoPath: worktreePath,
          message: `Address PR feedback: ${comment.body.slice(0, 50)}${comment.body.length > 50 ? "..." : ""}\n\nAddresses: ${comment.url}`,
        }),
      });

      const commitData = await commitResponse.json();
      if (!commitResponse.ok) {
        throw new Error(commitData.error || "Failed to commit");
      }
      const commitSha = commitData.commit?.slice(0, 7) || "unknown";

      // 2. Update local status and close the chat immediately — don't
      //    block on push + GitHub reply which are slow network calls.
      markCommentAddressed(prNumber, comment.id, commitSha);
      setHasAcceptedChanges(false);
      toast.success("Comment addressed!", {
        description: `Changes committed and pushed (${commitSha})`,
      });
      onResolved?.();
      triggerLearningsExtraction();

      // 3. Push + reply in the background (best-effort, errors shown as toasts)
      pushAndReply(worktreePath, repoPath, prNumber, comment, commitSha);

      queryClient.invalidateQueries({
        queryKey: queryKeys.gitStatus(worktreePath),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.prComments(prNumber, repoPath),
      });
    } catch (err) {
      console.error("Commit error:", err);
      toast.error("Failed to commit", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsCommitting(false);
    }
  };

  // Handle "Send Response" - for pushback without code changes
  const handleSendResponse = async (
    responseText: string,
    messageId: string
  ) => {
    try {
      // If we can't thread the reply (no databaseId), @mention the reviewer —
      // but skip the @mention for bot authors to avoid triggering them.
      const canThreadReply = comment.databaseId && comment.databaseId > 0;
      const isBot = comment.author.endsWith("[bot]");
      const bodyToSend =
        canThreadReply || isBot
          ? responseText
          : `@${comment.author} ${responseText}`;

      // Use base repoPath (not worktreePath) since we only need the git remote
      const response = await fetch("/api/engineer/git/pr/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoPath,
          commentId: canThreadReply ? comment.databaseId : undefined,
          prNumber,
          body: bodyToSend,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to send response");
      }

      markCommentResponded(prNumber, comment.id, responseText);
      setHasResponded(true);

      // Persist responded flag on the message so it survives navigation
      const patchUrl = `/api/engineer/symphony/comment-chat/${encodeURIComponent(comment.id)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}${branchParams}`;
      fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markResponded: messageId }),
      })
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: queryKeys.commentChatHistory(
              ticketId,
              comment.id,
              repoPath
            ),
          });
        })
        .catch(() => {
          /* best-effort */
        });

      // Refetch git status to check for uncommitted changes.
      // The worktree may not exist (pushback without code fix) or the path
      // may not be in the allowed repos list yet, so failures are expected.
      let stillHasChanges = false;
      try {
        const freshGitStatus = await queryClient.fetchQuery({
          ...gitStatusOptions(worktreePath),
          staleTime: 0,
        });
        if (freshGitStatus) {
          stillHasChanges =
            freshGitStatus.modified.length +
              freshGitStatus.created.length +
              freshGitStatus.deleted.length >
            0;
        }
      } catch {
        // Worktree doesn't exist or isn't allowed — no pending changes
      }

      if (stillHasChanges) {
        toast.success(
          "Response sent — pending changes still need to be committed",
          {
            description: "Use 'Commit & Mark Resolved' to commit your changes.",
          }
        );
        setHasAcceptedChanges(true);
      } else {
        toast.success("Response sent!", {
          description: canThreadReply
            ? "Reply posted to PR comment thread"
            : "Comment posted to PR",
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.prComments(prNumber, repoPath),
        });
        onResolved?.();
      }
    } catch (err) {
      console.error("Reply error:", err);
      toast.error("Failed to send response", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Delete a specific message
  const handleDeleteMessage = useCallback(
    async (index: number) => {
      try {
        const response = await fetch(
          `/api/engineer/symphony/comment-chat/${encodeURIComponent(comment.id)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}${branchParams}&index=${index}`,
          { method: "DELETE" }
        );
        if (response.ok) {
          queryClient.invalidateQueries({
            queryKey: queryKeys.commentChatHistory(
              ticketId,
              comment.id,
              repoPath
            ),
          });
        }
      } catch (err) {
        console.error("Failed to delete message:", err);
      }
    },
    [comment.id, ticketId, repoPath, branchParams, queryClient]
  );

  // Clear entire chat history
  const handleClearChat = async () => {
    if (!confirm("Clear all chat history for this comment?")) {
      return;
    }
    try {
      const response = await fetch(
        `/api/engineer/symphony/comment-chat/${encodeURIComponent(comment.id)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}${branchParams}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        setHasAutoStarted(false);
        setHasAcceptedChanges(false);
        // Reset chatStarted so the PR comment card overflow menu
        // re-shows "Fix with Claude/Codex" options.
        resetCommentStatus(prNumber, comment.id);
        onChatCleared?.();
        queryClient.invalidateQueries({
          queryKey: queryKeys.commentChatHistory(
            ticketId,
            comment.id,
            repoPath
          ),
        });
      }
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  // Combine history messages with pending user message for display.
  const historyMessages = useMemo(
    () => history?.messages || [],
    [history?.messages]
  );
  const alreadyInHistory =
    pendingUserMessage &&
    historyMessages.some(
      (m) => m.role === "user" && m.content === pendingUserMessage.content
    );
  const messages = useMemo(
    () =>
      pendingUserMessage && !alreadyInHistory
        ? [...historyMessages, pendingUserMessage]
        : historyMessages,
    [historyMessages, pendingUserMessage, alreadyInHistory]
  );

  // Server may still be generating a response if we navigated away mid-stream
  const lastHistoryMsg = historyMessages.at(-1);
  // Exclude debate markers from triggering (forwarding markers should still trigger)
  const isWaitingForResponse =
    !isStreaming &&
    !!lastHistoryMsg &&
    lastHistoryMsg.role === "user" &&
    !/^__debate_(started|ended)__$/.test(lastHistoryMsg.content);

  return {
    // State
    input,
    setInput,
    isStreaming,
    isWaitingForResponse,
    streamStartedAt,
    contextPercent: contextPercent ?? history?.contextPercent ?? null,
    streamingContent,
    streamingBlocks,
    error,
    hasAcceptedChanges,
    isCommitting,
    hasResponded,
    isHeaderCollapsed,
    toggleHeaderCollapse,

    // Queries
    history,
    isLoadingHistory,
    isFetchingHistory,
    gitFiles,
    hasChangedFiles,

    // Computed
    messages,
    historyMessageCount: historyMessages.length,
    worktreePath,

    // Actions
    sendMessage,
    handleStop,
    handleSend,
    handleAcceptChanges,
    handleCommitAndResolve,
    handleSendResponse,
    handleDeleteMessage,
    handleClearChat,
    handleKeyDown,
    triggerLearningsExtraction,

    // Refs
    messagesEndRef,
    inputRef,

    // Learnings
    learningsStatus,
    learningsCount,
    pollLearningsStatus,
  };
}

/**
 * Fire-and-forget: push committed changes and reply to the PR comment thread.
 * Errors are shown as toasts but don't block the resolved UI state.
 */
async function pushAndReply(
  worktreePath: string,
  repoPath: string,
  prNumber: number,
  comment: PRComment,
  commitSha: string
): Promise<void> {
  try {
    const pushResponse = await fetch("/api/engineer/git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "push", repoPath: worktreePath }),
    });
    if (!pushResponse.ok) {
      const data = await pushResponse.json();
      toast.error("Push failed", {
        description: data.error || "Failed to push changes",
      });
      return;
    }
  } catch {
    toast.error("Push failed", { description: "Network error" });
    return;
  }

  // Reply to the PR comment thread (best-effort)
  const replyToId =
    comment.databaseId && comment.databaseId > 0
      ? comment.databaseId
      : undefined;
  if (replyToId) {
    const isBot = comment.author.endsWith("[bot]");
    const replyBody = isBot
      ? `Issue addressed in ${commitSha}`
      : `@${comment.author} Issue addressed in ${commitSha}`;
    fetch("/api/engineer/git/pr/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoPath,
        commentId: replyToId,
        prNumber,
        body: replyBody,
      }),
    }).catch(() => {
      // Best-effort — don't toast for reply failures
    });
  }
}
