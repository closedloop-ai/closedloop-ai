"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  FileCode,
  Info,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  RotateCcw,
  Search,
  Send,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type { ReviewConfig } from "@/components/engineer/CodexReviewSettingsDialog";
import {
  ChatBubble,
  MessageContent,
  UserMessageContent,
} from "@/components/engineer/chat";
import { useChatStream } from "@/hooks/engineer/use-chat-stream";
import { chatMarkdownComponents } from "@/lib/engineer/chat-markdown";
import {
  formatFindingContextForChat,
  formatReviewContextForChat,
} from "@/lib/engineer/codex-review-context";
import {
  parseClaudeReviewOutput,
  parseCodexReviewOutput,
  type ReviewFinding,
} from "@/lib/engineer/codex-review-parser";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { symphonyChatHistoryOptions } from "@/lib/engineer/queries/symphony";

type ReviewChatPaneProps = {
  repoPath: string;
  prNumber: number;
  branchName: string;
  config: ReviewConfig;
  onClose: () => void;
  onNewReview: () => void;
  /** Pre-loaded review output (restored from localStorage). Skips the API call. */
  initialOutput?: string;
  /** Whether the current user owns this PR (hides "Leave as Comment" buttons) */
  isOwnPR?: boolean;
  /** Head commit SHA for inline comments */
  commitSha?: string;
  /** Called when the review finishes (stream, poll, error, or restored initial output) */
  onReviewComplete?: (
    output: string,
    findingCount: number,
    findings?: ReviewFinding[]
  ) => void;
  /** Called when structured findings are extracted via session resumption (Claude only) */
  onStructuredFindings?: (findings: ReviewFinding[]) => void;
  /** Indices of findings flagged as duplicates of the other provider's review */
  duplicateIndices?: Set<number>;
  /** Indices of findings flagged as duplicates of existing PR comments */
  prCommentDupIndices?: Set<number>;
  /** Whether the PR has been merged (shows a visual indicator) */
  isMerged?: boolean;
  /** Called when all findings have been individually commented */
  onAllCommented?: () => void;
};

export function ReviewChatPane({
  repoPath,
  prNumber,
  branchName,
  config,
  onClose,
  onNewReview,
  initialOutput,
  isOwnPR,
  commitSha,
  onReviewComplete,
  onStructuredFindings,
  duplicateIndices,
  prCommentDupIndices,
  isMerged,
  onAllCommented,
}: Readonly<ReviewChatPaneProps>) {
  const ticketId = `pr-${prNumber}`;

  // Phase 1: review streaming
  const [reviewOutput, setReviewOutput] = useState(initialOutput ?? "");
  const [isReviewing, setIsReviewing] = useState(!initialOutput);
  const [reviewDone, setReviewDone] = useState(!!initialOutput);
  const abortRef = useRef<AbortController | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const [submittedFindings, setSubmittedFindings] = useState<Set<number>>(
    new Set()
  );
  const [submittingFindings, setSubmittingFindings] = useState<Set<number>>(
    new Set()
  );
  const sessionIdRef = useRef<string | null>(null);
  const findingsSavedRef = useRef(false);
  const [reviewCommand, setReviewCommand] = useState<string | null>(null);
  // Refs for parent callbacks — avoids depending on callback identity in effects
  // (these are often inline functions in PRBrowserDialog that change every render)
  const onReviewCompleteRef = useRef(onReviewComplete);
  onReviewCompleteRef.current = onReviewComplete;
  const onStructuredFindingsRef = useRef(onStructuredFindings);
  onStructuredFindingsRef.current = onStructuredFindings;

  // Guard against StrictMode double-mount: only start the review once.
  // Refs survive across StrictMode re-mounts, so the second mount sees true and skips.
  const hasStartedRef = useRef(false);
  // Stable timestamp for the review bubble — captured once when the review starts.
  // For restored reviews (initialOutput), use the current time at mount.
  const reviewStartedAtRef = useRef(
    initialOutput ? new Date().toISOString() : ""
  );

  // Phase 2: chat
  const [chatInput, setChatInput] = useState("");
  const [hasSentInitial, setHasSentInitial] = useState(false);
  const stream = useChatStream();
  const queryClient = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: chatHistory } = useQuery({
    ...symphonyChatHistoryOptions(ticketId, repoPath),
    enabled: reviewDone,
  });

  // Fetch persisted findings to restore commented status
  const findingsUrl = `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(config.provider)}`;
  const { data: savedFindings } = useQuery<{
    findings: Array<{ commented: boolean }>;
  }>({
    queryKey: ["review-findings", ticketId, repoPath, config.provider],
    queryFn: () => fetch(findingsUrl).then((r) => r.json()),
    enabled: reviewDone,
  });

  // Sync submitted findings from persisted data
  useEffect(() => {
    if (!savedFindings?.findings) {
      return;
    }
    const commented = new Set<number>();
    savedFindings.findings.forEach((f, i) => {
      if (f.commented) {
        commented.add(i);
      }
    });
    if (commented.size > 0) {
      setSubmittedFindings((prev) => {
        const merged = new Set(prev);
        for (const i of commented) {
          merged.add(i);
        }
        return merged;
      });
    }
  }, [savedFindings]);

  const chatMessages = useMemo(() => {
    const base = chatHistory?.messages || [];
    if (stream.pendingUserMessage) {
      return [...base, stream.pendingUserMessage];
    }
    return base;
  }, [chatHistory?.messages, stream.pendingUserMessage]);

  // Split completed review output into thinking (process log) + findings
  const reviewSplit = useMemo(() => {
    if (!(reviewDone && reviewOutput)) {
      return null;
    }
    return splitReviewOutput(reviewOutput, config.provider);
  }, [reviewDone, reviewOutput, config.provider]);

  // Notify parent when all findings have been individually commented (fire once)
  const allCommentedFiredRef = useRef(false);
  useEffect(() => {
    if (!reviewSplit || reviewSplit.findings.length === 0) {
      return;
    }
    if (
      submittedFindings.size >= reviewSplit.findings.length &&
      !allCommentedFiredRef.current
    ) {
      allCommentedFiredRef.current = true;
      onAllCommented?.();
    }
  }, [submittedFindings.size, reviewSplit, onAllCommented]);

  // Notify parent when restoring a previous review + persist findings if missing
  useEffect(() => {
    if (!initialOutput) {
      return;
    }
    const split = splitReviewOutput(initialOutput, config.provider);
    onReviewCompleteRef.current?.(
      initialOutput,
      split.findings.length,
      split.findings
    );
    if (split.findings.length > 0 && !findingsSavedRef.current) {
      findingsSavedRef.current = true;
      saveReviewFindings(
        ticketId,
        repoPath,
        config.provider,
        config.model,
        split.findings
      );
    }
  }, [config.model, config.provider, initialOutput, repoPath, ticketId]);

  // Start the review on mount (skip if restoring a previous result)
  useEffect(() => {
    if (initialOutput) {
      return;
    }
    if (hasStartedRef.current) {
      return; // StrictMode re-mount — stream is already active
    }
    hasStartedRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    startReview(controller.signal);
    // NOTE: no cleanup abort — the stream continues across StrictMode re-mounts.
    // The Stop button calls handleStopReview which aborts via abortRef.
  }, [initialOutput, startReview]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startReview(signal: AbortSignal) {
    reviewStartedAtRef.current = new Date().toISOString();
    setIsReviewing(true);
    setReviewOutput("");
    setReviewDone(false);

    try {
      const response = await fetch(
        `/api/engineer/codex/review/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instructions: config.instructions || undefined,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            reviewMode: config.reviewMode,
            baseBranch: "main",
            repoPath,
            branchName,
            provider: config.provider || "codex",
            useBaseRepo: config.useBaseRepo || undefined,
          }),
          signal,
        }
      );

      console.log(
        "[review-stream] POST response:",
        response.status,
        "body?",
        !!response.body,
        "headers:",
        Object.fromEntries(response.headers.entries())
      );

      if (response.status === 409) {
        console.log("[review-stream] 409 — falling back to poll");
        await pollRunningReview(signal);
        return;
      }
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          errBody?.error ?? `Failed to start review: ${response.status}`
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      console.log("[review-stream] Starting stream read");
      const { text: accumulated, completed } = await streamReviewOutput(
        reader,
        setReviewOutput,
        (sid) => {
          sessionIdRef.current = sid;
        },
        setReviewCommand
      );
      console.log(
        "[review-stream] Stream ended, accumulated:",
        accumulated.length,
        "chars, completed:",
        completed
      );

      if (!completed) {
        console.log(
          "[review-stream] Stream ended without done event — falling back to poll"
        );
        setReviewOutput(accumulated);
        await pollRunningReview(signal);
        return;
      }

      setReviewOutput(accumulated);
      setReviewDone(true);
      const split = splitReviewOutput(accumulated, config.provider);
      onReviewCompleteRef.current?.(
        accumulated,
        split.findings.length,
        split.findings
      );
      toast.success("Code review completed");

      // Persist findings to disk
      if (split.findings.length > 0) {
        findingsSavedRef.current = true;
        saveReviewFindings(
          ticketId,
          repoPath,
          config.provider,
          config.model,
          split.findings
        );
      }

      // Seed the review session ID into chat history so follow-up chats
      // resume the same Claude session (full review context preserved).
      if (config.provider === "claude" && sessionIdRef.current) {
        fetch(
          `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sessionIdRef.current }),
          }
        ).catch((err) =>
          console.warn("[review] Failed to seed session ID:", err)
        );
      }

      // Always use session resumption to get structured findings with full paths
      // for inline comments. The system prompt JSON (if present) only improves display parsing.
      if (
        config.provider === "claude" &&
        split.findings.length > 0 &&
        sessionIdRef.current
      ) {
        triggerExtraction(sessionIdRef.current);
      }
    } catch (err) {
      // Abort from strict-mode cleanup or user stop — don't mark as done
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      console.error("Review error:", err);
      toast.error("Failed to run review", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setReviewDone(true);
      onReviewCompleteRef.current?.(reviewOutput, 0);
    } finally {
      setIsReviewing(false);
      abortRef.current = null;
    }
  }

  const pollRunningReview = async (signal: AbortSignal) => {
    const statusUrl = `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(config.provider)}`;
    let pollCount = 0;
    console.log("[poll] Starting poll for running review");
    while (!signal.aborted) {
      try {
        pollCount++;
        const res = await fetch(statusUrl, { signal });
        const data = await res.json();
        console.log(
          `[poll] #${pollCount}: status=${data.status}, log length=${data.log?.length ?? 0}, hasReview=${data.hasReview}`
        );

        if (data.log) {
          setReviewOutput(data.log);
        }

        if (
          data.status === "completed" ||
          data.status === "failed" ||
          data.status === "stopped"
        ) {
          console.log(
            `[poll] Terminal status: ${data.status}, log: ${data.log?.length ?? 0} chars`
          );
          const finalOutput = data.log || "";
          setReviewOutput(finalOutput);
          setReviewDone(true);
          const split = splitReviewOutput(finalOutput, config.provider);
          onReviewCompleteRef.current?.(
            finalOutput,
            split.findings.length,
            split.findings
          );
          if (data.status === "completed") {
            toast.success("Code review completed");
          }
          // Persist findings to disk
          if (split.findings.length > 0) {
            findingsSavedRef.current = true;
            saveReviewFindings(
              ticketId,
              repoPath,
              config.provider,
              config.model,
              split.findings
            );
          }
          return;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.log("[poll] Aborted");
          return;
        }
        console.log("[poll] Error:", err);
      }

      // Wait 2 seconds before polling again
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      });
    }
  };

  const handleStopReview = useCallback(async () => {
    abortRef.current?.abort();
    try {
      const response = await fetch(
        `/api/engineer/codex/stop/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoPath, provider: config.provider }),
        }
      );
      toast[response.ok ? "success" : "error"](
        response.ok ? "Review stopped" : "Failed to stop review"
      );
    } catch {
      toast.error("Failed to stop review");
    }
  }, [ticketId, repoPath, config.provider]);

  // Auto-scroll during review streaming
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Auto-scroll during chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Build the chat URL and payload based on the review provider
  const buildChatRequest = useCallback(
    (message: string): { url: string; body: Record<string, unknown> } => {
      if (config.provider === "codex") {
        return {
          url: `/api/engineer/codex/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          body: {
            prompt: message,
            chatHistory: [],
            repoPath,
            activeTab: "plan",
          },
        };
      }
      return {
        url: `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        body: {
          message,
          activeTab: "plan",
          codexReview: { model: config.model },
        },
      };
    },
    [config.provider, config.model, ticketId, repoPath]
  );

  // Send initial chat message when review completes (with review context)
  const sendInitialChatMessage = useCallback(
    (userMessage: string) => {
      if (hasSentInitial) {
        return;
      }
      setHasSentInitial(true);

      // For Claude reviews with a seeded session, skip heavy context injection —
      // the resumed session already has full review context.
      const isClaudeResumed =
        config.provider === "claude" && !!sessionIdRef.current;
      let actualMessage = userMessage;
      if (!isClaudeResumed) {
        const findings = parseCodexReviewOutput(reviewOutput);
        actualMessage = formatReviewContextForChat(
          findings,
          reviewOutput,
          config.model
        );
      }

      stream.setPendingUserMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
      });

      const { url, body } = buildChatRequest(actualMessage);
      // For Claude path with context, pass displayContent so chat history stores
      // the user-facing text, not the giant context block
      if (!isClaudeResumed && config.provider === "claude") {
        (body as Record<string, unknown>).displayContent = userMessage;
      }
      stream.sendMessage(url, body, {
        onComplete: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
          }),
      });
    },
    [
      hasSentInitial,
      reviewOutput,
      config.model,
      config.provider,
      stream,
      ticketId,
      repoPath,
      queryClient,
      buildChatRequest,
    ]
  );

  const handleSendChat = useCallback(() => {
    const trimmed = chatInput.trim();
    if (!trimmed || stream.isStreaming) {
      return;
    }
    setChatInput("");

    // First message gets the review context injected
    if (!hasSentInitial) {
      sendInitialChatMessage(trimmed);
      return;
    }

    stream.setPendingUserMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    });

    const { url, body } = buildChatRequest(trimmed);
    stream.sendMessage(url, body, {
      onComplete: () =>
        queryClient.invalidateQueries({
          queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
        }),
    });
  }, [
    chatInput,
    stream,
    hasSentInitial,
    sendInitialChatMessage,
    ticketId,
    repoPath,
    queryClient,
    buildChatRequest,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendChat();
      }
    },
    [handleSendChat]
  );

  const handleSubmitComment = useCallback(
    async (index: number, finding: ReviewFinding) => {
      if (duplicateIndices?.has(index) || prCommentDupIndices?.has(index)) {
        return;
      }
      setSubmittingFindings((prev) => new Set(prev).add(index));

      const [title, ...descParts] = finding.message.split("\n");
      const description = descParts.join("\n").trim();
      const priorityLabel = finding.priority || "P3";
      const filePath =
        finding.file && commitSha ? stripWorktreePath(finding.file) : undefined;
      const isInline = !!filePath;

      // Only include file:line in body when not posting as inline comment
      // (GitHub already shows the file + line in the diff gutter for inline comments)
      const bodyParts = [`**[${priorityLabel}]** ${title}`];
      if (!isInline && finding.file) {
        const displayPath = stripWorktreePath(finding.file);
        bodyParts.push(
          `**${displayPath}${finding.line ? `:${finding.line}` : ""}**`
        );
      }
      if (description) {
        bodyParts.push(description);
      }

      if (finding.suggestion) {
        bodyParts.push("", `> **Suggestion:** ${finding.suggestion}`);
      }

      const body = bodyParts.join("\n\n");

      try {
        const response = await fetch("/api/engineer/git/pr/inline-comment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoPath,
            prNumber,
            body,
            path: filePath,
            line: filePath && finding.line ? finding.line : undefined,
            commitSha: filePath ? commitSha : undefined,
          }),
        });

        if (response.ok) {
          setSubmittedFindings((prev) => new Set(prev).add(index));
          markFindingCommented(ticketId, repoPath, config.provider, index);
          toast.success("Comment posted");
        } else {
          const data = await response.json();
          toast.error("Failed to post comment", { description: data.error });
        }
      } catch {
        toast.error("Failed to post comment");
      } finally {
        setSubmittingFindings((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    },
    [
      ticketId,
      repoPath,
      prNumber,
      commitSha,
      config.provider,
      duplicateIndices,
      prCommentDupIndices,
    ]
  );

  const triggerExtraction = useCallback(
    async (sid: string) => {
      try {
        console.log(
          `[review-extract] Triggering extraction with session ${sid}`
        );
        const res = await fetch(
          `/api/engineer/codex/review-extract/${encodeURIComponent(ticketId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath, sessionId: sid }),
          }
        );
        const data = await res.json();
        if (data.findings && data.findings.length > 0) {
          console.log(
            `[review-extract] Got ${data.findings.length} structured findings`
          );
          onStructuredFindingsRef.current?.(data.findings);
          // Overwrite persisted findings with structured ones (better file paths)
          saveReviewFindings(
            ticketId,
            repoPath,
            config.provider,
            config.model,
            data.findings
          );
        } else {
          console.log(
            "[review-extract] No structured findings returned",
            data.error ?? ""
          );
        }
      } catch (err) {
        console.warn("[review-extract] Extraction failed silently:", err);
      }
    },
    [ticketId, repoPath, config.provider, config.model]
  );

  const handleChatAboutFinding = useCallback(
    (index: number, finding: ReviewFinding) => {
      if (stream.isStreaming) {
        return;
      }

      const isClaudeResumed =
        config.provider === "claude" && !!sessionIdRef.current;
      const title = finding.message.split("\n")[0].slice(0, 80);
      const userFacingMessage = `Explain finding #${index + 1}: ${title}`;

      // Build the actual message sent to the LLM
      let actualMessage: string;
      if (isClaudeResumed) {
        // Session already has review context — just ask about the finding
        actualMessage = userFacingMessage;
      } else {
        // Codex or no session — inject full finding context
        actualMessage = formatFindingContextForChat(
          finding,
          index,
          reviewOutput,
          config.model
        );
      }

      stream.setPendingUserMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: userFacingMessage,
        timestamp: new Date().toISOString(),
      });

      setHasSentInitial(true);
      const { url, body } = buildChatRequest(actualMessage);
      // Store user-facing text in chat history for Claude path
      if (!isClaudeResumed && config.provider === "claude") {
        (body as Record<string, unknown>).displayContent = userFacingMessage;
      }
      stream.sendMessage(url, body, {
        onComplete: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
          }),
      });
    },
    [
      stream,
      config.provider,
      config.model,
      reviewOutput,
      ticketId,
      repoPath,
      queryClient,
      buildChatRequest,
    ]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-border border-b bg-muted/30 px-5 py-3 pr-10">
        <div className="flex items-center gap-3">
          <button
            className="-ml-1.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onClose}
            title="Back"
          >
            <ArrowLeft className="size-4" />
          </button>
          <Search className="size-4 text-muted-foreground" />
          <span className="flex-1 font-medium text-sm">
            {config.provider === "claude" ? "Claude" : "Codex"} Review — PR #
            {prNumber}
            {reviewCommand && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {reviewCommand}
              </span>
            )}
            {isMerged && (
              <span className="ml-2 rounded bg-violet-500/10 px-1.5 py-0.5 font-bold font-mono text-[10px] text-violet-600 dark:text-violet-400">
                Merged
              </span>
            )}
          </span>
          {reviewDone && !isReviewing && (
            <button
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onNewReview}
              title="New review"
            >
              <RotateCcw className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {/* During streaming: thinking block (collapsed) + "Reviewing..." */}
        {isReviewing && (
          <ChatBubble
            isStreaming
            messageRole="assistant"
            sender={config.provider === "claude" ? "claude" : "codex"}
            timestamp={reviewStartedAtRef.current}
          >
            <MessageContent
              blocks={
                reviewOutput
                  ? [{ type: "thinking" as const, thinking: reviewOutput }]
                  : undefined
              }
              content="Reviewing..."
              isStreaming
            />
          </ChatBubble>
        )}

        {/* Completed review: process log as thinking block + findings */}
        {reviewSplit && (
          <>
            <ChatBubble
              messageRole="assistant"
              sender={config.provider === "claude" ? "claude" : "codex"}
              timestamp={reviewStartedAtRef.current}
            >
              <MessageContent
                blocks={
                  reviewSplit.processLog
                    ? [
                        {
                          type: "thinking" as const,
                          thinking: reviewSplit.processLog,
                        },
                      ]
                    : undefined
                }
                content={
                  reviewSplit.findings.length > 0
                    ? `Found **${reviewSplit.findings.length}** issue${reviewSplit.findings.length === 1 ? "" : "s"} in the code review.`
                    : "No issues found — LGTM!"
                }
              />
            </ChatBubble>
            {reviewSplit.findings.length > 0 && (
              <div className="space-y-2 pl-2">
                {reviewSplit.findings.map((finding, i) => {
                  const isProviderDup = duplicateIndices?.has(i) ?? false;
                  const isPRCommentDup = prCommentDupIndices?.has(i) ?? false;
                  return (
                    <FindingCard
                      duplicateLabel={isPRCommentDup ? "In PR" : "Dup"}
                      finding={finding}
                      index={i}
                      isDuplicate={isProviderDup || isPRCommentDup}
                      isOwnPR={isOwnPR}
                      isSubmitted={submittedFindings.has(i)}
                      isSubmitting={submittingFindings.has(i)}
                      key={`finding-${i}`}
                      onChat={handleChatAboutFinding}
                      onSubmitComment={handleSubmitComment}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Chat messages (after review completes) */}
        {reviewDone &&
          chatMessages.map((msg, idx) => {
            const isLastAssistant =
              msg.role === "assistant" &&
              !chatMessages
                .slice(idx + 1)
                .some((m) => m.role === "assistant") &&
              !stream.isStreaming;
            return (
              <ChatBubble
                bubbleClassName={
                  msg.role === "user"
                    ? "bg-blue-500/10 dark:bg-blue-500/10 text-blue-900 dark:text-blue-100 border border-blue-500/20"
                    : "bg-muted text-foreground border border-border"
                }
                contextPercent={
                  isLastAssistant
                    ? (stream.contextPercent ??
                      chatHistory?.contextPercent ??
                      undefined)
                    : undefined
                }
                key={msg.id}
                messageRole={msg.role}
                roleClassName={
                  msg.role === "user"
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-emerald-600 dark:text-emerald-400"
                }
                roleLabel={msg.role === "user" ? "you" : "cl.dev"}
                timestamp={msg.timestamp}
              >
                {msg.role === "user" ? (
                  <UserMessageContent content={msg.content} />
                ) : (
                  <MessageContent blocks={msg.blocks} content={msg.content} />
                )}
              </ChatBubble>
            );
          })}

        {/* Streaming chat response */}
        {stream.isStreaming &&
          (stream.streamingContent || stream.streamingBlocks.length > 0) && (
            <ChatBubble
              bubbleClassName="bg-muted text-foreground border border-border border-emerald-500/30"
              isStreaming
              messageRole="assistant"
              roleClassName="text-emerald-600 dark:text-emerald-400"
              roleLabel="cl.dev"
              timestamp={stream.streamStartedAt}
            >
              <MessageContent
                blocks={stream.streamingBlocks}
                content={stream.streamingContent}
                isStreaming
              />
            </ChatBubble>
          )}

        {/* Waiting indicator */}
        {stream.isStreaming &&
          !stream.streamingContent &&
          stream.streamingBlocks.length === 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="flex gap-1">
                <span className="size-1.5 animate-bounce rounded-full bg-emerald-500/60 [animation-delay:0ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-emerald-500/60 [animation-delay:150ms]" />
                <span className="size-1.5 animate-bounce rounded-full bg-emerald-500/60 [animation-delay:300ms]" />
              </div>
              <span className="font-mono text-muted-foreground text-xs">
                analyzing...
              </span>
            </div>
          )}

        {stream.error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 font-mono text-red-600 text-xs dark:text-red-400">
            Error: {stream.error}
          </div>
        )}

        <div ref={outputEndRef} />
        <div ref={messagesEndRef} />
      </div>

      {/* Bottom bar: stop during review, chat input after */}
      <div className="shrink-0 border-border border-t bg-muted/30 p-4">
        {isReviewing ? (
          <Button
            className="w-full"
            onClick={handleStopReview}
            variant="outline"
          >
            <Square className="mr-2 size-3" />
            Stop Review
          </Button>
        ) : (
          <>
            <div className="relative flex items-end gap-3">
              <span className="shrink-0 pb-2.5 font-bold font-mono text-emerald-600 text-sm dark:text-emerald-500">
                {">"}
              </span>
              <div className="relative flex-1">
                <textarea
                  className={cn(
                    "w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground",
                    "py-2 pr-10 font-mono leading-relaxed",
                    "focus:outline-none focus:ring-0",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                  disabled={stream.isStreaming}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about the review findings..."
                  rows={1}
                  style={{
                    minHeight: "40px",
                    maxHeight: "50vh",
                    overflow: "hidden",
                  }}
                  value={chatInput}
                />
                {stream.isStreaming ? (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
                    )}
                    onClick={stream.stopStreaming}
                    title="Stop response"
                  >
                    <Square className="size-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "transition-all duration-200",
                      chatInput.trim()
                        ? "bg-emerald-600 text-white shadow-emerald-500/20 shadow-lg hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                        : "cursor-not-allowed bg-muted text-muted-foreground"
                    )}
                    disabled={!chatInput.trim()}
                    onClick={handleSendChat}
                  >
                    <Send className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between px-5">
              <span className="font-mono text-[10px] text-muted-foreground">
                Shift+Enter for new line
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {chatMessages.length} message
                {chatMessages.length === 1 ? "" : "s"}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- Review findings split + card ---

const FINDINGS_HEADER = /^(?:Full )?[Rr]eview comments?:\s*$/m;

export function splitReviewOutput(
  output: string,
  provider?: "claude" | "codex"
): { processLog: string; findings: ReviewFinding[] } {
  if (provider === "claude") {
    return parseClaudeReviewOutput(output);
  }

  const match = FINDINGS_HEADER.exec(output);
  if (!match) {
    return { processLog: output, findings: [] };
  }

  const processLog = output.slice(0, match.index).trim();
  const findingsText = output.slice(match.index + match[0].length).trim();
  return { processLog, findings: parseFullReviewComments(findingsText) };
}

/**
 * Parse the "Full review comments:" block.
 * Format: `[P2] Title — path/to/file:lines\nDescription...`
 * Each finding is separated by a blank line.
 */
function parseFullReviewComments(text: string): ReviewFinding[] {
  // Split on blank lines then filter out empty chunks
  const chunks = text.split(/\n{2,}/).filter((c) => c.trim());
  const findings: ReviewFinding[] = [];

  for (const chunk of chunks) {
    const headerMatch =
      /^(?:[-*]\s+)?\[([Pp]\d)\]\s+(.+?)(?:\s+—\s+(.+))?$/.exec(
        chunk.split("\n")[0]
      );
    if (!headerMatch) {
      continue;
    }

    const priority = headerMatch[1].toUpperCase() as ReviewFinding["priority"];
    const title = headerMatch[2].trim();
    const fileRef = headerMatch[3]?.trim();

    // Everything after the first line is the description
    const descLines = chunk.split("\n").slice(1);
    const description = descLines.join("\n").trim();

    const severity = priorityToSeverity(priority ?? "P3");
    const fileMatch = fileRef ? /^(.+?):(\d+)/.exec(fileRef) : null;

    findings.push({
      severity,
      priority,
      file: fileMatch?.[1] ?? fileRef,
      line: fileMatch?.[2] ? Number.parseInt(fileMatch[2], 10) : undefined,
      message: description ? `${title}\n${description}` : title,
    });
  }

  return findings;
}

function priorityToSeverity(priority: string): ReviewFinding["severity"] {
  if (priority === "P0" || priority === "P1") {
    return "critical";
  }
  if (priority === "P2") {
    return "warning";
  }
  return "info";
}

const SEVERITY_STYLES: Record<
  ReviewFinding["severity"],
  {
    icon: typeof AlertCircle;
    border: string;
    bg: string;
    text: string;
    badge: string;
  }
> = {
  critical: {
    icon: AlertCircle,
    border: "border-red-500/20",
    bg: "bg-red-500/[0.03] dark:bg-card",
    text: "text-red-600 dark:text-red-400",
    badge: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
  warning: {
    icon: AlertTriangle,
    border: "border-amber-500/20",
    bg: "bg-amber-500/[0.03] dark:bg-card",
    text: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  info: {
    icon: Info,
    border: "border-blue-500/20",
    bg: "bg-blue-500/[0.03] dark:bg-card",
    text: "text-blue-600 dark:text-blue-400",
    badge: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  success: {
    icon: Info,
    border: "border-emerald-500/20",
    bg: "bg-emerald-500/[0.03] dark:bg-card",
    text: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
};

type FindingCardProps = {
  finding: ReviewFinding;
  index: number;
  isOwnPR?: boolean;
  isSubmitted: boolean;
  isSubmitting: boolean;
  isDuplicate: boolean;
  duplicateLabel?: string;
  onSubmitComment: (index: number, finding: ReviewFinding) => void;
  onChat?: (index: number, finding: ReviewFinding) => void;
};

function FindingCard({
  finding,
  index,
  isOwnPR,
  isSubmitted,
  isSubmitting,
  isDuplicate,
  duplicateLabel,
  onSubmitComment,
  onChat,
}: Readonly<FindingCardProps>) {
  const [collapsed, setCollapsed] = useState(isSubmitted);
  const prevSubmitted = useRef(isSubmitted);

  // Auto-collapse when the finding gets commented
  useEffect(() => {
    if (isSubmitted && !prevSubmitted.current) {
      setCollapsed(true);
    }
    prevSubmitted.current = isSubmitted;
  }, [isSubmitted]);

  const style = SEVERITY_STYLES[finding.severity];
  const Icon = style.icon;
  const displayPath = finding.file ? stripWorktreePath(finding.file) : null;
  const showCommentButton = !isOwnPR;
  const title = finding.message.split("\n")[0].slice(0, 100);

  if (collapsed) {
    return (
      <button
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
          "hover:bg-muted/50",
          style.border,
          "bg-muted/20"
        )}
        onClick={() => setCollapsed(false)}
        type="button"
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        <div
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full",
            style.badge
          )}
        >
          <Icon className={cn("size-3", style.text)} />
        </div>
        {finding.priority && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 font-bold font-mono text-[10px]",
              style.badge
            )}
          >
            {finding.priority}
          </span>
        )}
        <span className="flex-1 truncate text-[11px] text-muted-foreground">
          {title}
        </span>
        {isSubmitted && (
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[10px] text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            Commented
          </span>
        )}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "space-y-2.5 rounded-xl border p-4",
        style.border,
        style.bg
      )}
    >
      <div className="flex items-start gap-2.5">
        <button
          className={cn(
            "mt-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors",
            "hover:ring-2 hover:ring-foreground/10",
            style.badge
          )}
          onClick={() => setCollapsed(true)}
          title="Collapse"
          type="button"
        >
          <Icon className={cn("size-3.5", style.text)} />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          {finding.priority && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-bold font-mono text-[10px]",
                style.badge
              )}
            >
              {finding.priority}
            </span>
          )}
          {isDuplicate && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-bold font-mono text-[10px] text-amber-600 dark:text-amber-400">
              {duplicateLabel ?? "Dup"}
            </span>
          )}
          {displayPath && (
            <div className="flex items-center gap-1.5">
              <FileCode className="size-3 shrink-0 text-muted-foreground/70" />
              <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                {displayPath}
                {finding.line ? `:${finding.line}` : ""}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="pl-[34px] text-[12px] text-foreground/90 leading-relaxed">
        <ReactMarkdown
          components={chatMarkdownComponents}
          remarkPlugins={[remarkGfm]}
        >
          {finding.message}
        </ReactMarkdown>
      </div>
      <div className="flex items-center gap-2 pl-[34px]">
        {onChat && (
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2.5 py-1 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.1] hover:text-foreground"
            onClick={() => onChat(index, finding)}
          >
            <MessageCircle className="size-3" />
            Explain
          </button>
        )}
        {showCommentButton && (
          <button
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-[11px] transition-colors",
              commentButtonStyle(isSubmitted, isSubmitting, isDuplicate)
            )}
            disabled={isSubmitted || isSubmitting || isDuplicate}
            onClick={() => onSubmitComment(index, finding)}
          >
            <CommentButtonContent
              duplicateLabel={duplicateLabel}
              isDuplicate={isDuplicate}
              isSubmitted={isSubmitted}
              isSubmitting={isSubmitting}
            />
          </button>
        )}
      </div>
    </div>
  );
}

export function stripWorktreePath(filePath: string): string {
  // Strip worktree prefixes like /Users/.../Source/repo-name-pr-NNN/ → relative path
  const match = /\/Source\/[^/]+-pr-\d+\/(.+)/.exec(filePath);
  if (match) {
    return match[1];
  }
  // Also try standard /Source/repo/ prefix
  const sourceMatch = /\/Source\/[^/]+\/(.+)/.exec(filePath);
  if (sourceMatch) {
    return sourceMatch[1];
  }
  return filePath;
}

// --- Findings persistence helpers ---

function saveReviewFindings(
  ticketId: string,
  repoPath: string,
  provider: string,
  model: string,
  findings: ReviewFinding[]
): void {
  const url = `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, findings }),
  }).catch((err) => console.warn("[review-findings] Failed to save:", err));
}

function markFindingCommented(
  ticketId: string,
  repoPath: string,
  provider: string,
  index: number
): void {
  const url = `/api/engineer/codex/review-findings/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(provider)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commentedIndex: index }),
  }).catch((err) =>
    console.warn("[review-findings] Failed to mark commented:", err)
  );
}

// --- Extracted stream reader ---

async function streamReviewOutput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  setOutput: (value: string) => void,
  onSessionId?: (sessionId: string) => void,
  onReviewCommand?: (command: string) => void
): Promise<{ text: string; completed: boolean }> {
  const decoder = new TextDecoder();
  let accumulated = "";
  let chunkCount = 0;
  let receivedDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      console.log(
        `[stream-reader] Stream done after ${chunkCount} chunks, accumulated ${accumulated.length} chars, receivedDone=${receivedDone}`
      );
      break;
    }

    chunkCount++;
    const chunk = decoder.decode(value);
    console.log(
      `[stream-reader] Chunk #${chunkCount}: ${chunk.length} chars, raw: ${chunk.slice(0, 200)}`
    );
    const lines = chunk.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        console.log(
          `[stream-reader] Event: type=${event.type}, content length=${event.content?.length ?? 0}`
        );
        if (event.type === "reviewCommand" && event.reviewCommand) {
          console.log(`[stream-reader] Review command: ${event.reviewCommand}`);
          onReviewCommand?.(event.reviewCommand);
        } else if (event.type === "sessionId" && event.sessionId) {
          console.log(`[stream-reader] Session ID: ${event.sessionId}`);
          onSessionId?.(event.sessionId);
        } else if (event.type === "output" && event.content) {
          accumulated += event.content;
          setOutput(accumulated);
        } else if (event.type === "done") {
          console.log(`[stream-reader] Done event, exitCode=${event.exitCode}`);
          receivedDone = true;
        } else if (event.type === "error") {
          toast.error("Review error", { description: event.content });
        }
      } catch {
        console.log(`[stream-reader] Non-JSON line: ${line.slice(0, 200)}`);
      }
    }
  }

  return { text: accumulated, completed: receivedDone };
}

// --- Comment button helpers (avoids nested ternaries — SonarQube S3358) ---

function commentButtonStyle(
  isSubmitted: boolean,
  isSubmitting: boolean,
  isDuplicate: boolean
): string {
  if (isSubmitted) {
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 cursor-default";
  }
  if (isDuplicate) {
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400 cursor-default";
  }
  if (isSubmitting) {
    return "bg-muted text-muted-foreground cursor-wait";
  }
  return "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground cursor-pointer";
}

function CommentButtonContent({
  isSubmitted,
  isSubmitting,
  isDuplicate,
  duplicateLabel,
}: Readonly<{
  isSubmitted: boolean;
  isSubmitting: boolean;
  isDuplicate: boolean;
  duplicateLabel?: string;
}>) {
  if (isSubmitted) {
    return (
      <>
        <Check className="size-3" />
        Commented
      </>
    );
  }
  if (isDuplicate) {
    return (
      <>
        <Check className="size-3" />
        {duplicateLabel ?? "Duplicate"}
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
      Leave as Comment
    </>
  );
}
