"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChatModeView } from "@/components/engineer/codex-review/ChatModeView";
import {
  DEFAULT_CODEX_MODEL,
  LOCAL_STORAGE_KEYS,
  pendingNewReview,
} from "@/components/engineer/codex-review/constants";
import { DefaultView } from "@/components/engineer/codex-review/DefaultView";
import { useChatStream } from "@/hooks/engineer/use-chat-stream";
import { useCodexDebate } from "@/hooks/engineer/use-codex-debate";
import { useCodexReviewStatus } from "@/hooks/engineer/use-codex-review-status";
import { useLearnings } from "@/hooks/engineer/use-learnings";
import type { LearningUsed, SuggestedAction } from "@/lib/engineer/chat-utils";
import {
  formatFindingContextForChat,
  formatReviewContextForChat,
} from "@/lib/engineer/codex-review-context";
import {
  parseCodexReviewOutput,
  type ReviewFindings,
} from "@/lib/engineer/codex-review-parser";
import { queryKeys } from "@/lib/engineer/queries/keys";
import {
  findingChatHistoryOptions,
  symphonyChatHistoryOptions,
} from "@/lib/engineer/queries/symphony";

type CodexReviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  repoPath: string;
  branchName?: string;
};

export function CodexReviewDialog({
  open,
  onOpenChange,
  ticketId,
  repoPath,
  branchName,
}: Readonly<CodexReviewDialogProps>) {
  // Review configuration
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState(() => {
    if (globalThis.window === undefined) {
      return DEFAULT_CODEX_MODEL;
    }
    return (
      localStorage.getItem(LOCAL_STORAGE_KEYS.model) || DEFAULT_CODEX_MODEL
    );
  });
  const [reasoningEffort, setReasoningEffort] = useState(() => {
    if (globalThis.window === undefined) {
      return "medium";
    }
    return localStorage.getItem(LOCAL_STORAGE_KEYS.reasoning) || "medium";
  });
  const [reviewMode, setReviewMode] = useState<"uncommitted" | "base">(
    branchName ? "base" : "uncommitted"
  );

  // Review execution
  const [showConfig, setShowConfig] = useState(() =>
    pendingNewReview.has(ticketId)
  );
  const [isStarting, setIsStarting] = useState(false);
  const [localOutput, setLocalOutput] = useState("");
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [findings, setFindings] = useState<ReviewFindings | null>(null);

  // Dismiss and expand state
  const [dismissedFindings, setDismissedFindings] = useState<Set<number>>(
    new Set()
  );
  const [expandedFindings, setExpandedFindings] = useState<Set<number>>(
    new Set()
  );
  const [currentDebateFindingIndex, setCurrentDebateFindingIndex] = useState<
    number | null
  >(null);

  // Chat mode
  const [chatMode, setChatMode] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<
    number | null
  >(null);

  // Streams and queries
  const stream = useChatStream();
  const findingStream = useChatStream();
  const queryClient = useQueryClient();

  const activeStream = selectedFindingIndex === null ? stream : findingStream;
  const findingId =
    selectedFindingIndex === null ? null : `finding-${selectedFindingIndex}`;

  const { data: chatHistory } = useQuery({
    ...symphonyChatHistoryOptions(ticketId, repoPath),
    enabled: open && chatMode && selectedFindingIndex === null,
  });

  const { data: findingChatHistory } = useQuery({
    ...findingChatHistoryOptions(ticketId, findingId || "", repoPath),
    enabled: open && chatMode && selectedFindingIndex !== null && !!findingId,
  });

  const activeChatHistory =
    selectedFindingIndex === null ? chatHistory : findingChatHistory;

  const learnings = useLearnings({ ticketId, repoPath });

  const recordLearningUse = useCallback(
    (used: LearningUsed[]) => {
      fetch("/api/engineer/symphony/record-learning-use", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, repoPath, learnings: used }),
      }).catch((err) => console.error("Failed to record learning use:", err));
    },
    [ticketId, repoPath]
  );

  const debateSaveEndpoint = findingId
    ? `/api/engineer/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
    : undefined;
  const debateInvalidateKey = findingId
    ? queryKeys.findingChatHistory(ticketId, findingId, repoPath)
    : undefined;
  const debate = useCodexDebate({
    ticketId,
    repoPath,
    model,
    chatHistory: activeChatHistory,
    claudeStream: stream,
    saveEndpoint: debateSaveEndpoint,
    invalidateKey: debateInvalidateKey,
    middleAction: { label: "Dismiss Finding", message: "/dismiss" },
    onLearnings: learnings.poll,
  });

  const chatMessages = useMemo(
    () =>
      activeStream.pendingUserMessage
        ? [
            ...(activeChatHistory?.messages || []),
            activeStream.pendingUserMessage,
          ]
        : activeChatHistory?.messages || [],
    [activeChatHistory?.messages, activeStream.pendingUserMessage]
  );

  // Poll review status
  const { data: reviewStatus, refetch: refetchStatus } = useCodexReviewStatus(
    ticketId,
    repoPath
  );
  const isRunning =
    reviewStatus?.status === "running" && reviewStatus?.processRunning;
  const isCompleted =
    reviewStatus?.status === "completed" ||
    reviewStatus?.status === "failed" ||
    reviewStatus?.status === "stopped";

  // Destructure stable callbacks to avoid depending on the entire object
  // (useCodexDebate/useLearnings return new objects every render)
  const resetDebate = debate.reset;
  const closeLearnings = learnings.handleClose;

  // Reset callback used by both useResetOnClose and explicit reset actions
  const resetReviewState = useCallback(() => {
    setLocalOutput("");
    setFindings(null);
    setExpandedFindings(new Set());
    setDismissedFindings(new Set());
    setSelectedFindingIndex(null);
    setChatMode(false);
    setChatInput("");
    resetDebate();
    closeLearnings();
  }, [resetDebate, closeLearnings]);

  // --- Effects ---
  useSyncOutput(
    showConfig,
    isStarting,
    ticketId,
    reviewStatus?.log,
    localOutput,
    setLocalOutput
  );
  useParseFindings(
    showConfig,
    isStarting,
    ticketId,
    isCompleted,
    localOutput,
    findings,
    setFindings
  );
  usePersistPreference(LOCAL_STORAGE_KEYS.model, model);
  usePersistPreference(LOCAL_STORAGE_KEYS.reasoning, reasoningEffort);
  useResetOnClose(open, isRunning, resetReviewState);
  useRefetchOnOpen(open, refetchStatus);

  // --- Handlers ---
  const handleStartReview = useCallback(async () => {
    setIsStarting(true);
    setShowConfig(false);
    setLocalOutput("");
    setFindings(null);
    setOutputExpanded(true);
    pendingNewReview.delete(ticketId);

    try {
      const response = await fetch(
        `/api/engineer/codex/review/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instructions: instructions.trim() || undefined,
            model,
            reasoningEffort,
            reviewMode,
            baseBranch: "main",
            repoPath,
            branchName,
          }),
        }
      );

      if (response.status === 409) {
        toast.error("A review is already running");
        refetchStatus();
        return;
      }
      if (!response.ok) {
        throw new Error("Failed to start review");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const accumulated = await streamReviewResponse(
        reader,
        setLocalOutput,
        refetchStatus
      );
      setFindings(parseCodexReviewOutput(accumulated));
      toast.success("Code review completed");
    } catch (err) {
      console.error("Review error:", err);
      toast.error("Failed to start review", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsStarting(false);
      refetchStatus();
    }
  }, [
    ticketId,
    instructions,
    model,
    reasoningEffort,
    reviewMode,
    repoPath,
    branchName,
    refetchStatus,
  ]);

  const handleStopReview = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/engineer/codex/stop/${encodeURIComponent(ticketId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: repoPath }),
        }
      );
      toast[response.ok ? "success" : "error"](
        response.ok ? "Review stopped" : "Failed to stop review"
      );
      if (response.ok) {
        refetchStatus();
      }
    } catch {
      toast.error("Failed to stop review");
    }
  }, [ticketId, repoPath, refetchStatus]);

  const handleDiscussFindings = useCallback(() => {
    if (!findings) {
      return;
    }
    setChatMode(true);
    setSelectedFindingIndex(null);
    if (chatHistory?.messages && chatHistory.messages.length > 0) {
      return;
    }

    stream.setPendingUserMessage({
      id: crypto.randomUUID(),
      role: "user",
      content:
        "Analyze the Codex code review findings. Read the referenced source files and assess whether each finding is valid or a false positive.",
      timestamp: new Date().toISOString(),
    });
    const url = `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
    stream.sendMessage(
      url,
      {
        message: formatReviewContextForChat(findings, localOutput, model),
        activeTab: "plan",
        codexReview: { model },
      },
      {
        onLearnings: learnings.poll,
        onLearningsUsed: recordLearningUse,
        onComplete: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
          }),
      }
    );
  }, [
    findings,
    chatHistory,
    stream,
    ticketId,
    repoPath,
    localOutput,
    model,
    queryClient,
    learnings.poll,
    recordLearningUse,
  ]);

  const openFindingChat = useCallback(
    async (idx: number) => {
      if (!findings) {
        return;
      }
      setChatMode(true);
      setSelectedFindingIndex(idx);

      const finding = findings.findings[idx];
      const fId = `finding-${idx}`;

      // Check server for existing history
      try {
        const res = await fetch(
          `/api/engineer/codex/finding-chat/${encodeURIComponent(fId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`
        );
        if (res.ok) {
          const data = await res.json();
          if (data.messages && data.messages.length > 0) {
            queryClient.setQueryData(
              queryKeys.findingChatHistory(ticketId, fId, repoPath),
              data
            );
            return;
          }
        }
      } catch {
        // Fall through to send initial message
      }

      const displayMsg = buildFindingDisplayMessage(finding, idx);
      findingStream.setPendingUserMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: displayMsg,
        timestamp: new Date().toISOString(),
      });

      const url = `/api/engineer/codex/finding-chat/${encodeURIComponent(fId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`;
      findingStream.sendMessage(
        url,
        {
          message: formatFindingContextForChat(
            finding,
            idx,
            localOutput,
            model
          ),
          displayMessage: displayMsg,
          findingContext: {
            severity: finding.severity,
            priority: finding.priority,
            file: finding.file,
            line: finding.line,
            message: finding.message,
            suggestion: finding.suggestion,
          },
        },
        {
          onLearnings: learnings.poll,
          onLearningsUsed: recordLearningUse,
          onComplete: () =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.findingChatHistory(ticketId, fId, repoPath),
            }),
        }
      );
    },
    [
      findings,
      ticketId,
      repoPath,
      localOutput,
      model,
      findingStream,
      queryClient,
      learnings.poll,
      recordLearningUse,
    ]
  );

  const selectFinding = useCallback((idx: number | null) => {
    setSelectedFindingIndex(idx);
    setChatInput("");
  }, []);

  const handleSendChat = useCallback(async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || activeStream.isStreaming) {
      return;
    }
    setChatInput("");

    activeStream.setPendingUserMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    });

    if (selectedFindingIndex !== null && findingId) {
      const url = `/api/engineer/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`;
      await findingStream.sendMessage(
        url,
        { message: trimmed },
        {
          onLearnings: learnings.poll,
          onLearningsUsed: recordLearningUse,
          onComplete: () =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.findingChatHistory(
                ticketId,
                findingId,
                repoPath
              ),
            }),
        }
      );
    } else {
      const url = `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      await stream.sendMessage(
        url,
        { message: trimmed, activeTab: "plan", codexReview: { model } },
        {
          onLearnings: learnings.poll,
          onLearningsUsed: recordLearningUse,
          onComplete: () =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
            }),
        }
      );
    }
  }, [
    chatInput,
    activeStream,
    selectedFindingIndex,
    findingId,
    ticketId,
    repoPath,
    findingStream,
    stream,
    model,
    queryClient,
    learnings.poll,
    recordLearningUse,
  ]);

  const toggleFindingExpanded = useCallback((idx: number) => {
    setExpandedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }, []);

  const toggleFindingDismissed = useCallback((idx: number) => {
    setDismissedFindings((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  }, []);

  const handleChatAction = useCallback(
    (action: SuggestedAction) => {
      const message = action.message;
      if (message === "/dismiss") {
        handleDismissAction({
          selectedFindingIndex,
          currentDebateFindingIndex,
          setDismissedFindings,
          setCurrentDebateFindingIndex,
          ticketId,
          repoPath,
          queryClient,
          debate,
          setChatMode,
        });
        return;
      }
      if (message.startsWith("argue_codex:") && findings) {
        trackDebateFinding(message, findings, setCurrentDebateFindingIndex);
      }
      if (debate.handleAction(message)) {
        return;
      }

      // Regular action — send to appropriate endpoint
      activeStream.setPendingUserMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      sendActionMessage(
        {
          selectedFindingIndex,
          findingId,
          ticketId,
          repoPath,
          model,
          findingStream,
          stream,
          queryClient,
          onLearnings: learnings.poll,
          onLearningsUsed: recordLearningUse,
        },
        message
      );
    },
    [
      selectedFindingIndex,
      currentDebateFindingIndex,
      ticketId,
      repoPath,
      queryClient,
      debate,
      findings,
      activeStream,
      findingId,
      model,
      findingStream,
      stream,
      learnings.poll,
      recordLearningUse,
    ]
  );

  const handleClearChat = useCallback(async () => {
    try {
      if (selectedFindingIndex !== null && findingId) {
        await fetch(
          `/api/engineer/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`,
          { method: "DELETE" }
        );
        queryClient.setQueryData(
          queryKeys.findingChatHistory(ticketId, findingId, repoPath),
          {
            messages: [],
            ticketId,
            repoPath,
            findingId,
          }
        );
      } else {
        await fetch(
          `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          { method: "DELETE" }
        );
        queryClient.setQueryData(
          queryKeys.symphonyChatHistory(ticketId, repoPath),
          {
            messages: [],
            ticketId,
            repoPath,
          }
        );
      }
    } catch {
      // Best-effort clear
    }
  }, [selectedFindingIndex, findingId, ticketId, repoPath, queryClient]);

  const clearAllFindingChats = useCallback(async () => {
    if (!findings) {
      return;
    }
    const promises = findings.findings.map((_, idx) => {
      const fId = `finding-${idx}`;
      return fetch(
        `/api/engineer/codex/finding-chat/${encodeURIComponent(fId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`,
        { method: "DELETE" }
      ).catch(() => {});
    });
    await Promise.all(promises);
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] === "finding-chat-history",
    });
  }, [findings, ticketId, repoPath, queryClient]);

  const handleDone = useCallback(async () => {
    resetReviewState();
    try {
      await Promise.all([
        fetch(
          `/api/engineer/codex/status/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          { method: "DELETE" }
        ),
        fetch(
          `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          { method: "DELETE" }
        ),
        clearAllFindingChats(),
      ]);
      queryClient.setQueryData(["codex-review-status", ticketId, repoPath], {
        hasReview: false,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
      });
    } catch {
      // Best-effort clear
    }
    onOpenChange(false);
  }, [
    resetReviewState,
    ticketId,
    repoPath,
    clearAllFindingChats,
    queryClient,
    onOpenChange,
  ]);

  const handleStartNewReview = useCallback(async () => {
    pendingNewReview.add(ticketId);
    resetReviewState();
    setShowConfig(true);
    try {
      await Promise.all([
        fetch(
          `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          { method: "DELETE" }
        ),
        clearAllFindingChats(),
      ]);
      queryClient.invalidateQueries({
        queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
      });
    } catch {
      // Best-effort clear
    }
  }, [ticketId, resetReviewState, repoPath, clearAllFindingChats, queryClient]);

  // --- Render ---
  if (chatMode && findings) {
    return (
      <ChatModeView
        activeChatHistory={activeChatHistory}
        activeStream={activeStream}
        chatHistory={chatHistory}
        chatInput={chatInput}
        chatMessages={chatMessages}
        debate={debate}
        dismissedFindings={dismissedFindings}
        expandedFindings={expandedFindings}
        findings={findings}
        isCompleted={!!isCompleted}
        isExpanded={isExpanded}
        learningsCount={learnings.count}
        learningsStatus={learnings.status}
        onAction={handleChatAction}
        onChatInputChange={setChatInput}
        onClearChat={handleClearChat}
        onExitChatMode={() => {
          setChatMode(false);
          setSelectedFindingIndex(null);
        }}
        onOpenChange={onOpenChange}
        onOpenFindingChat={openFindingChat}
        onSelectFinding={selectFinding}
        onSendChat={handleSendChat}
        onToggleExpand={() => setIsExpanded((v) => !v)}
        onToggleFindingDismiss={toggleFindingDismissed}
        onToggleFindingExpand={toggleFindingExpanded}
        open={open}
        selectedFindingIndex={selectedFindingIndex}
        ticketId={ticketId}
      />
    );
  }

  return (
    <DefaultView
      dismissedFindings={dismissedFindings}
      expandedFindings={expandedFindings}
      findings={findings}
      instructions={instructions}
      isCompleted={!!isCompleted}
      isRunning={!!isRunning}
      isStarting={isStarting}
      localOutput={localOutput}
      model={model}
      onDiscussFindings={handleDiscussFindings}
      onDone={handleDone}
      onInstructionsChange={setInstructions}
      onModelChange={setModel}
      onOpenChange={onOpenChange}
      onOpenFindingChat={openFindingChat}
      onReasoningEffortChange={setReasoningEffort}
      onReviewModeChange={setReviewMode}
      onStartNewReview={handleStartNewReview}
      onStartReview={handleStartReview}
      onStopReview={handleStopReview}
      onToggleFindingDismiss={toggleFindingDismissed}
      onToggleFindingExpand={toggleFindingExpanded}
      onToggleOutput={() => setOutputExpanded((v) => !v)}
      open={open}
      outputExpanded={outputExpanded}
      reasoningEffort={reasoningEffort}
      reviewMode={reviewMode}
      reviewStatusConfig={reviewStatus?.config}
      showConfig={showConfig}
      ticketId={ticketId}
    />
  );
}

// --- Extracted helpers (outside component to avoid cognitive complexity contribution) ---

async function streamReviewResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  setOutput: (value: string) => void,
  onDone: () => void
) {
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
        const event = JSON.parse(line);
        if (event.type === "output" && event.content) {
          accumulated += event.content;
          setOutput(accumulated);
        } else if (event.type === "done") {
          onDone();
        } else if (event.type === "error") {
          toast.error("Review error", { description: event.content });
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  return accumulated;
}

function buildFindingDisplayMessage(
  finding: {
    severity: string;
    priority?: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  },
  idx: number
): string {
  const parts: string[] = ["<context>", `# Code Review Finding #${idx + 1}`];
  parts.push(`- **Severity:** ${finding.severity.toUpperCase()}`);
  if (finding.priority) {
    parts.push(`- **Priority:** ${finding.priority}`);
  }
  if (finding.file) {
    const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    parts.push(`- **Location:** \`${loc}\``);
  }
  parts.push(`- **Message:** ${finding.message}`);
  if (finding.suggestion) {
    parts.push(`- **Suggestion:** ${finding.suggestion}`);
  }
  parts.push(
    "</context>",
    "",
    "Analyze this finding and assess whether it is valid or a false positive."
  );
  return parts.join("\n");
}

type DismissActionContext = {
  selectedFindingIndex: number | null;
  currentDebateFindingIndex: number | null;
  setDismissedFindings: React.Dispatch<React.SetStateAction<Set<number>>>;
  setCurrentDebateFindingIndex: React.Dispatch<
    React.SetStateAction<number | null>
  >;
  ticketId: string;
  repoPath: string;
  queryClient: ReturnType<typeof useQueryClient>;
  debate: ReturnType<typeof useCodexDebate>;
  setChatMode: React.Dispatch<React.SetStateAction<boolean>>;
};

function handleDismissAction(ctx: DismissActionContext) {
  const {
    selectedFindingIndex,
    currentDebateFindingIndex,
    setDismissedFindings,
    setCurrentDebateFindingIndex,
    ticketId,
    repoPath,
    queryClient,
    debate,
    setChatMode,
  } = ctx;
  const dismissIdx = selectedFindingIndex ?? currentDebateFindingIndex;
  if (dismissIdx !== null) {
    setDismissedFindings((prev) => new Set(prev).add(dismissIdx));
    setCurrentDebateFindingIndex(null);
    const dId = `finding-${dismissIdx}`;
    fetch(
      `/api/engineer/codex/finding-chat/${encodeURIComponent(dId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`,
      { method: "DELETE" }
    ).catch(() => {});
    queryClient.setQueryData(
      queryKeys.findingChatHistory(ticketId, dId, repoPath),
      {
        messages: [],
        ticketId,
        repoPath,
        findingId: dId,
      }
    );
  }
  debate.handleEndDebate();
  setChatMode(false);
}

function trackDebateFinding(
  message: string,
  findings: { findings: { message: string }[] },
  setCurrentDebateFindingIndex: React.Dispatch<
    React.SetStateAction<number | null>
  >
) {
  const desc = message.slice("argue_codex:".length).trim().toLowerCase();
  const matchIdx = findings.findings.findIndex((f) => {
    const findingTitle = f.message.split("\n")[0].toLowerCase();
    return (
      findingTitle.includes(desc) || desc.includes(findingTitle.slice(0, 50))
    );
  });
  if (matchIdx >= 0) {
    setCurrentDebateFindingIndex(matchIdx);
  }
}

type SendActionContext = {
  selectedFindingIndex: number | null;
  findingId: string | null;
  ticketId: string;
  repoPath: string;
  model: string;
  findingStream: ReturnType<typeof useChatStream>;
  stream: ReturnType<typeof useChatStream>;
  queryClient: ReturnType<typeof useQueryClient>;
  onLearnings?: () => void;
  onLearningsUsed?: (used: LearningUsed[]) => void;
};

function sendActionMessage(ctx: SendActionContext, message: string) {
  const {
    selectedFindingIndex,
    findingId,
    ticketId,
    repoPath,
    model,
    findingStream,
    stream,
    queryClient,
    onLearnings,
    onLearningsUsed,
  } = ctx;
  if (selectedFindingIndex !== null && findingId) {
    const url = `/api/engineer/codex/finding-chat/${encodeURIComponent(findingId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}`;
    findingStream.sendMessage(
      url,
      { message },
      {
        onLearnings,
        onLearningsUsed,
        onComplete: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.findingChatHistory(
              ticketId,
              findingId,
              repoPath
            ),
          }),
      }
    );
  } else {
    const url = `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
    stream.sendMessage(
      url,
      { message, activeTab: "plan", codexReview: { model } },
      {
        onLearnings,
        onLearningsUsed,
        onComplete: () =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyChatHistory(ticketId, repoPath),
          }),
      }
    );
  }
}

// --- Custom hooks for effects (extracted to reduce cognitive complexity) ---

function useSyncOutput(
  showConfig: boolean,
  isStarting: boolean,
  ticketId: string,
  log: string | undefined,
  localOutput: string,
  setLocalOutput: React.Dispatch<React.SetStateAction<string>>
) {
  useEffect(() => {
    if (
      !(showConfig || isStarting || pendingNewReview.has(ticketId)) &&
      log &&
      log !== localOutput
    ) {
      setLocalOutput(log);
    }
  }, [log, localOutput, showConfig, isStarting, ticketId, setLocalOutput]);
}

function useParseFindings(
  showConfig: boolean,
  isStarting: boolean,
  ticketId: string,
  isCompleted: boolean | undefined,
  localOutput: string,
  findings: ReviewFindings | null,
  setFindings: React.Dispatch<React.SetStateAction<ReviewFindings | null>>
) {
  useEffect(() => {
    if (
      !(showConfig || isStarting || pendingNewReview.has(ticketId)) &&
      isCompleted &&
      localOutput &&
      !findings
    ) {
      setFindings(parseCodexReviewOutput(localOutput));
    }
  }, [
    isCompleted,
    localOutput,
    findings,
    showConfig,
    isStarting,
    ticketId,
    setFindings,
  ]);
}

function usePersistPreference(key: string, value: string) {
  useEffect(() => {
    if (globalThis.window !== undefined) {
      localStorage.setItem(key, value);
    }
  }, [key, value]);
}

function useResetOnClose(
  open: boolean,
  isRunning: boolean | undefined,
  resetFn: () => void
) {
  // Use a ref for resetFn so the effect only fires when open/isRunning change,
  // not when the callback identity changes (which can cause infinite loops if
  // the callback depends on objects that get new references every render).
  const resetFnRef = useRef(resetFn);
  resetFnRef.current = resetFn;

  useEffect(() => {
    if (!(open || isRunning)) {
      resetFnRef.current();
    }
  }, [open, isRunning]);
}

function useRefetchOnOpen(open: boolean, refetchStatus: () => void) {
  useEffect(() => {
    if (open) {
      refetchStatus();
    }
  }, [open, refetchStatus]);
}
