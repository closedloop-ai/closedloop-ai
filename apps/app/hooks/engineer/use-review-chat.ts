"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewConfig } from "@/components/engineer/CodexReviewSettingsDialog";
import type { MentionState } from "@/components/engineer/FileMentionAutocomplete";
import { dispatchMentionKeyDown } from "@/components/engineer/FileMentionAutocomplete";
import type { useChatStream } from "@/hooks/engineer/use-chat-stream";
import {
  type SlashCommand,
  useSlashCommands,
} from "@/hooks/engineer/use-slash-commands";
import {
  CHAT_SENTINEL,
  type LearningUsed,
  MAX_CONFERRAL_DEPTH,
  parseConferralMention,
  type SuggestedAction,
  sanitizeHistoryForModel,
  stripAssistantProtocol,
} from "@/lib/engineer/chat-utils";
import {
  formatFindingContextForChat,
  formatReviewContextForChat,
  formatReviewContextForCodex,
} from "@/lib/engineer/codex-review-context";
import {
  parseClaudeReviewOutput,
  parseCodexReviewOutput,
  type ReviewFinding,
} from "@/lib/engineer/codex-review-parser";
import { queryKeys } from "@/lib/engineer/queries/keys";
import type { ChatHistory } from "@/lib/engineer/queries/symphony";

const REVIEW_SLASH_COMMANDS: SlashCommand[] = [
  {
    command: "/reflect",
    description: "Extract learnings from this conversation",
  },
];

type UseReviewChatParams = {
  ticketId: string;
  repoPath: string;
  config: ReviewConfig;
  reviewOutput: string;
  claudeIsReady: boolean;
  codexIsReady: boolean;
  stream: ReturnType<typeof useChatStream>;
  chatHistory: ChatHistory | undefined;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onLearnings?: () => void;
  onLearningsUsed?: (learnings: LearningUsed[]) => void;
  onReflect?: () => void;
};

type UseReviewChatReturn = {
  chatInput: string;
  mentionState: MentionState | null;
  mentionFiles: string[];
  streamingProvider: "claude" | "codex";
  slash: ReturnType<typeof useSlashCommands>;
  handleSendChat: () => void;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleFileSelect: (file: string) => void;
  handleChatActionForProvider: (
    action: SuggestedAction,
    provider: "claude" | "codex"
  ) => void;
  handleChatAboutFinding: (index: number, finding: ReviewFinding) => void;
  setMentionState: (state: MentionState | null) => void;
  setMentionFiles: (files: string[]) => void;
  setChatInput: (value: string) => void;
};

export function useReviewChat(
  params: UseReviewChatParams
): UseReviewChatReturn {
  const {
    ticketId,
    repoPath,
    config,
    reviewOutput,
    claudeIsReady,
    codexIsReady,
    stream,
    chatHistory,
    inputRef,
    onLearnings,
    onLearningsUsed,
    onReflect,
  } = params;

  const [chatInput, setChatInput] = useState("");
  const queryClient = useQueryClient();

  // Mention autocomplete state
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);

  // Streaming provider tracking
  const streamingProviderRef = useRef<"claude" | "codex">(config.provider);

  // Conferral infrastructure
  const conferralDepthRef = useRef(0);
  const conferralTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendChatToProviderRef = useRef<
    (target: "claude" | "codex", message: string, display: string) => void
  >(() => {});

  useEffect(() => {
    return () => {
      if (conferralTimerRef.current) {
        clearTimeout(conferralTimerRef.current);
      }
    };
  }, []);

  // Build URL + payload for a specific provider
  const buildChatRequestForProvider = useCallback(
    (
      message: string,
      targetProvider: "claude" | "codex",
      options?: { injectReviewContext?: boolean; displayContent?: string }
    ): { url: string; body: Record<string, unknown> } => {
      if (targetProvider === "codex") {
        const recentHistory = sanitizeHistoryForModel(
          (chatHistory?.messages || []).slice(-10).map((m) => ({
            role: m.role,
            content: m.content,
            sender: m.sender,
          }))
        );
        let prompt = message;
        if (options?.injectReviewContext) {
          const findings =
            config.provider === "claude"
              ? parseClaudeReviewOutput(reviewOutput)
              : parseCodexReviewOutput(reviewOutput);
          prompt = `${formatReviewContextForCodex(findings, reviewOutput, config.model)}\n\n${message}`;
        }
        return {
          url: `/api/engineer/codex/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
          body: {
            prompt,
            chatHistory: recentHistory,
            repoPath,
            activeTab: "plan",
            chatContextId: "review",
          },
        };
      }
      return {
        url: `/api/engineer/symphony/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`,
        body: {
          message,
          activeTab: "plan",
          codexReview: { model: config.model },
          provider: config.provider,
          ...(options?.displayContent
            ? { displayContent: options.displayContent }
            : {}),
        },
      };
    },
    [
      config.provider,
      config.model,
      ticketId,
      repoPath,
      chatHistory?.messages,
      reviewOutput,
    ]
  );

  // Persist a message to chat-history.json (provider-scoped)
  const persistMessage = useCallback(
    (message: {
      id: string;
      role: string;
      content: string;
      timestamp: string;
      sender?: string;
    }) =>
      fetch(
        `/api/engineer/symphony/chat-history/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}&provider=${encodeURIComponent(config.provider)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }
      ).catch(() => {
        // Non-critical — messages still show from streaming/query
      }),
    [ticketId, repoPath, config.provider]
  );

  // Reset conferral state on fresh user interactions
  const resetConferral = useCallback(() => {
    conferralDepthRef.current = 0;
    if (conferralTimerRef.current) {
      clearTimeout(conferralTimerRef.current);
      conferralTimerRef.current = null;
    }
  }, []);

  // Core send function with per-provider routing and conferral
  const sendChatToProvider = useCallback(
    (
      targetProvider: "claude" | "codex",
      message: string,
      displayContent: string
    ) => {
      streamingProviderRef.current = targetProvider;

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: displayContent,
        timestamp: new Date().toISOString(),
      };
      stream.setPendingUserMessage(userMsg);
      if (targetProvider !== "claude") {
        persistMessage(userMsg);
      }

      const needsBootstrap =
        targetProvider === "claude" ? !claudeIsReady : !codexIsReady;

      let augmentedMessage = message;
      if (needsBootstrap && targetProvider === "claude") {
        const findings =
          config.provider === "claude"
            ? parseClaudeReviewOutput(reviewOutput)
            : parseCodexReviewOutput(reviewOutput);
        const reviewContext = formatReviewContextForChat(
          findings,
          reviewOutput,
          config.model
        );
        augmentedMessage = `${reviewContext}\n\n${message}`;
      }

      const effectiveDisplayContent =
        augmentedMessage === displayContent ? undefined : displayContent;

      const { url, body } = buildChatRequestForProvider(
        augmentedMessage,
        targetProvider,
        {
          injectReviewContext: needsBootstrap && targetProvider === "codex",
          displayContent: effectiveDisplayContent,
        }
      );

      stream.sendMessage(url, body, {
        onComplete: async (accumulatedText) => {
          if (accumulatedText && targetProvider !== "claude") {
            await persistMessage({
              id: crypto.randomUUID(),
              role: "assistant",
              content: accumulatedText,
              timestamp: new Date().toISOString(),
              sender: targetProvider,
            });
          }
          await queryClient.invalidateQueries({
            queryKey: queryKeys.symphonyChatHistory(
              ticketId,
              repoPath,
              config.provider
            ),
          });

          // Conferral detection — no in-progress lock needed:
          // MAX_CONFERRAL_DEPTH caps ping-pong, and useChatStream.sendMessage
          // serializes streams via its internal isStreamingRef guard.
          if (accumulatedText) {
            const mention = parseConferralMention(
              accumulatedText,
              targetProvider
            );
            if (mention && conferralDepthRef.current < MAX_CONFERRAL_DEPTH) {
              conferralDepthRef.current++;
              const otherProvider =
                targetProvider === "claude" ? "codex" : "claude";
              const cleanedForContext = stripAssistantProtocol(accumulatedText);
              const wrappedPrompt = `${targetProvider === "claude" ? "Claude" : "Codex"} has asked for your input:\n\n${mention.prompt}\n\n<context source="${targetProvider}-response">\n${cleanedForContext}\n</context>`;
              const sentinel =
                targetProvider === "claude"
                  ? CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX
                  : CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE;
              conferralTimerRef.current = setTimeout(() => {
                sendChatToProviderRef.current(
                  otherProvider,
                  wrappedPrompt,
                  sentinel
                );
              }, 0);
            }
          }
        },
        onLearnings,
        onLearningsUsed,
      });
    },
    [
      stream.sendMessage,
      stream.setPendingUserMessage,
      persistMessage,
      buildChatRequestForProvider,
      claudeIsReady,
      codexIsReady,
      config.provider,
      config.model,
      reviewOutput,
      queryClient,
      ticketId,
      repoPath,
      onLearnings,
      onLearningsUsed,
    ]
  );

  // Keep ref in sync so conferral's async callback always calls the latest version
  sendChatToProviderRef.current = sendChatToProvider;

  // Detect @claude/@codex prefix and determine target provider
  const resolveTargetProvider = useCallback(
    (
      text: string
    ): { targetProvider: "claude" | "codex"; actualMessage: string } => {
      const claudeMatch = /^@claude\s+/i.exec(text);
      if (claudeMatch) {
        return {
          targetProvider: "claude",
          actualMessage: text.slice(claudeMatch[0].length),
        };
      }
      const codexMatch = /^@codex\s+/i.exec(text);
      if (codexMatch) {
        return {
          targetProvider: "codex",
          actualMessage: text.slice(codexMatch[0].length),
        };
      }
      return { targetProvider: config.provider, actualMessage: text };
    },
    [config.provider]
  );

  const handleSendChat = useCallback(() => {
    const trimmed = chatInput.trim();
    if (!trimmed || stream.isStreaming) {
      return;
    }
    setChatInput("");
    resetConferral();

    const { targetProvider, actualMessage } = resolveTargetProvider(trimmed);
    sendChatToProvider(targetProvider, actualMessage, trimmed);
  }, [
    chatInput,
    stream.isStreaming,
    resetConferral,
    resolveTargetProvider,
    sendChatToProvider,
  ]);

  // Route action through the message's sender, not config.provider
  const handleChatActionForProvider = useCallback(
    (action: SuggestedAction, targetProvider: "claude" | "codex") => {
      if (stream.isStreaming) {
        return;
      }
      resetConferral();
      sendChatToProvider(targetProvider, action.message, action.message);
    },
    [stream.isStreaming, resetConferral, sendChatToProvider]
  );

  const slash = useSlashCommands(REVIEW_SLASH_COMMANDS, (command) => {
    if (command === "/reflect") {
      setChatInput("");
      onReflect?.();
    }
  });

  // Mention autocomplete input handler
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;
      setChatInput(newValue);

      // Detect @ mention context
      let mentionStart = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        const char = newValue[i];
        if (char === "@") {
          if (i === 0 || /\s/.test(newValue[i - 1])) {
            mentionStart = i;
          }
          break;
        }
        if (/\s/.test(char)) {
          break;
        }
      }

      if (mentionStart >= 0) {
        setMentionState({
          isOpen: true,
          query: newValue.slice(mentionStart + 1, cursorPos),
          startIndex: mentionStart,
          selectedIndex: 0,
        });
      } else {
        setMentionState(null);
      }

      slash.detectSlash(newValue, cursorPos);
    },
    [slash]
  );

  // Handle file/provider selection from the autocomplete dropdown
  const handleFileSelect = useCallback(
    (file: string) => {
      if (!mentionState) {
        return;
      }
      if (file === "@claude" || file === "@codex") {
        const beforeMention = chatInput.slice(0, mentionState.startIndex);
        const afterMention = chatInput.slice(
          mentionState.startIndex + 1 + mentionState.query.length
        );
        setChatInput(`${beforeMention + file} ${afterMention}`);
        setMentionState(null);
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            const pos = beforeMention.length + file.length + 1;
            inputRef.current.setSelectionRange(pos, pos);
          }
        }, 0);
        return;
      }
      // Normal file mention
      const beforeMention = chatInput.slice(0, mentionState.startIndex);
      const afterMention = chatInput.slice(
        mentionState.startIndex + 1 + mentionState.query.length
      );
      setChatInput(`${beforeMention}@${file} ${afterMention}`);
      setMentionState(null);
    },
    [mentionState, chatInput, inputRef]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        mentionState?.isOpen &&
        dispatchMentionKeyDown(
          e,
          mentionState,
          mentionFiles,
          setMentionState,
          handleFileSelect
        )
      ) {
        return;
      }
      if (slash.handleKeyDown(e)) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSendChat();
      }
    },
    [mentionState, mentionFiles, handleFileSelect, handleSendChat, slash]
  );

  const handleChatAboutFinding = useCallback(
    (index: number, finding: ReviewFinding) => {
      if (stream.isStreaming) {
        return;
      }
      resetConferral();

      const title = finding.message.split("\n")[0].slice(0, 80);
      const userFacingMessage = `Explain finding #${index + 1}: ${title}`;

      const skipContextInjection = config.provider === "codex" || claudeIsReady;
      const actualMessage = skipContextInjection
        ? userFacingMessage
        : formatFindingContextForChat(
            finding,
            index,
            reviewOutput,
            config.model
          );

      sendChatToProvider(config.provider, actualMessage, userFacingMessage);
    },
    [
      stream.isStreaming,
      config.provider,
      config.model,
      reviewOutput,
      claudeIsReady,
      resetConferral,
      sendChatToProvider,
    ]
  );

  return {
    chatInput,
    mentionState,
    mentionFiles,
    streamingProvider: streamingProviderRef.current,
    slash,
    handleSendChat,
    handleInputChange,
    handleKeyDown,
    handleFileSelect,
    handleChatActionForProvider,
    handleChatAboutFinding,
    setMentionState,
    setMentionFiles,
    setChatInput,
  };
}
