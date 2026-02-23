"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCode,
  GitCommit,
  Loader2,
  MessageSquare,
  Send,
  Square,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  type ContentBlock,
  MessageContent,
  SlashCommandDropdown,
  UserMessageContent,
} from "@/components/engineer/chat";
import { ChatBubble } from "@/components/engineer/chat/ChatBubble";
import { LearningsUsedDialog } from "@/components/engineer/chat/LearningsUsedDialog";
import { FileMentionAutocomplete } from "@/components/engineer/FileMentionAutocomplete";
import type { PRComment } from "@/components/engineer/PRCommentCard";
import { useChatStream } from "@/hooks/engineer/use-chat-stream";
import { useCodexAvailable } from "@/hooks/engineer/use-codex-available";
import { useCodexDebate } from "@/hooks/engineer/use-codex-debate";
import {
  type SlashCommand,
  useSlashCommands,
} from "@/hooks/engineer/use-slash-commands";
import { useCommentChat } from "@/hooks/engineer/useCommentChat";
import {
  parseLearningsUsed,
  parseSuggestedActions,
  type SuggestedAction,
  stripContextBlocks,
} from "@/lib/engineer/chat-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";
import type { ChatMessage } from "@/lib/engineer/queries/symphony";
import { getTextContent } from "@/lib/engineer/utils";

export type CommentChatProps = {
  commentId: string;
  ticketId: string;
  repoPath: string;
  prNumber: number;
  branchName?: string;
  comment: PRComment;
  replies?: PRComment[];
  onResolved?: () => void;
  onDeselect?: () => void;
  onChatCleared?: () => void;
  onStreamingChange?: (isStreaming: boolean) => void;
  autoStart?: boolean;
  autoProvider?: "claude" | "codex";
  className?: string;
};

/**
 * CommentChat - A non-dialog component for addressing a specific PR comment.
 * Used within SymphonyChat when a comment is selected in the PR Comments tab.
 */
export function CommentChat({
  commentId,
  ticketId,
  repoPath,
  prNumber,
  branchName,
  comment,
  replies = [],
  onResolved,
  onDeselect,
  onChatCleared,
  onStreamingChange,
  autoStart = true,
  autoProvider = "claude",
  className,
}: Readonly<CommentChatProps>) {
  const chat = useCommentChat({
    commentId,
    ticketId,
    repoPath,
    prNumber,
    branchName,
    comment,
    replies,
    enabled: true,
    autoStart: autoProvider === "codex" ? false : autoStart,
    onResolved,
    onChatCleared,
  });

  const queryClient = useQueryClient();
  const { data: codexData } = useCodexAvailable();
  const debateClaudeStream = useChatStream();
  const codexChatStream = useChatStream();

  // Build comment-chat specific URLs (include branch params when available)
  const branchSuffix = branchName
    ? `&branch=${encodeURIComponent(branchName)}&prNumber=${prNumber}`
    : "";
  const commentApiBase = `/api/engineer/symphony/comment-chat/${encodeURIComponent(commentId)}?ticketId=${encodeURIComponent(ticketId)}&repo=${encodeURIComponent(repoPath)}${branchSuffix}`;

  const debate = useCodexDebate({
    ticketId,
    repoPath,
    model: "o4-mini",
    chatHistory: chat.history,
    claudeStream: debateClaudeStream,
    claudeUrl: commentApiBase,
    historyUrl: commentApiBase,
    saveEndpoint: commentApiBase,
    invalidateKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
  });

  const hadChangesRef = useRef(false);
  const hasCodexAutoStartedRef = useRef(false);

  // Latch: once we see changes, remember it for the rest of the session
  useEffect(() => {
    if (chat.hasChangedFiles) {
      hadChangesRef.current = true;
    }
  }, [chat.hasChangedFiles]);

  // Trigger learnings extraction on unmount if there were changes
  useEffect(() => {
    return () => {
      if (hadChangesRef.current) {
        chat.triggerLearningsExtraction();
      }
    };
  }, [chat.triggerLearningsExtraction]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check if any stream is active (main chat, debate claude, debate codex, codex freeform)
  const isAnyStreaming =
    chat.isStreaming ||
    debateClaudeStream.isStreaming ||
    !!debate.codexStream.pendingUserMessage ||
    !!codexChatStream.pendingUserMessage;

  // Notify parent when streaming state changes
  useEffect(() => {
    onStreamingChange?.(isAnyStreaming);
  }, [isAnyStreaming, onStreamingChange]);

  // Forward button gating — disable while forwarding
  const [isForwarding, setIsForwarding] = useState(false);
  const prevStreamingRef = useRef(isAnyStreaming);
  useEffect(() => {
    if (prevStreamingRef.current && !isAnyStreaming) {
      setIsForwarding(false); // eslint-disable-line react-hooks/set-state-in-effect
    }
    prevStreamingRef.current = isAnyStreaming;
  }, [isAnyStreaming]);
  const canForward = !(isAnyStreaming || isForwarding);

  // Derive responded message IDs from persisted flags on messages
  const respondedMessageIds = useMemo(
    () => new Set(chat.messages.filter((m) => m.responded).map((m) => m.id)),
    [chat.messages]
  );

  // Save a status message to comment chat history (for debate start/end indicators)
  const saveStatusMessage = useCallback(
    async (content: string) => {
      const statusMsg: ChatMessage = {
        id: `status-${Date.now()}`,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };
      await fetch(commentApiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: statusMsg }),
      }).catch(() => {
        /* best-effort */
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
      });
    },
    [commentApiBase, queryClient, ticketId, commentId]
  );

  // Start debate mode from /debate command
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
    await saveStatusMessage("__debate_started__");
    await debate.startDebateMode();
  }, [codexData?.available, debate, saveStatusMessage]);

  // End debate mode from /end-debate command
  const endDebateFromSlash = useCallback(async () => {
    if (!debate.debateMode) {
      toast("Not in debate mode");
      return;
    }
    await saveStatusMessage("__debate_ended__");
    debate.handleEndDebate();
    toast.success("Debate ended");
  }, [debate, saveStatusMessage]);

  // Send a message directly to Codex (@codex freeform chat)
  const sendToCodex = useCallback(
    async (codexPrompt: string, displayContent: string) => {
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: displayContent,
        timestamp: new Date().toISOString(),
      };

      // Save user message to comment chat history
      await fetch(commentApiBase, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg }),
      }).catch(() => {
        /* best-effort */
      });

      // Invalidate so StatusNote appears immediately
      await queryClient.invalidateQueries({
        queryKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
      });

      const url = `/api/engineer/codex/chat/${encodeURIComponent(ticketId)}?repo=${encodeURIComponent(repoPath)}`;

      // Build recent chat history for context
      const recentHistory = (chat.history?.messages || [])
        .slice(-10)
        .map((m) => ({
          role: m.role,
          content: m.content,
          sender: m.sender,
        }));

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: codexPrompt,
            repoPath,
            chatHistory: recentHistory,
            activeTab: "comments",
            commentContext: {
              author: comment.author,
              body: comment.body,
              path: comment.path,
              line: comment.line,
            },
          }),
        });
      } catch (err) {
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
        return;
      }

      const state: CodexStreamState = {
        accumulated: "",
        receivedAnyText: false,
        reasoningBlocks: [],
      };
      const saveFinalMessage = async (msg: ChatMessage) => {
        await fetch(commentApiBase, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.commentChatHistory(ticketId, commentId, repoPath),
        });
      };
      await readCodexStream(
        reader,
        state,
        codexChatStream.setPendingUserMessage,
        saveFinalMessage
      );
    },
    [
      ticketId,
      repoPath,
      commentId,
      commentApiBase,
      codexChatStream,
      queryClient,
      chat.history?.messages,
      comment,
    ]
  );

  // Auto-start Codex when autoProvider is "codex"
  useEffect(() => {
    if (
      autoProvider !== "codex" ||
      hasCodexAutoStartedRef.current ||
      chat.isLoadingHistory ||
      !codexData?.available
    ) {
      return;
    }
    if (chat.history?.messages && chat.history.messages.length > 0) {
      return;
    }
    hasCodexAutoStartedRef.current = true;
    const prompt =
      "Investigate this PR comment and propose a fix. Show what you found before proposing changes.";
    sendToCodex(prompt, `@codex ${prompt}`);
  }, [
    autoProvider,
    chat.isLoadingHistory,
    chat.history?.messages,
    codexData?.available,
    sendToCodex,
  ]);

  // Forward a Codex message to Claude
  const forwardMessageToClaude = useCallback(
    async (targetMsg: ChatMessage) => {
      if (chat.isStreaming || debateClaudeStream.isStreaming) {
        return;
      }
      setIsForwarding(true);

      const { contentWithoutActions } = parseSuggestedActions(
        targetMsg.content
      );
      const claudePrompt = `Codex (OpenAI) provided the following feedback:\n\n${contentWithoutActions}\n\nPlease review and provide your perspective.`;
      await chat.sendMessage(claudePrompt, "__forwarded_to_claude__");
    },
    [chat, debateClaudeStream.isStreaming]
  );

  // Forward a Claude message to Codex
  const handleForwardMessage = useCallback(
    async (index: number) => {
      const msg = chat.messages[index];
      if (msg?.role !== "assistant") {
        return;
      }
      if (isAnyStreaming) {
        return;
      }
      setIsForwarding(true);
      if (!codexData?.available) {
        toast.error("Codex is not available", {
          description: "Install Codex CLI to use forwarding.",
        });
        return;
      }
      const { contentWithoutActions } = parseSuggestedActions(msg.content);
      const cleanContent = stripContextBlocks(contentWithoutActions);
      const codexPrompt = `Claude (Anthropic) provided the following response:\n\n${cleanContent}\n\nPlease review and provide your perspective.`;
      // Scroll after the next render (query invalidation inside sendToCodex
      // adds the forwarded message, then React re-renders).
      const scrollAfterRender = () =>
        requestAnimationFrame(() =>
          chat.messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
        );
      // Fire once the PATCH + invalidation lands (before stream completes)
      setTimeout(scrollAfterRender, 300);
      await sendToCodex(codexPrompt, "__forwarded_to_codex__");
    },
    [
      chat.messages,
      chat.messagesEndRef,
      isAnyStreaming,
      codexData?.available,
      sendToCodex,
    ]
  );

  // Forward a Codex message to Claude (by index)
  const handleForwardCodexMessage = useCallback(
    async (index: number) => {
      const msg = chat.messages[index];
      if (msg?.sender !== "codex") {
        return;
      }
      await forwardMessageToClaude(msg);
    },
    [chat.messages, forwardMessageToClaude]
  );

  // Action message handler (for suggested action and debate action buttons)
  const sendActionMessage = useCallback(
    async (action: SuggestedAction) => {
      if (debate.handleAction(action.message)) {
        return;
      }
      // Structured type check — the LLM tags accept-changes actions via type attribute
      if (action.type === "accept-changes") {
        chat.markChangesAccepted();
      }
      await chat.sendMessage(action.message);
    },
    [debate, chat]
  );

  // Intercept handleSend for @codex / @claude prefix and provider-aware routing
  const handleSend = useCallback(() => {
    const trimmedInput = chat.input.trim();

    // Detect @codex prefix — explicit Codex routing
    const codexMatch = /^@codex\s+/i.exec(trimmedInput);
    if (codexMatch) {
      const codexPrompt = trimmedInput.slice(codexMatch[0].length);
      if (codexPrompt) {
        if (!codexData?.available) {
          toast.error("Codex is not available", {
            description: "Install Codex CLI to use @codex mentions.",
          });
          return;
        }

        // In debate mode, route to Codex debate conversation
        if (debate.debateMode) {
          chat.setInput("");
          debate.sendHumanToCodex(codexPrompt, trimmedInput);
          return;
        }

        chat.setInput("");
        sendToCodex(codexPrompt, trimmedInput);
        return;
      }
    }

    // Detect @claude prefix — explicit Claude routing
    const claudeMatch = /^@claude\s+/i.exec(trimmedInput);
    if (claudeMatch) {
      const claudePrompt = trimmedInput.slice(claudeMatch[0].length);
      if (claudePrompt) {
        chat.setInput("");
        chat.sendMessage(claudePrompt, trimmedInput);
        return;
      }
    }

    // No prefix — route based on session provider
    if (autoProvider === "codex") {
      if (!codexData?.available) {
        toast.error("Codex is not available", {
          description: "Install Codex CLI to use Codex as default provider.",
        });
        return;
      }
      chat.setInput("");
      sendToCodex(trimmedInput, trimmedInput);
      return;
    }

    chat.handleSend();
  }, [chat, codexData?.available, debate, sendToCodex, autoProvider]);

  // Intercept key down to use our handleSend
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Header with back button and learnings indicator */}
      <div className="shrink-0 border-border border-b bg-muted/30 px-5 py-3 pr-10">
        <div className="flex items-center gap-3">
          {onDeselect && (
            <button
              className="-ml-1.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onDeselect}
              title="Back to comments list"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <MessageSquare className="size-4 text-muted-foreground" />
          <span className="flex flex-1 items-center gap-2 font-medium text-sm">
            Propose Fix
            {debate.debateMode && (
              <span className="font-mono text-[10px] text-amber-600 uppercase tracking-wider dark:text-amber-400">
                debate
              </span>
            )}
          </span>
          {chat.learningsStatus === "processing" && (
            <span
              className="flex items-center gap-1 text-muted-foreground text-xs"
              title="Extracting learnings from this conversation..."
            >
              <Brain className="h-3.5 w-3.5 animate-pulse" />
            </span>
          )}
          {chat.learningsStatus === "completed" && chat.learningsCount > 0 && (
            <span
              className="flex items-center gap-1 text-muted-foreground text-xs"
              title={`${chat.learningsCount} learning${chat.learningsCount === 1 ? "" : "s"} captured`}
            >
              <Brain className="h-3.5 w-3.5" />
              {chat.learningsCount}
            </span>
          )}
        </div>
      </div>

      <CommentContextHeader
        comment={comment}
        isCollapsed={chat.isHeaderCollapsed}
        onToggleCollapse={chat.toggleHeaderCollapse}
        replies={replies}
      />

      {/* Chat area - full width (Changes available in main tab) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatMessagesArea
          canForward={canForward}
          codexChatPending={codexChatStream.pendingUserMessage}
          codexChatStreamStartedAt={codexChatStream.streamStartedAt}
          contextPercent={chat.contextPercent}
          debate={debate}
          debateClaudeBlocks={debateClaudeStream.streamingBlocks}
          debateClaudeContent={debateClaudeStream.streamingContent}
          debateClaudeStreaming={debateClaudeStream.isStreaming}
          debateClaudeStreamStartedAt={debateClaudeStream.streamStartedAt}
          debateCodexPending={debate.codexStream.pendingUserMessage}
          debateCodexStreamStartedAt={debate.codexStream.streamStartedAt}
          debateMode={debate.debateMode}
          error={chat.error}
          hasAcceptedChanges={chat.hasAcceptedChanges}
          isAnyStreaming={isAnyStreaming}
          isLoadingHistory={chat.isLoadingHistory}
          isStreaming={chat.isStreaming}
          isWaitingForResponse={chat.isWaitingForResponse}
          messages={chat.messages}
          messagesEndRef={chat.messagesEndRef}
          onAcceptChanges={chat.handleAcceptChanges}
          onAction={sendActionMessage}
          onCopy={undefined}
          onForwardCodexMessage={handleForwardCodexMessage}
          onForwardMessage={handleForwardMessage}
          onSendResponse={chat.handleSendResponse}
          respondedMessageIds={respondedMessageIds}
          streamingBlocks={chat.streamingBlocks}
          streamingContent={chat.streamingContent}
          streamStartedAt={chat.streamStartedAt}
        />
        <ChatInputArea
          autoDebate={debate.autoDebate}
          autoProvider={autoProvider}
          debateMode={debate.debateMode}
          endDebateFromSlash={endDebateFromSlash}
          hasAcceptedChanges={chat.hasAcceptedChanges}
          hasChangedFiles={chat.hasChangedFiles}
          historyMessageCount={chat.historyMessageCount}
          input={chat.input}
          inputRef={chat.inputRef}
          isCommitting={chat.isCommitting}
          isStreaming={chat.isStreaming}
          messageCount={chat.messages.length}
          onClearChat={chat.handleClearChat}
          onCommitAndResolve={chat.handleCommitAndResolve}
          onInputChange={chat.setInput}
          onKeyDown={handleKeyDown}
          onReflect={() => {
            chat.triggerLearningsExtraction();
            chat.pollLearningsStatus();
          }}
          onSend={handleSend}
          onSetAutoDebate={debate.setAutoDebate}
          onStop={chat.handleStop}
          repoPath={repoPath}
          startDebateFromSlash={startDebateFromSlash}
          ticketId={ticketId}
        />
      </div>
    </div>
  );
}

const commentHeaderMarkdownComponents = {
  code({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = getTextContent(children).replace(/\n$/, "");
    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }
    if (codeString.includes("\n")) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language="text"
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }
    return (
      <code
        className="rounded bg-muted-foreground/20 px-1.5 py-0.5 font-mono text-[12px]"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },
  hr() {
    return <hr className="my-4 border-border/50" />;
  },
};

const commentBubbleMarkdownComponents = {
  code({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = getTextContent(children).replace(/\n$/, "");
    if (match) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language={match[1]}
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }
    if (codeString.includes("\n")) {
      return (
        <SyntaxHighlighter
          className="!my-2 !rounded-lg !text-xs"
          language="text"
          PreTag="div"
          style={oneDark}
        >
          {codeString}
        </SyntaxHighlighter>
      );
    }
    return (
      <code
        className="rounded bg-muted-foreground/20 px-1.5 py-0.5 font-mono text-[12px] text-emerald-600 dark:text-emerald-400"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="font-mono text-[13px] leading-relaxed">{children}</p>;
  },
  hr() {
    return <hr className="my-4 border-border/50" />;
  },
};

/**
 * Collapsible header showing comment author, file location, body, and replies
 */
const CommentContextHeader = memo(function CommentContextHeader({
  comment,
  replies,
  isCollapsed,
  onToggleCollapse,
}: Readonly<{
  comment: PRComment;
  replies: PRComment[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}>) {
  return (
    <div className="shrink-0 border-border border-b bg-muted/30">
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 px-5 py-2.5 transition-colors hover:bg-muted/50"
        onClick={onToggleCollapse}
      >
        {isCollapsed ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
          <span className="font-medium text-[10px] text-muted-foreground">
            {comment.author.charAt(0).toUpperCase()}
          </span>
        </div>
        <span className="font-medium text-xs">@{comment.author}</span>
        {comment.path && (
          <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            <FileCode className="size-3" />
            {comment.path.split("/").pop()}
            {comment.line && `:${comment.line}`}
          </span>
        )}
        {comment.url && (
          <a
            className="text-muted-foreground hover:text-primary"
            href={comment.url}
            onClick={(e) => e.stopPropagation()}
            rel="noopener noreferrer"
            target="_blank"
            title="View on GitHub"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {isCollapsed ? "Show comment" : "Hide comment"}
        </span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
          isCollapsed
            ? "grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr] opacity-100"
        )}
      >
        <div className="overflow-hidden">
          <div className="mx-5 mb-4 rounded-lg border border-border bg-card p-4">
            <div className="prose prose-sm dark:prose-invert prose-headings:my-1.5 prose-p:my-1 max-w-none prose-headings:text-sm text-[13px]">
              <ReactMarkdown
                components={commentHeaderMarkdownComponents}
                remarkPlugins={[remarkGfm]}
              >
                {comment.body}
              </ReactMarkdown>
            </div>
            {replies.length > 0 && (
              <div className="mt-2 border-border/50 border-t pt-2">
                <span className="font-medium text-muted-foreground text-xs">
                  {replies.length} {replies.length === 1 ? "reply" : "replies"}
                </span>
                <div className="mt-1.5 space-y-2 border-muted border-l-2 pl-3">
                  {replies.map((reply) => (
                    <div key={reply.id}>
                      <span className="font-medium text-foreground/80 text-xs">
                        @{reply.author}
                      </span>
                      <p className="whitespace-pre-wrap text-[13px] text-foreground/75 leading-relaxed">
                        {reply.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

/** Type for the debate object passed to ChatMessagesArea */
type DebateHandle = ReturnType<typeof useCodexDebate>;

/**
 * Status note rendered for forwarded/debate-start/debate-end indicators.
 */

type CodexStreamState = {
  accumulated: string;
  receivedAnyText: boolean;
  reasoningBlocks: ContentBlock[];
};

function makeStreamingCodexMessage(state: CodexStreamState): ChatMessage {
  return {
    id: "codex-chat-streaming",
    role: "assistant",
    content: state.accumulated,
    timestamp: new Date().toISOString(),
    sender: "codex",
    blocks:
      state.reasoningBlocks.length > 0 ? [...state.reasoningBlocks] : undefined,
  };
}

async function processCodexStreamEvent(
  event: Record<string, unknown>,
  state: CodexStreamState,
  setPending: (msg: ChatMessage | null) => void,
  saveFinalMessage: (msg: ChatMessage) => Promise<void>
): Promise<void> {
  if (event.type === "reasoning" && event.content) {
    state.reasoningBlocks.push({
      type: "thinking",
      id: `reasoning-${Date.now()}-${state.reasoningBlocks.length}`,
      thinking: event.content as string,
    });
    setPending(makeStreamingCodexMessage(state));
    return;
  }
  if (event.type === "text" && event.content) {
    state.receivedAnyText = true;
    state.accumulated += event.content as string;
    setPending(makeStreamingCodexMessage(state));
    return;
  }
  if (event.type === "error") {
    console.error("[codex-chat] Server error:", event.error);
    toast.error("Codex error", {
      description: String(event.error).slice(0, 200),
    });
    return;
  }
  if (event.type !== "done") {
    return;
  }

  const finalContent = (event.content as string) || state.accumulated;
  setPending(null);
  if (finalContent.trim()) {
    await saveFinalMessage({
      id: `codex-${Date.now()}`,
      role: "assistant",
      content: finalContent.trim(),
      timestamp: new Date().toISOString(),
      sender: "codex",
      blocks:
        state.reasoningBlocks.length > 0 ? state.reasoningBlocks : undefined,
    });
  } else if (!state.receivedAnyText) {
    toast.error("Codex returned no response", {
      description: `Exit code: ${(event.exitCode as number) ?? "unknown"}`,
    });
  }
}

async function readCodexStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: CodexStreamState,
  setPending: (msg: ChatMessage | null) => void,
  saveFinalMessage: (msg: ChatMessage) => Promise<void>
): Promise<void> {
  const decoder = new TextDecoder();
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
        continue;
      }
      await processCodexStreamEvent(event, state, setPending, saveFinalMessage);
    }
  }
}

function StatusNote({
  id,
  idx,
  text,
  color = "muted-foreground/60",
}: Readonly<{ id: string; idx: number; text: string; color?: string }>) {
  return (
    <div
      className="fade-in flex animate-in justify-center py-1 duration-300"
      key={id}
      style={{ animationDelay: `${idx * 50}ms` }}
    >
      <span className={`font-mono text-[11px] text-${color} italic`}>
        {text}
      </span>
    </div>
  );
}

const STATUS_NOTES: Record<string, { text: string; color?: string }> = {
  __forwarded_to_claude__: { text: "Forwarded Codex response to Claude" },
  __forwarded_to_codex__: { text: "Forwarded Claude response to Codex" },
  __debate_started__: {
    text: "Debate mode started",
    color: "amber-600/70 dark:text-amber-400/70",
  },
  __debate_ended__: {
    text: "Debate mode ended",
    color: "amber-600/70 dark:text-amber-400/70",
  },
};

type MessageRenderContext = {
  messagesLength: number;
  debate: DebateHandle;
  debateMode: boolean;
  isAnyStreaming: boolean;
  canForward: boolean;
  onAction: (action: SuggestedAction) => void;
  onForwardMessage: (index: number) => void;
  onForwardCodexMessage: (index: number) => void;
  onAcceptChanges: () => void;
  onSendResponse?: (text: string, messageId: string) => void;
  respondedMessageIds: Set<string>;
  hasAcceptedChanges: boolean;
  contextPercent: number | null;
};

function renderSenderBubble(
  msg: ChatMessage,
  idx: number,
  sender: "claude" | "codex",
  debateActions: SuggestedAction[],
  ctx: MessageRenderContext
): React.ReactNode {
  const isCodex = sender === "codex";
  const { contentWithoutActions } = parseSuggestedActions(msg.content);
  const forwardHandler = isCodex
    ? ctx.onForwardCodexMessage
    : ctx.onForwardMessage;
  return (
    <ChatBubble
      actions={debateActions.length > 0 ? debateActions : undefined}
      forwardLabel={isCodex ? "Forward to Claude" : "Forward to Codex"}
      index={idx}
      key={msg.id}
      messageRole={isCodex ? "user" : msg.role}
      onAction={debateActions.length > 0 ? ctx.onAction : undefined}
      onCopy={async () => {
        try {
          await navigator.clipboard.writeText(contentWithoutActions);
          toast.success("Copied to clipboard");
        } catch {
          toast.error("Failed to copy");
        }
      }}
      onForward={
        ctx.canForward && msg.role === "assistant"
          ? () => forwardHandler(idx)
          : undefined
      }
      sender={sender}
      timestamp={msg.timestamp}
    >
      <MessageContent blocks={msg.blocks} content={contentWithoutActions} />
    </ChatBubble>
  );
}

function renderChatMessage(
  msg: ChatMessage,
  idx: number,
  ctx: MessageRenderContext
): React.ReactNode {
  const statusNote = STATUS_NOTES[msg.content];
  if (statusNote) {
    return (
      <StatusNote
        color={statusNote.color}
        id={msg.id}
        idx={idx}
        key={msg.id}
        text={statusNote.text}
      />
    );
  }

  const isLast = idx === ctx.messagesLength - 1;
  const debateActions = ctx.debate.getDebateActions(
    msg,
    isLast,
    ctx.isAnyStreaming
  );
  const sender =
    debateActions.length > 0 ? ctx.debate.getEffectiveSender(msg) : msg.sender;
  const showSenderBubble =
    debateActions.length > 0 ||
    sender === "codex" ||
    (ctx.debateMode && !!sender);

  if (showSenderBubble) {
    return renderSenderBubble(msg, idx, sender!, debateActions, ctx);
  }

  // Normal comment message bubble (with PR-specific features)
  const isLastAssistant =
    msg.role === "assistant" && isLast && !ctx.isAnyStreaming;
  return (
    <CommentMessageBubble
      contextPercent={isLastAssistant ? ctx.contextPercent : undefined}
      forwardLabel="Forward to Codex"
      hasAcceptedChanges={ctx.hasAcceptedChanges}
      index={idx}
      key={msg.id}
      message={msg}
      onAcceptChanges={ctx.onAcceptChanges}
      onAction={ctx.onAction}
      onForward={
        ctx.canForward && msg.role === "assistant"
          ? () => ctx.onForwardMessage(idx)
          : undefined
      }
      onSendResponse={
        ctx.respondedMessageIds.has(msg.id) ? undefined : ctx.onSendResponse
      }
    />
  );
}

/**
 * Messages display area with loading, empty, and active states.
 * Now debate-aware: renders status indicators, sender-labeled bubbles, and streaming from multiple sources.
 */
function ChatMessagesArea({
  isLoadingHistory,
  messages,
  isStreaming,
  isWaitingForResponse,
  streamingContent,
  streamingBlocks,
  streamStartedAt,
  error,
  hasAcceptedChanges,
  onAcceptChanges,
  onSendResponse,
  respondedMessageIds,
  messagesEndRef,
  debateMode,
  debate,
  isAnyStreaming,
  canForward,
  onAction,
  onForwardMessage,
  onForwardCodexMessage,
  debateCodexPending,
  codexChatPending,
  contextPercent,
  debateClaudeStreaming,
  debateClaudeContent,
  debateClaudeBlocks,
  debateClaudeStreamStartedAt,
  debateCodexStreamStartedAt,
  codexChatStreamStartedAt,
}: Readonly<{
  isLoadingHistory: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  isWaitingForResponse: boolean;
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  streamStartedAt: string;
  error: string | null;
  hasAcceptedChanges: boolean;
  onAcceptChanges: () => void;
  onSendResponse?: (text: string, messageId: string) => void;
  respondedMessageIds: Set<string>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  debateMode: boolean;
  debate: DebateHandle;
  isAnyStreaming: boolean;
  canForward: boolean;
  onAction: (action: SuggestedAction) => void;
  onCopy: undefined;
  onForwardMessage: (index: number) => void;
  onForwardCodexMessage: (index: number) => void;
  debateCodexPending: ChatMessage | null;
  codexChatPending: ChatMessage | null;
  debateClaudeStreaming: boolean;
  debateClaudeContent: string;
  debateClaudeBlocks: ContentBlock[];
  contextPercent: number | null;
  debateClaudeStreamStartedAt: string;
  debateCodexStreamStartedAt: string;
  codexChatStreamStartedAt: string;
}>) {
  // Smart scroll state — must be before early returns to satisfy hook rules
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const lastScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(messages.length);
  const pendingScrollRef = useRef(false);
  const prevHeightRef = useRef(0);

  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return true;
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

  // Dismiss "New Message" pill when user scrolls down
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    if (el.scrollTop > lastScrollTopRef.current) {
      setShowNewMessage(false);
    }
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  // Detect new messages arriving
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current) {
      const el = scrollContainerRef.current;
      // When hidden (display:none), clientHeight is 0 and scrollIntoView is a
      // no-op. Defer the scroll to the ResizeObserver recovery.
      if (el && el.clientHeight === 0) {
        pendingScrollRef.current = true;
      } else if (isNearBottom()) {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      } else {
        setShowNewMessage(true); // eslint-disable-line react-hooks/set-state-in-effect
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isNearBottom, messagesEndRef]);

  // Auto-scroll during streaming when near bottom, show pill when scrolled away.
  // Watches all streaming sources: Claude main, debate Claude, Codex freeform, debate Codex.
  const wasStreamingRef = useRef(false);
  const codexContent = codexChatPending?.content || debateCodexPending?.content;
  useEffect(() => {
    const hasStream = !!(
      streamingContent ||
      debateClaudeContent ||
      codexContent
    );
    if (hasStream) {
      if (isNearBottom()) {
        const el = scrollContainerRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      } else if (!wasStreamingRef.current) {
        // Show pill once when streaming starts while scrolled away
        setShowNewMessage(true); // eslint-disable-line react-hooks/set-state-in-effect
      }
    }
    wasStreamingRef.current = hasStream;
  }, [streamingContent, debateClaudeContent, codexContent, isNearBottom]);

  // Recovery scroll: when the container transitions from hidden (display:none)
  // to visible, scroll to bottom if there's active streaming or new messages
  // arrived while hidden (scrollIntoView is a no-op on hidden elements).
  const hasAnyStreamRef = useRef(false);
  hasAnyStreamRef.current = !!(
    streamingContent ||
    debateClaudeContent ||
    codexChatPending ||
    debateCodexPending ||
    isWaitingForResponse
  );
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { height } = entry.contentRect;
      // Container just became visible (height 0 → positive)
      if (
        height > 0 &&
        prevHeightRef.current === 0 &&
        (hasAnyStreamRef.current || pendingScrollRef.current)
      ) {
        el.scrollTop = el.scrollHeight;
        pendingScrollRef.current = false;
      }
      prevHeightRef.current = height;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []); // stable — uses refs for mutable state

  const scrollToBottomAndDismiss = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setShowNewMessage(false);
  }, [messagesEndRef]);

  if (isLoadingHistory) {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex h-full flex-col items-center justify-center text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
            <MessageSquare className="size-5 text-muted-foreground" />
          </div>
          <p className="font-mono text-muted-foreground text-sm">
            Start a conversation to address this feedback
          </p>
          <p className="mt-1 max-w-[280px] text-muted-foreground/70 text-xs">
            Type &quot;Fix this&quot; to let Claude propose a solution, or
            provide specific guidance
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
      onScroll={handleScroll}
      ref={scrollContainerRef}
    >
      {messages.map((msg, idx) =>
        renderChatMessage(msg, idx, {
          messagesLength: messages.length,
          debate,
          debateMode,
          isAnyStreaming,
          canForward,
          onAction,
          onForwardMessage,
          onForwardCodexMessage,
          onAcceptChanges,
          onSendResponse,
          respondedMessageIds,
          hasAcceptedChanges,
          contextPercent,
        })
      )}
      {/* Main Claude streaming */}
      {isStreaming && (streamingContent || streamingBlocks.length > 0) && (
        <CommentMessageBubble
          hasAcceptedChanges={hasAcceptedChanges}
          index={messages.length}
          isStreaming
          message={{
            id: "streaming",
            role: "assistant",
            content: streamingContent,
            timestamp: streamStartedAt,
            blocks: streamingBlocks,
          }}
        />
      )}
      {isStreaming &&
        !streamingContent &&
        streamingBlocks.length === 0 &&
        !error && (
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
      {/* Debate Claude streaming */}
      {debateClaudeStreaming &&
        (debateClaudeContent || debateClaudeBlocks.length > 0) && (
          <ChatBubble
            isStreaming
            messageRole="assistant"
            sender="claude"
            timestamp={debateClaudeStreamStartedAt}
          >
            <MessageContent
              blocks={debateClaudeBlocks}
              content={debateClaudeContent}
              isStreaming
            />
          </ChatBubble>
        )}
      {/* Codex streaming bubble (debate mode) */}
      {debateCodexPending && (
        <ChatBubble
          isStreaming
          messageRole="assistant"
          sender="codex"
          timestamp={debateCodexStreamStartedAt}
        >
          <MessageContent
            blocks={debateCodexPending.blocks}
            content={debateCodexPending.content}
            isStreaming
          />
        </ChatBubble>
      )}
      {/* Codex streaming bubble (@codex freeform chat) */}
      {codexChatPending && (
        <ChatBubble
          isStreaming
          messageRole="assistant"
          sender="codex"
          timestamp={codexChatStreamStartedAt}
        >
          <MessageContent
            blocks={codexChatPending.blocks}
            content={codexChatPending.content}
            isStreaming
          />
        </ChatBubble>
      )}
      {isWaitingForResponse && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="flex gap-1">
            <span className="size-1.5 animate-bounce rounded-full bg-amber-500/60 [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-amber-500/60 [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-amber-500/60 [animation-delay:300ms]" />
          </div>
          <span className="font-mono text-muted-foreground text-xs">
            waiting for response...
          </span>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 font-mono text-red-600 text-xs dark:text-red-400">
          Error: {error}
        </div>
      )}
      <div ref={messagesEndRef} />
      {showNewMessage && (
        <div className="pointer-events-none sticky bottom-3 z-10 flex justify-center">
          <button
            className={cn(
              "pointer-events-auto",
              "inline-flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-3",
              "bg-emerald-600 text-white dark:bg-emerald-500",
              "font-medium font-mono text-[11px] tracking-wide",
              "shadow-emerald-500/25 shadow-lg dark:shadow-emerald-400/20",
              "cursor-pointer hover:bg-emerald-500 dark:hover:bg-emerald-400",
              "transition-all duration-200",
              "fade-in slide-in-from-bottom-3 animate-in duration-300"
            )}
            onClick={scrollToBottomAndDismiss}
          >
            New message
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Chat input with commit button, textarea, send/stop toggle, @codex autocomplete, and footer
 */
const COMMENT_SLASH_COMMANDS: SlashCommand[] = [
  { command: "/debate", description: "Start a Claude vs Codex debate" },
  { command: "/end-debate", description: "End the current debate" },
  {
    command: "/reflect",
    description: "Extract learnings from this conversation",
  },
];

function ChatInputArea({
  input,
  onInputChange,
  onSend,
  onStop,
  onKeyDown,
  onClearChat,
  onCommitAndResolve,
  isStreaming,
  isCommitting,
  hasAcceptedChanges,
  hasChangedFiles,
  messageCount,
  historyMessageCount,
  inputRef,
  debateMode,
  autoDebate,
  onSetAutoDebate,
  ticketId,
  repoPath,
  startDebateFromSlash,
  endDebateFromSlash,
  autoProvider = "claude",
  onReflect,
}: Readonly<{
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onClearChat: () => void;
  onCommitAndResolve: () => void;
  isStreaming: boolean;
  isCommitting: boolean;
  hasAcceptedChanges: boolean;
  hasChangedFiles: boolean;
  messageCount: number;
  historyMessageCount: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  debateMode: boolean;
  autoDebate: boolean;
  onSetAutoDebate: (enabled: boolean) => void;
  ticketId: string;
  repoPath: string;
  startDebateFromSlash: () => void;
  endDebateFromSlash: () => void;
  autoProvider?: "claude" | "codex";
  onReflect: () => void;
}>) {
  // Mention autocomplete state (for @codex and file mentions)
  const [mentionState, setMentionState] = useState<{
    isOpen: boolean;
    query: string;
    startIndex: number;
    selectedIndex: number;
  } | null>(null);

  // Slash command autocomplete
  const slashHandler = useCallback(
    (command: string) => {
      onInputChange("");
      if (/^\/debate$/i.test(command)) {
        startDebateFromSlash();
      } else if (/^\/end-debate$/i.test(command)) {
        endDebateFromSlash();
      } else if (/^\/reflect$/i.test(command)) {
        onReflect();
      }
    },
    [onInputChange, startDebateFromSlash, endDebateFromSlash, onReflect]
  );
  const slash = useSlashCommands(COMMENT_SLASH_COMMANDS, slashHandler);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      const cursorPos = e.target.selectionStart;
      onInputChange(newValue);

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

      // Detect slash commands
      slash.detectSlash(newValue, cursorPos);
    },
    [onInputChange, slash]
  );

  const handleFileSelect = useCallback(
    (file: string) => {
      if (!mentionState) {
        return;
      }

      if (file === "@claude" || file === "@codex") {
        const beforeMention = input.slice(0, mentionState.startIndex);
        const afterMention = input.slice(
          mentionState.startIndex + 1 + mentionState.query.length
        );
        onInputChange(`${beforeMention + file} ${afterMention}`);
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

      // Normal file mention — insert the filename
      const beforeMention = input.slice(0, mentionState.startIndex);
      const afterMention = input.slice(
        mentionState.startIndex + 1 + mentionState.query.length
      );
      onInputChange(`${beforeMention}@${file} ${afterMention}`);
      setMentionState(null);
    },
    [mentionState, input, onInputChange, inputRef]
  );

  const closeMention = useCallback(() => setMentionState(null), []);

  // Intercept keyboard to forward arrow keys to the autocomplete
  const handleKeyDownWithMention = useCallback(
    (e: React.KeyboardEvent) => {
      // Slash commands take priority
      if (
        slash.slashState?.isOpen &&
        slash.filteredCommands.length > 0 &&
        slash.handleKeyDown(e)
      ) {
        return;
      }

      if (mentionState?.isOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionState(null);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          // Let FileMentionAutocomplete handle the selection via selectedIndex
          // But we need to prevent the default send on Enter
          // The autocomplete doesn't have a ref-based API; we rely on selectedIndex state.
          // For simplicity, just close mention on Enter and let parent handle it.
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionState((prev) =>
            prev ? { ...prev, selectedIndex: prev.selectedIndex + 1 } : null
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionState((prev) =>
            prev
              ? { ...prev, selectedIndex: Math.max(0, prev.selectedIndex - 1) }
              : null
          );
          return;
        }
      }
      onKeyDown(e);
    },
    [mentionState, slash, onKeyDown]
  );

  // Whether to show the @codex, @claude, or /slash highlight overlay
  const hasCodexPrefix = /^@codex\s/i.test(input);
  const hasClaudePrefix = /^@claude\s/i.test(input);
  const isSlashInput = /^\/\S*$/i.test(input);

  return (
    <div className="shrink-0 border-border border-t bg-muted/30 p-4">
      {hasAcceptedChanges && hasChangedFiles && (
        <div className="mb-3">
          <Button
            className="w-full"
            disabled={isCommitting || isStreaming}
            onClick={onCommitAndResolve}
          >
            {isCommitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Committing...
              </>
            ) : (
              <>
                <GitCommit className="mr-2 size-4" />
                Commit & Mark Resolved
              </>
            )}
          </Button>
        </div>
      )}

      <div className="relative flex items-end gap-3">
        <span className="shrink-0 pb-2.5 font-bold font-mono text-emerald-600 text-sm dark:text-emerald-500">
          {">"}
        </span>
        <div className="relative flex-1">
          {/* Mention autocomplete dropdown */}
          {mentionState?.isOpen && (
            <div className="absolute right-0 bottom-full left-0 z-10 mb-1">
              <FileMentionAutocomplete
                isOpen={mentionState.isOpen}
                onClose={closeMention}
                onSelect={handleFileSelect}
                onSelectedIndexChange={(idx) =>
                  setMentionState((prev) =>
                    prev ? { ...prev, selectedIndex: idx } : null
                  )
                }
                query={mentionState.query}
                repoPath={repoPath}
                selectedIndex={mentionState.selectedIndex}
                ticketId={ticketId}
              />
            </div>
          )}
          {/* Slash command autocomplete dropdown */}
          {slash.slashState?.isOpen && slash.filteredCommands.length > 0 && (
            <SlashCommandDropdown
              commands={slash.filteredCommands}
              onSelect={slash.selectCommand}
              selectedIndex={slash.slashState.selectedIndex}
            />
          )}
          {/* Highlight overlay for @codex / @claude prefix or /slash commands */}
          {(hasCodexPrefix || hasClaudePrefix || isSlashInput) && (
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-0 py-2 pr-10 font-mono text-sm leading-relaxed",
                "pointer-events-none overflow-hidden whitespace-pre-wrap break-words"
              )}
            >
              {hasCodexPrefix || hasClaudePrefix ? (
                <>
                  <span
                    className={cn(
                      "font-semibold",
                      hasClaudePrefix
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-[oklch(0.45_0.025_260)] dark:text-[oklch(0.65_0.025_260)]"
                    )}
                  >
                    {input.slice(0, input.indexOf(" ") + 1)}
                  </span>
                  <span className="text-foreground">
                    {input.slice(input.indexOf(" ") + 1)}
                  </span>
                </>
              ) : (
                <span className="font-semibold text-violet-600 dark:text-violet-400">
                  {input}
                </span>
              )}
            </div>
          )}
          <textarea
            className={cn(
              "w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground",
              "py-2 pr-10 font-mono leading-relaxed",
              "focus:outline-none focus:ring-0",
              "disabled:cursor-not-allowed disabled:opacity-50",
              (hasCodexPrefix || hasClaudePrefix || isSlashInput) &&
                "text-transparent caret-foreground"
            )}
            disabled={isStreaming}
            onChange={handleInputChange}
            onKeyDown={handleKeyDownWithMention}
            placeholder={chatInputPlaceholder(messageCount, autoProvider)}
            ref={inputRef}
            rows={1}
            style={{
              minHeight: "40px",
              maxHeight: "50vh",
              overflow: "hidden",
            }}
            value={input}
          />
          {isStreaming ? (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "cursor-pointer transition-all duration-200",
                "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
              )}
              onClick={onStop}
              title="Stop response"
            >
              <Square className="size-2.5 fill-current" />
            </button>
          ) : (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "transition-all duration-200",
                input.trim()
                  ? "bg-emerald-600 text-white shadow-emerald-500/20 shadow-lg hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                  : "cursor-not-allowed bg-muted text-muted-foreground"
              )}
              disabled={!input.trim()}
              onClick={onSend}
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
        <div className="flex items-center gap-2">
          {debateMode && (
            <span
              className="flex cursor-pointer items-center gap-1.5"
              title="Allow Claude & Codex to hash it out back and forth"
            >
              <span className="font-mono text-[10px] text-muted-foreground">
                Full-auto
              </span>
              <button
                aria-checked={autoDebate}
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border border-border transition-colors",
                  autoDebate ? "bg-primary" : "bg-muted"
                )}
                onClick={() => onSetAutoDebate(!autoDebate)}
                role="switch"
                type="button"
              >
                <span
                  className={cn(
                    "pointer-events-none block size-3 rounded-full bg-background shadow-sm transition-transform",
                    autoDebate ? "translate-x-3" : "translate-x-0"
                  )}
                />
              </button>
            </span>
          )}
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {messageCount} message{messageCount === 1 ? "" : "s"}
          </span>
          {historyMessageCount > 0 && (
            <button
              className="cursor-pointer font-mono text-[10px] text-muted-foreground/50 transition-colors hover:text-destructive"
              onClick={onClearChat}
              title="Clear chat history"
            >
              clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Message bubble for comment chat
 */
const CommentMessageBubble = memo(
  function CommentMessageBubble({
    message,
    index,
    isStreaming = false,
    onAcceptChanges,
    onAction,
    onSendResponse,
    hasAcceptedChanges,
    onForward,
    forwardLabel,
    contextPercent,
  }: Readonly<{
    message: ChatMessage;
    index: number;
    isStreaming?: boolean;
    onAcceptChanges?: () => void;
    onAction?: (action: SuggestedAction) => void;
    onSendResponse?: (text: string, messageId: string) => void;
    hasAcceptedChanges?: boolean;
    onForward?: () => void;
    forwardLabel?: string;
    contextPercent?: number | null;
  }>) {
    const isUser = message.role === "user";
    const contentLower = message.content.toLowerCase();

    // Parse suggested actions from assistant messages
    const { actions: suggestedActions } = useMemo(
      () =>
        isUser || isStreaming
          ? {
              actions: [] as SuggestedAction[],
              contentWithoutActions: message.content,
            }
          : parseSuggestedActions(message.content),
      [message.content, isUser, isStreaming]
    );

    // Detect if this is a "pushback" response (declining to make changes, suggesting a reply instead)
    const isPushbackResponse =
      !(isUser || isStreaming) &&
      (message.content.includes("<pr_response>") ||
        contentLower.includes("draft response to reviewer") ||
        contentLower.includes("draft response:") ||
        contentLower.includes("suggested response to reviewer") ||
        contentLower.includes("suggested response:") ||
        contentLower.includes("response to reviewer:") ||
        (contentLower.includes("no change") &&
          contentLower.includes("suggest")) ||
        (contentLower.includes("no code change") &&
          contentLower.includes("response")));

    // Detect if this message contains actual code changes (not just inline code).
    // A message can have both code changes AND a pushback response (e.g., AI made
    // changes and also drafted a PR reply) — allow both buttons to coexist.
    const hasCodeChanges =
      !(isUser || isStreaming) &&
      (message.content.includes("```diff") ||
        (message.content.includes("```") &&
          (contentLower.includes("proposed change") ||
            contentLower.includes("here's the fix") ||
            contentLower.includes("here is the fix") ||
            contentLower.includes("updated code") ||
            contentLower.includes("modified code"))));

    const handleCopy = useCallback(async () => {
      const { contentWithoutActions } = parseSuggestedActions(message.content);
      try {
        await navigator.clipboard.writeText(contentWithoutActions);
        toast.success("Copied to clipboard");
      } catch {
        toast.error("Failed to copy");
      }
    }, [message.content]);

    // Intercept typed actions that need special handling before falling through
    const handleAction = useCallback(
      (action: SuggestedAction) => {
        if (action.type === "send-response" && onSendResponse) {
          const tagMatch = /<pr_response>([\s\S]*?)<\/pr_response>/.exec(
            message.content
          );
          const responseText = tagMatch ? tagMatch[1].trim() : "";
          if (responseText) {
            onSendResponse(responseText, message.id);
          } else {
            toast.error("Could not extract response from message");
          }
          return;
        }
        onAction?.(action);
      },
      [message.content, message.id, onAction, onSendResponse]
    );

    return (
      <ChatBubble
        actions={suggestedActions.length > 0 ? suggestedActions : undefined}
        bubbleClassName={cn(
          isUser
            ? "border border-blue-500/20 bg-blue-500/10 text-blue-900 dark:bg-blue-500/10 dark:text-blue-100"
            : "border border-border bg-muted text-foreground",
          isStreaming && "border-emerald-500/30"
        )}
        contextPercent={contextPercent}
        extraActions={
          !(isUser || isStreaming) &&
          suggestedActions.length === 0 &&
          (hasCodeChanges || isPushbackResponse) ? (
            <div className="mt-2 flex items-center gap-2 px-1">
              {hasCodeChanges && onAcceptChanges && !hasAcceptedChanges && (
                <Button
                  className="h-7 text-xs"
                  onClick={onAcceptChanges}
                  size="sm"
                  variant="default"
                >
                  <Check className="mr-1.5 size-3" />
                  Accept Changes
                </Button>
              )}
              {hasAcceptedChanges && hasCodeChanges && (
                <span className="flex items-center gap-1 text-emerald-600 text-xs dark:text-emerald-400">
                  <Check className="size-3" />
                  Changes accepted
                </span>
              )}
              {isPushbackResponse && onSendResponse && (
                <Button
                  className="h-7 text-xs"
                  onClick={() => {
                    // Extract the draft response from <pr_response> tags (preferred)
                    const tagMatch =
                      /<pr_response>([\s\S]*?)<\/pr_response>/.exec(
                        message.content
                      );

                    let responseText = tagMatch ? tagMatch[1].trim() : "";

                    // Fallback: try older patterns if no tag found
                    if (!responseText) {
                      const draftMatch =
                        /(?:draft response to reviewer|suggested response to reviewer|draft response|suggested response)[:\s]*\n+([\s\S]*?)(?:\n\n---|\n\n(?:Which option|Would you|Let me know|Note:)|$)/i.exec(
                          message.content
                        );
                      if (draftMatch && draftMatch[1].trim().length > 20) {
                        responseText = draftMatch[1]
                          .split("\n")
                          .map((line) => line.replace(/^>\s?/, ""))
                          .join("\n")
                          .trim();
                      }
                    }

                    if (responseText) {
                      onSendResponse(responseText, message.id);
                    } else {
                      toast.error("Could not extract response from message");
                    }
                  }}
                  size="sm"
                  variant="outline"
                >
                  Send Response
                </Button>
              )}
            </div>
          ) : undefined
        }
        forwardLabel={forwardLabel}
        index={index}
        isStreaming={isStreaming}
        messageRole={message.role}
        onAction={suggestedActions.length > 0 ? handleAction : undefined}
        onCopy={isStreaming ? undefined : handleCopy}
        onForward={isUser || isStreaming ? undefined : onForward}
        roleClassName={
          isUser
            ? "text-blue-600 dark:text-blue-400"
            : "text-emerald-600 dark:text-emerald-400"
        }
        roleLabel={isUser ? "you" : "claude"}
        timestamp={message.timestamp}
      >
        {isUser ? (
          <UserMessageContent content={message.content} />
        ) : (
          <CommentAssistantContent
            blocks={message.blocks}
            content={message.content}
            isStreaming={isStreaming}
          />
        )}
      </ChatBubble>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.blocks === next.message.blocks &&
    prev.index === next.index &&
    prev.isStreaming === next.isStreaming &&
    prev.hasAcceptedChanges === next.hasAcceptedChanges &&
    (prev.onAcceptChanges == null) === (next.onAcceptChanges == null) &&
    (prev.onAction == null) === (next.onAction == null) &&
    (prev.onSendResponse == null) === (next.onSendResponse == null) &&
    (prev.onForward == null) === (next.onForward == null) &&
    prev.forwardLabel === next.forwardLabel &&
    prev.contextPercent === next.contextPercent
);

/**
 * Assistant content renderer for comment chat.
 * Handles blocks via MessageContent and special pr_response formatting.
 */
function CommentAssistantContent({
  content,
  blocks,
  isStreaming,
}: Readonly<{
  content: string;
  blocks?: ContentBlock[];
  isStreaming?: boolean;
}>) {
  // Strip suggested-actions tags from content (they're rendered as buttons by ChatBubble)
  const { contentWithoutActions } = useMemo(
    () => parseSuggestedActions(content),
    [content]
  );

  // Parse learnings from content (clean content + extracted learnings)
  const { cleanContent, learnings } = useMemo(
    () => parseLearningsUsed(contentWithoutActions),
    [contentWithoutActions]
  );

  // Check if content has pr_response tags
  const prResponseMatch =
    /^([\s\S]*?)<pr_response>([\s\S]*?)<\/pr_response>([\s\S]*)$/.exec(
      cleanContent
    );

  if (prResponseMatch) {
    const [, before, response, after] = prResponseMatch;
    return (
      <div className="prose prose-sm dark:prose-invert prose-headings:my-2 prose-p:my-1.5 max-w-none">
        {/* Render blocks first */}
        {blocks && blocks.length > 0 && (
          <MessageContent blocks={blocks} content="" />
        )}
        {/* Then render text with pr_response handling */}
        {before.trim() && (
          <ReactMarkdown
            components={commentBubbleMarkdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {before.trim()}
          </ReactMarkdown>
        )}
        <div className="my-3 overflow-hidden rounded-lg border border-blue-500/30 bg-blue-500/5">
          <div className="flex items-center gap-1.5 border-blue-500/20 border-b bg-blue-500/10 px-3 py-1.5">
            <Send className="size-3 text-blue-500" />
            <span className="font-medium text-[11px] text-blue-600 dark:text-blue-400">
              Draft PR response
            </span>
          </div>
          <div className="prose prose-sm dark:prose-invert prose-p:my-1 max-w-none px-3 py-2.5">
            <ReactMarkdown
              components={commentBubbleMarkdownComponents}
              remarkPlugins={[remarkGfm]}
            >
              {response.trim()}
            </ReactMarkdown>
          </div>
        </div>
        {after.trim() && (
          <ReactMarkdown
            components={commentBubbleMarkdownComponents}
            remarkPlugins={[remarkGfm]}
          >
            {after.trim()}
          </ReactMarkdown>
        )}
        {isStreaming && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-emerald-500" />
        )}
        {!isStreaming && learnings.length > 0 && (
          <div className="not-prose mt-2">
            <LearningsUsedDialog learnings={learnings} />
          </div>
        )}
      </div>
    );
  }

  // No pr_response — MessageContent handles learnings parsing + display internally
  return (
    <MessageContent
      blocks={blocks}
      content={contentWithoutActions}
      isStreaming={isStreaming}
      markdownComponents={commentBubbleMarkdownComponents}
    />
  );
}

/**
 * Empty state component for when no comment is selected
 */
export function CommentEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <MessageSquare className="size-5 text-muted-foreground/50" />
      </div>
      <p className="font-mono text-muted-foreground text-sm">
        No comment selected
      </p>
      <p className="mt-1 max-w-[220px] text-muted-foreground/70 text-xs">
        Select a comment to start
      </p>
    </div>
  );
}

function chatInputPlaceholder(
  messageCount: number,
  autoProvider: string | undefined
): string {
  if (messageCount === 0) {
    return 'Type "Fix this" or provide guidance...';
  }
  if (autoProvider === "codex") {
    return "@claude to use Claude...";
  }
  return "Continue the conversation...";
}
