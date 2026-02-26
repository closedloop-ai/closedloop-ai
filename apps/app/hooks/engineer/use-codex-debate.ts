"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ChatMessage,
  ContentBlock,
} from "@/components/engineer/chat/types";
import { useChatStream } from "@/hooks/engineer/use-chat-stream";
import {
  type DebateStatus,
  parseDebateStatus,
  parseSuggestedActions,
  type SuggestedAction,
  stripContextBlocks,
} from "@/lib/engineer/chat-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";

type UseCodexDebateOptions = {
  ticketId: string;
  repoPath: string;
  model: string;
  chatHistory?: { messages: ChatMessage[] };
  claudeStream: ReturnType<typeof useChatStream>;
  /** Override where debate messages are saved (default: symphony chat-history) */
  saveEndpoint?: string;
  /** Override which query key to invalidate after saving (default: symphonyChatHistory) */
  invalidateKey?: readonly unknown[];
  /** Override URL to POST Claude messages during debate (default: /api/engineer/symphony/chat/{ticketId}?repo=...) */
  claudeUrl?: string;
  /** Override URL to GET latest messages after Claude responds (default: /api/engineer/symphony/chat-history/{ticketId}?repo=...) */
  historyUrl?: string;
  /** Optional middle action shown between the primary and "End debate" buttons.
   *  Defaults to none. CodexReviewDialog passes { label: "Dismiss Finding", message: "/dismiss" }. */
  middleAction?: SuggestedAction;
  /** Forwarded to claudeStream.sendMessage callbacks to trigger learnings polling. */
  onLearnings?: () => void;
};

type UseCodexDebateReturn = {
  // State
  debateMode: boolean;
  debateFinding: string;
  lastDebateSender: "claude" | "codex";
  codexStream: ReturnType<typeof useChatStream>;
  autoDebate: boolean;
  setAutoDebate: (enabled: boolean) => void;
  currentRound: number;
  lastDebateStatus: DebateStatus | null;
  maxRounds: number;

  // Handlers
  handleAction: (message: string) => boolean;
  handleLetClaudeRespond: () => Promise<void>;
  handleSendToCodex: () => Promise<void>;
  sendHumanToCodex: (prompt: string, displayContent: string) => Promise<void>;
  handleEndDebate: () => void;
  startDebateMode: () => Promise<void>;
  stopCodex: () => void;
  reset: () => void;

  // Rendering helpers
  getEffectiveSender: (msg: ChatMessage) => "claude" | "codex" | undefined;
  getDebateActions: (
    msg: ChatMessage,
    isLast: boolean,
    isAnyStreaming: boolean
  ) => SuggestedAction[];
};

/**
 * Shared hook encapsulating all debate-with-Codex logic.
 * Any chat component can use this to support the argue_codex: action flow.
 */
export function useCodexDebate({
  ticketId,
  repoPath,
  model,
  chatHistory,
  claudeStream,
  saveEndpoint,
  invalidateKey,
  claudeUrl: claudeUrlProp,
  historyUrl: historyUrlProp,
  middleAction,
  onLearnings,
}: Readonly<UseCodexDebateOptions>): UseCodexDebateReturn {
  const MAX_ROUNDS = 10;

  const [debateMode, setDebateMode] = useState(false);
  const [debateFinding, setDebateFinding] = useState("");
  const [debateHistory, setDebateHistory] = useState<
    { sender: string; content: string }[]
  >([]);
  const [lastDebateSender, setLastDebateSender] = useState<"claude" | "codex">(
    "claude"
  );
  const [autoDebate, setAutoDebateState] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [lastDebateStatus, setLastDebateStatus] = useState<DebateStatus | null>(
    null
  );
  const autoDebateRef = useRef(false);
  const currentRoundRef = useRef(0);
  const codexAbortRef = useRef<AbortController | null>(null);
  // Refs for callbacks used inside sendToCodex to avoid circular deps
  const handleLetClaudeRespondRef = useRef<(() => Promise<void>) | undefined>(
    undefined
  );
  const handleSendToCodexRef = useRef<(() => Promise<void>) | undefined>(
    undefined
  );
  const handleConsensusReachedRef = useRef<
    ((issues: DebateStatus["resolvedIssues"]) => void) | undefined
  >(undefined);

  const codexStream = useChatStream();
  const queryClient = useQueryClient();

  const setAutoDebate = useCallback(
    (enabled: boolean) => {
      setAutoDebateState(enabled);
      autoDebateRef.current = enabled;
      // When toggled on mid-debate with no active streams, kick off the next turn
      if (
        enabled &&
        debateMode &&
        debateHistory.length > 0 &&
        !codexStream.pendingUserMessage &&
        !claudeStream.isStreaming
      ) {
        if (lastDebateSender === "codex") {
          setTimeout(() => handleLetClaudeRespondRef.current?.(), 100);
        } else if (lastDebateSender === "claude") {
          setTimeout(() => handleSendToCodexRef.current?.(), 100);
        }
      }
    },
    [
      debateMode,
      debateHistory.length,
      lastDebateSender,
      codexStream.pendingUserMessage,
      claudeStream.isStreaming,
    ]
  );

  const saveDebateMessage = useCallback(
    async (
      content: string,
      sender: "claude" | "codex",
      blocks?: ContentBlock[]
    ) => {
      const msg: ChatMessage = {
        id: `${sender}-${Date.now()}`,
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
        sender,
        blocks: blocks && blocks.length > 0 ? blocks : undefined,
      };
      const url =
        saveEndpoint ||
        `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      const method = saveEndpoint ? "PATCH" : "POST";
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      await queryClient.invalidateQueries({
        queryKey:
          invalidateKey || queryKeys.symphonyChatHistory(ticketId, repoPath),
      });
    },
    [ticketId, repoPath, queryClient, saveEndpoint, invalidateKey]
  );

  const sendToCodex = useCallback(
    async (
      claudeArgument: string,
      finding: string,
      history: { sender: string; content: string }[]
    ) => {
      const url = `/api/engineer/codex/argue/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      const startedAt = new Date().toISOString();

      const abortController = new AbortController();
      codexAbortRef.current = abortController;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            claudeArgument,
            findingSummary: finding,
            debateHistory: history,
            model,
            repoPath,
            reasoningEffort: "xhigh",
          }),
          signal: abortController.signal,
        });
      } catch (err) {
        codexAbortRef.current = null;
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        toast.error("Failed to reach Codex", {
          description: err instanceof Error ? err.message : "Network error",
        });
        return;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        toast.error("Failed to send to Codex", {
          description: `${response.status}: ${body.slice(0, 200)}`,
        });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        codexAbortRef.current = null;
        return;
      }

      const decoder = new TextDecoder();
      let accumulated = "";
      let receivedAnyText = false;
      const reasoningBlocks: ContentBlock[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value);
          const lines = chunk.split("\n").filter((l) => l.trim());

          for (const line of lines) {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              // Not valid JSON — skip
              continue;
            }

            if (event.type === "reasoning" && event.content) {
              reasoningBlocks.push({
                type: "thinking",
                id: `reasoning-${Date.now()}-${reasoningBlocks.length}`,
                thinking: event.content as string,
              });
              codexStream.setPendingUserMessage({
                id: "codex-streaming",
                role: "assistant",
                content: accumulated,
                timestamp: startedAt,
                sender: "codex",
                blocks: [...reasoningBlocks],
              });
            } else if (event.type === "text" && event.content) {
              receivedAnyText = true;
              accumulated += event.content;
              codexStream.setPendingUserMessage({
                id: "codex-streaming",
                role: "assistant",
                content: accumulated,
                timestamp: startedAt,
                sender: "codex",
                blocks:
                  reasoningBlocks.length > 0 ? [...reasoningBlocks] : undefined,
              });
            } else if (event.type === "error") {
              console.error("[codex-debate] Server error:", event.error);
              toast.error("Codex error", {
                description: String(event.error).slice(0, 200),
              });
            } else if (event.type === "done") {
              const finalContent = (event.content as string) || accumulated;
              codexStream.setPendingUserMessage(null);
              if (finalContent.trim()) {
                // Strip debate-status from displayed content
                const { cleanContent } = parseDebateStatus(finalContent.trim());
                // Set sender BEFORE saving — saveDebateMessage triggers query
                // invalidation which re-renders the UI; lastDebateSender must
                // already be "codex" so the correct action buttons appear.
                setLastDebateSender("codex");
                setDebateHistory((prev) => [
                  ...prev,
                  { sender: "codex", content: cleanContent },
                ]);
                try {
                  await saveDebateMessage(
                    cleanContent,
                    "codex",
                    reasoningBlocks.length > 0 ? reasoningBlocks : undefined
                  );
                } catch (err) {
                  console.error("[codex-debate] Failed to save message:", err);
                }

                // Parse debate status from Codex response (prefer server-parsed, fallback to client)
                const debateStatus: DebateStatus | null =
                  (event.debateStatus as DebateStatus | null) ??
                  parseDebateStatus(finalContent.trim()).status;
                setLastDebateStatus(debateStatus);
                const newRound = currentRoundRef.current + 1;
                setCurrentRound(newRound);
                currentRoundRef.current = newRound;

                // Auto-advance if enabled
                if (autoDebateRef.current) {
                  console.log(
                    "[codex-debate] Auto-advance: Codex done, forwarding to Claude (round %d)",
                    newRound
                  );
                  const consensusReached =
                    debateStatus?.pendingIssues?.length === 0;
                  if (consensusReached && debateStatus) {
                    handleConsensusReachedRef.current?.(
                      debateStatus.resolvedIssues
                    );
                  } else if (currentRoundRef.current < MAX_ROUNDS) {
                    setTimeout(() => {
                      console.log(
                        "[codex-debate] Auto-advance: triggering handleLetClaudeRespond"
                      );
                      handleLetClaudeRespondRef
                        .current?.()
                        ?.catch((err: unknown) => {
                          console.error(
                            "[codex-debate] Auto-advance to Claude failed:",
                            err
                          );
                        });
                    }, 500);
                  }
                }
              } else if (!receivedAnyText) {
                toast.error("Codex returned no response", {
                  description: `Exit code: ${event.exitCode ?? "unknown"}`,
                });
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User stopped — save partial content if any
          codexStream.setPendingUserMessage(null);
          if (accumulated.trim()) {
            const { cleanContent } = parseDebateStatus(accumulated.trim());
            setLastDebateSender("codex");
            setDebateHistory((prev) => [
              ...prev,
              {
                sender: "codex",
                content: `${cleanContent}\n\n_(stopped by user)_`,
              },
            ]);
            await saveDebateMessage(
              `${cleanContent}\n\n_(stopped by user)_`,
              "codex",
              reasoningBlocks.length > 0 ? reasoningBlocks : undefined
            ).catch(() => {});
          }
        } else {
          throw err;
        }
      } finally {
        codexAbortRef.current = null;
      }
    },
    [ticketId, repoPath, model, codexStream, saveDebateMessage]
  );

  const handleDebateAction = useCallback(
    async (actionMessage: string) => {
      const finding = actionMessage.replace(/^argue_codex:/, "").trim();
      setDebateMode(true);
      setDebateFinding(finding);
      setCurrentRound(0);
      currentRoundRef.current = 0;
      setLastDebateStatus(null);

      // Set a pending placeholder immediately so isAnyStreaming is true
      // (prevents debate actions from flashing before Codex responds)
      codexStream.setPendingUserMessage({
        id: "codex-pending",
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        sender: "codex",
      });

      // Get Claude's last assistant message as the opening argument
      const lastAssistant = [...(chatHistory?.messages || [])]
        .reverse()
        .find((m) => m.role === "assistant");
      const claudeAnalysis = lastAssistant
        ? stripContextBlocks(
            parseSuggestedActions(lastAssistant.content).contentWithoutActions
          )
        : finding;

      const openingArgument = `Hey Codex, this is Claude from Anthropic. I want to debate your finding about "${finding}" — the goal is for us to figure out the right answer together. Here's my analysis:\n\n${claudeAnalysis}`;

      // Save Claude's opening argument as a chat message
      await saveDebateMessage(openingArgument, "claude");
      const initialHistory = [{ sender: "claude", content: openingArgument }];
      setDebateHistory(initialHistory);
      setLastDebateSender("claude");

      // Send to Codex
      await sendToCodex(openingArgument, finding, initialHistory);
    },
    [chatHistory?.messages, saveDebateMessage, sendToCodex, codexStream]
  );

  const handleLetClaudeRespond = useCallback(async () => {
    // Get Codex's last response from debate history
    const codexResponse = [...debateHistory]
      .reverse()
      .find((t) => t.sender === "codex");
    if (!codexResponse) {
      return;
    }

    const claudePrompt = `You are in a structured debate with Codex (OpenAI) about: "${debateFinding}". The goal is to find the correct answer, not to win. If Codex makes a valid point, acknowledge it and update your position.\n\nHere's Codex's latest response:\n\n${codexResponse.content}\n\nRespond to Codex directly. Cite specific code evidence. If you now agree with Codex, say so clearly. If you still disagree, explain exactly why.\n\n## DEBATE STATUS TRACKING\nAt the END of your response (before any <suggested-actions>), include a debate status block:\n\n<debate-status>\n{"pendingIssues": [{"id": "1", "summary": "Unresolved point"}],\n "resolvedIssues": [{"id": "1", "summary": "Resolved point", "resolution": "How resolved"}]}\n</debate-status>\n\nRules:\n- Every issue discussed should appear in exactly one list\n- Move issues from pending to resolved as agreement is reached\n- When you fully agree with Codex on ALL points, pendingIssues must be empty []\n- Always include this block\n\n## DEBATE ACTION BUTTONS\nDo NOT include generic action buttons in this response. Instead, follow these rules:\n- If you DISAGREE or have further points, do NOT include any action buttons — the UI will provide debate-turn buttons automatically.\n- If you FULLY AGREE with Codex and the debate is resolved, include ONLY this action to apply the consensus:\n<suggested-actions>\n<action label="Update Plan">Please update the implementation plan to reflect the consensus reached in this debate.</action>\n</suggested-actions>\nNever include a "Send to Codex" or "Debate Codex" button — the UI handles debate flow.`;

    // Send to Claude via existing chat endpoint
    claudeStream.setPendingUserMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: "[Debate] Codex responded. Let Claude counter.",
      timestamp: new Date().toISOString(),
    });

    const url =
      claudeUrlProp ||
      `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
    await claudeStream.sendMessage(
      url,
      {
        message: claudePrompt,
        activeTab: "plan",
        codexReview: { model },
      },
      {
        onLearnings,
        onComplete: async () => {
          let cleanContent = "";
          let debateStatus: DebateStatus | null = null;

          try {
            await queryClient.invalidateQueries({
              queryKey:
                invalidateKey ||
                queryKeys.symphonyChatHistory(ticketId, repoPath),
            });
            // Fetch the latest messages to get Claude's response for debate history
            const fetchHistoryUrl =
              historyUrlProp ||
              `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
            const res = await fetch(fetchHistoryUrl);
            const data = await res.json();
            const messages = data.messages || [];
            const lastMsg = messages.at(-1);
            if (lastMsg?.role === "assistant") {
              // Strip debate-status and suggested-actions from content
              const parsed = parseDebateStatus(lastMsg.content);
              debateStatus = parsed.status;
              cleanContent = stripContextBlocks(
                parseSuggestedActions(parsed.cleanContent).contentWithoutActions
              );
              setDebateHistory((prev) => [
                ...prev,
                { sender: "claude", content: cleanContent },
              ]);
              setLastDebateSender("claude");
              setLastDebateStatus(debateStatus);
            } else {
              console.warn(
                "[codex-debate] onComplete: last message not assistant, got:",
                lastMsg?.role
              );
            }
          } catch (err) {
            console.error(
              "[codex-debate] onComplete: failed to fetch/parse history:",
              err
            );
          }

          // Auto-advance — runs even if saving had issues, as long as debate history was updated
          if (autoDebateRef.current && cleanContent) {
            console.log(
              "[codex-debate] Auto-advance: Claude done, forwarding to Codex"
            );
            const consensusReached = debateStatus?.pendingIssues?.length === 0;
            if (consensusReached && debateStatus) {
              handleConsensusReachedRef.current?.(debateStatus.resolvedIssues);
            } else if (currentRoundRef.current < MAX_ROUNDS) {
              setTimeout(() => {
                console.log(
                  "[codex-debate] Auto-advance: triggering handleSendToCodex"
                );
                handleSendToCodexRef.current?.()?.catch((err: unknown) => {
                  console.error(
                    "[codex-debate] Auto-advance to Codex failed:",
                    err
                  );
                });
              }, 500);
            }
          }
        },
      }
    );
  }, [
    debateHistory,
    debateFinding,
    claudeStream,
    ticketId,
    repoPath,
    model,
    queryClient,
    onLearnings,
    claudeUrlProp,
    historyUrlProp,
    invalidateKey,
  ]);

  const handleSendToCodex = useCallback(async () => {
    const claudeResponse = [...debateHistory]
      .reverse()
      .find((t) => t.sender === "claude");
    if (!claudeResponse) {
      return;
    }

    // Show immediate placeholder so the UI reflects streaming state
    codexStream.setPendingUserMessage({
      id: "codex-pending",
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      sender: "codex",
    });

    await sendToCodex(claudeResponse.content, debateFinding, debateHistory);
  }, [debateHistory, debateFinding, sendToCodex, codexStream]);

  /**
   * Triggered when auto-debate detects consensus (pendingIssues empty).
   * Sends one final Claude message summarizing the consensus.
   */
  const handleConsensusReached = useCallback(
    async (resolvedIssues: DebateStatus["resolvedIssues"]) => {
      const issuesSummary = resolvedIssues
        .map(
          (issue, i) => `${i + 1}. **${issue.summary}** — ${issue.resolution}`
        )
        .join("\n");
      const summaryPrompt =
        `The structured debate about "${debateFinding}" has concluded. You and Codex have reached consensus on all points.\n\n` +
        `## Resolved Issues\n${issuesSummary}\n\n` +
        "Write a final summary of the consensus and list the specific changes you will make to the implementation plan. Be concrete — reference file names, function names, and specific modifications.\n\n" +
        `<suggested-actions>\n<action label="Update Plan">Please update the implementation plan to reflect the consensus reached in this debate.</action>\n</suggested-actions>`;

      claudeStream.setPendingUserMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: "[Debate] Consensus reached. Claude summarizing.",
        timestamp: new Date().toISOString(),
      });

      const url =
        claudeUrlProp ||
        `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      await claudeStream.sendMessage(
        url,
        {
          message: summaryPrompt,
          activeTab: "plan",
          codexReview: { model },
        },
        {
          onLearnings,
          onComplete: async () => {
            await queryClient.invalidateQueries({
              queryKey:
                invalidateKey ||
                queryKeys.symphonyChatHistory(ticketId, repoPath),
            });
            // Auto-debate is done — disable auto mode
            setAutoDebateState(false);
            autoDebateRef.current = false;
          },
        }
      );
    },
    [
      debateFinding,
      claudeStream,
      ticketId,
      repoPath,
      model,
      queryClient,
      onLearnings,
      claudeUrlProp,
      invalidateKey,
    ]
  );

  // Keep refs in sync with latest callbacks
  useEffect(() => {
    handleLetClaudeRespondRef.current = handleLetClaudeRespond;
    handleSendToCodexRef.current = handleSendToCodex;
    handleConsensusReachedRef.current = handleConsensusReached;
  });

  // Restore debate mode from persisted history on initial load
  const hasRestoredDebateRef = useRef(false);
  useEffect(() => {
    if (hasRestoredDebateRef.current || debateMode) {
      return;
    }
    const messages = chatHistory?.messages;
    if (!messages || messages.length === 0) {
      return;
    }

    // Scan from newest to oldest for the first debate marker
    let lastStartIdx = -1;
    let lastEndIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content;
      if (c === "__debate_started__" && lastStartIdx === -1) {
        lastStartIdx = i;
      }
      if (c === "__debate_ended__" && lastEndIdx === -1) {
        lastEndIdx = i;
      }
      if (lastStartIdx !== -1 && lastEndIdx !== -1) {
        break;
      }
    }

    hasRestoredDebateRef.current = true;

    // Debate is active if started after last end (or never ended)
    if (lastStartIdx === -1 || lastStartIdx < lastEndIdx) {
      return;
    }

    // Rebuild debate history from messages after the start marker
    const debateMessages = messages.slice(lastStartIdx + 1);
    const restored: { sender: string; content: string }[] = [];
    let sender: "claude" | "codex" = "claude";

    for (const msg of debateMessages) {
      if (msg.sender === "claude" || msg.sender === "codex") {
        const { cleanContent } = parseDebateStatus(msg.content);
        const stripped = stripContextBlocks(
          parseSuggestedActions(cleanContent).contentWithoutActions
        );
        restored.push({ sender: msg.sender, content: stripped });
        sender = msg.sender;
      }
    }

    setDebateMode(true); // eslint-disable-line react-hooks/set-state-in-effect
    setDebateFinding("User initiated debate");
    setDebateHistory(restored);
    setLastDebateSender(sender);
  }, [chatHistory?.messages, debateMode]);

  /**
   * Send a human user's message directly to Codex in an active debate.
   * Wraps the message so Codex knows it's from a human, not Claude.
   */
  const sendHumanToCodex = useCallback(
    async (prompt: string, displayContent: string) => {
      // Save the human message to chat history as a regular user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: displayContent,
        timestamp: new Date().toISOString(),
      };
      const url =
        saveEndpoint ||
        `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;
      const method = saveEndpoint ? "PATCH" : "POST";
      await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg }),
      });
      await queryClient.invalidateQueries({
        queryKey:
          invalidateKey || queryKeys.symphonyChatHistory(ticketId, repoPath),
      });

      // Wrap the prompt so Codex knows a human developer is speaking
      const wrappedPrompt = `A human developer is now speaking to you directly (not Claude). Please respond to them:\n\n${prompt}`;

      // Add to debate history and send via the argue endpoint
      setDebateHistory((prev) => [
        ...prev,
        { sender: "user", content: prompt },
      ]);
      await sendToCodex(wrappedPrompt, debateFinding, [
        ...debateHistory,
        { sender: "user", content: prompt },
      ]);
    },
    [
      ticketId,
      repoPath,
      queryClient,
      debateFinding,
      debateHistory,
      sendToCodex,
      saveEndpoint,
      invalidateKey,
    ]
  );

  const startDebateMode = useCallback(async () => {
    const finding = "User initiated debate";
    setDebateMode(true);
    setDebateFinding(finding);
    setCurrentRound(0);
    currentRoundRef.current = 0;
    setLastDebateStatus(null);

    // Auto-initiate: find the last assistant message and forward to Codex
    const lastAssistant = [...(chatHistory?.messages || [])]
      .reverse()
      .find((m) => m.role === "assistant");

    if (lastAssistant) {
      // Set pending placeholder so isAnyStreaming is true immediately
      codexStream.setPendingUserMessage({
        id: "codex-pending",
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        sender: "codex",
      });

      const claudeAnalysis = stripContextBlocks(
        parseSuggestedActions(lastAssistant.content).contentWithoutActions
      );
      const openingArgument =
        "Hey Codex, this is Claude from Anthropic. I want to debate this — " +
        "the goal is for us to figure out the right answer together. " +
        `Here's my analysis:\n\n${claudeAnalysis}`;

      await saveDebateMessage(openingArgument, "claude");
      const initialHistory = [{ sender: "claude", content: openingArgument }];
      setDebateHistory(initialHistory);
      setLastDebateSender("claude");

      await sendToCodex(openingArgument, finding, initialHistory);
    } else {
      setLastDebateSender("claude");
    }
  }, [chatHistory?.messages, saveDebateMessage, sendToCodex, codexStream]);

  const stopCodex = useCallback(() => {
    codexAbortRef.current?.abort();
  }, []);

  const handleEndDebate = useCallback(() => {
    setDebateMode(false);
    setDebateFinding("");
    setDebateHistory([]);
    setLastDebateSender("claude");
    setAutoDebateState(false);
    autoDebateRef.current = false;
    setCurrentRound(0);
    currentRoundRef.current = 0;
    setLastDebateStatus(null);
  }, []);

  const reset = useCallback(() => {
    handleEndDebate();
  }, [handleEndDebate]);

  /**
   * Returns true if the action was handled (argue_codex: prefix or debate internal action).
   * The consumer should return early when true.
   */
  const handleAction = useCallback(
    (message: string): boolean => {
      if (message === "__debate_claude_respond__") {
        handleLetClaudeRespond();
        return true;
      }
      if (message === "__debate_send_codex__") {
        handleSendToCodex();
        return true;
      }
      if (message === "__debate_continue__") {
        setCurrentRound(0);
        currentRoundRef.current = 0;
        setAutoDebateState(true);
        autoDebateRef.current = true;
        // Re-trigger the next turn based on who spoke last
        if (lastDebateSender === "codex") {
          handleLetClaudeRespond();
        } else {
          handleSendToCodex();
        }
        return true;
      }
      if (message === "__debate_end__") {
        handleEndDebate();
        return true;
      }
      if (message.startsWith("argue_codex:")) {
        handleDebateAction(message);
        return true;
      }
      return false;
    },
    [
      handleLetClaudeRespond,
      handleSendToCodex,
      handleEndDebate,
      handleDebateAction,
      lastDebateSender,
    ]
  );

  /**
   * In debate mode, assistant messages without explicit sender are from Claude.
   */
  const getEffectiveSender = useCallback(
    (msg: ChatMessage): "claude" | "codex" | undefined => {
      if (msg.sender) {
        return msg.sender;
      }
      if (debateMode && msg.role === "assistant") {
        return "claude";
      }
      return undefined;
    },
    [debateMode]
  );

  /**
   * Returns debate-turn action buttons when applicable, empty array otherwise.
   * Consumers merge this with normal parsed actions (debate actions take priority when present).
   */
  const getDebateActions = useCallback(
    (
      _msg: ChatMessage,
      isLast: boolean,
      isAnyStreaming: boolean
    ): SuggestedAction[] => {
      if (!(debateMode && isLast) || isAnyStreaming) {
        return [];
      }

      // When max rounds hit during auto-debate, show "Continue debate" option
      if (currentRoundRef.current >= MAX_ROUNDS) {
        const actions: SuggestedAction[] = [];
        // Show the normal next-turn button
        if (lastDebateSender === "codex") {
          actions.push({
            label: "Let Claude respond",
            message: "__debate_claude_respond__",
          });
        } else if (lastDebateSender === "claude") {
          actions.push({
            label: "Send to Codex",
            message: "__debate_send_codex__",
          });
        }
        actions.push(
          { label: "Continue debate", message: "__debate_continue__" },
          { label: "End debate", message: "__debate_end__" }
        );
        return actions;
      }

      // Show the next-turn button based on who spoke last
      if (lastDebateSender === "codex") {
        const actions: SuggestedAction[] = [
          { label: "Let Claude respond", message: "__debate_claude_respond__" },
        ];
        if (middleAction) {
          actions.push(middleAction);
        }
        actions.push({ label: "End debate", message: "__debate_end__" });
        return actions;
      }
      if (lastDebateSender === "claude") {
        const actions: SuggestedAction[] = [
          { label: "Send to Codex", message: "__debate_send_codex__" },
        ];
        if (middleAction) {
          actions.push(middleAction);
        }
        actions.push({ label: "End debate", message: "__debate_end__" });
        return actions;
      }
      return [];
    },
    [debateMode, lastDebateSender, middleAction]
  );

  return {
    debateMode,
    debateFinding,
    lastDebateSender,
    codexStream,
    autoDebate,
    setAutoDebate,
    currentRound,
    lastDebateStatus,
    maxRounds: MAX_ROUNDS,
    handleAction,
    handleLetClaudeRespond,
    handleSendToCodex,
    stopCodex,
    sendHumanToCodex,
    handleEndDebate,
    startDebateMode,
    reset,
    getEffectiveSender,
    getDebateActions,
  };
}
