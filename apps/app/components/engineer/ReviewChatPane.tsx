"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Brain,
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
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type { ReviewConfig } from "@/components/engineer/CodexReviewSettingsDialog";
import { StatusNote } from "@/components/engineer/CommentChat";
import {
  ChatBubble,
  MessageContent,
  SlashCommandDropdown,
  UserMessageContent,
} from "@/components/engineer/chat";
import type { ContentBlock } from "@/components/engineer/chat/types";
import { VerdictBanner } from "@/components/engineer/codex-review/VerdictBanner";
import {
  FileMentionAutocomplete,
  type MentionState,
} from "@/components/engineer/FileMentionAutocomplete";
import { useChatStream } from "@/hooks/engineer/use-chat-stream";
import { useReviewChat } from "@/hooks/engineer/use-review-chat";
import { useReviewExecution } from "@/hooks/engineer/use-review-execution";
import type { useSlashCommands } from "@/hooks/engineer/use-slash-commands";
import { chatMarkdownComponents } from "@/lib/engineer/chat-markdown";
import {
  CHAT_SENTINEL,
  type LearningUsed,
  parseSuggestedActions,
  type SuggestedAction,
  stripProtocolMetadata,
} from "@/lib/engineer/chat-utils";
import {
  parseFindingTitle,
  type ReviewFinding,
} from "@/lib/engineer/codex-review-parser";
import { symphonyChatHistoryOptions } from "@/lib/engineer/queries/symphony";
import { stripWorktreePath } from "@/lib/engineer/review-path-utils";
import { formatReviewSummary } from "@/lib/engineer/review-split";

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
  /** Called when structured findings are extracted via session resumption */
  onStructuredFindings?: (findings: ReviewFinding[]) => void;
  /** Indices of findings flagged as duplicates of the other provider's review */
  duplicateIndices?: Set<number>;
  /** Indices of findings flagged as duplicates of existing PR comments */
  prCommentDupIndices?: Set<number>;
  /** Files changed in the PR — findings outside this list are filtered out */
  prFiles?: string[];
  /** Whether the PR has been merged (shows a visual indicator) */
  isMerged?: boolean;
  /** Called when all findings have been individually commented */
  onAllCommented?: () => void;
  /** Called when the server emits a learnings event during chat */
  onLearnings?: () => void;
  /** Called when the assistant cites org patterns */
  onLearningsUsed?: (learnings: LearningUsed[]) => void;
  /** Called when the user types /reflect */
  onReflect?: () => void;
  /** Current learnings extraction status */
  learningsStatus?: "none" | "processing" | "completed";
  /** Number of learnings extracted */
  learningsCount?: number;
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
  prFiles,
  isMerged,
  onAllCommented,
  onLearnings,
  onLearningsUsed,
  onReflect,
  learningsStatus,
  learningsCount,
}: Readonly<ReviewChatPaneProps>) {
  const ticketId = `pr-${prNumber}`;
  const outputEndRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const stream = useChatStream();

  // Review execution state machine
  const review = useReviewExecution({
    ticketId,
    repoPath,
    prNumber,
    branchName,
    config,
    initialOutput,
    commitSha,
    prFiles,
    duplicateIndices,
    prCommentDupIndices,
    onReviewComplete,
    onStructuredFindings,
    onAllCommented,
  });

  const { data: chatHistory } = useQuery({
    ...symphonyChatHistoryOptions(ticketId, repoPath, config.provider),
    enabled: review.reviewDone,
  });

  // Provider readiness — derived from persisted state, survives page reload
  const claudeIsReady = !!chatHistory?.sessionId;
  const codexIsReady = !!chatHistory?.codexSessionExists;

  // Chat routing state machine
  const chat = useReviewChat({
    ticketId,
    repoPath,
    config,
    reviewOutput: review.reviewOutput,
    claudeIsReady,
    codexIsReady,
    stream,
    chatHistory,
    inputRef,
    onLearnings,
    onLearningsUsed,
    onReflect,
  });

  const chatMessages = useMemo(() => {
    const base = chatHistory?.messages || [];
    if (stream.pendingUserMessage) {
      return [...base, stream.pendingUserMessage];
    }
    return base;
  }, [chatHistory?.messages, stream.pendingUserMessage]);

  // Auto-scroll during review streaming
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Auto-scroll during chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Precompute last assistant index for O(1) lookup in map
  let lastAssistantIndex = -1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-border border-b bg-muted/30 px-5 py-3 pr-10">
        <div className="relative flex items-center gap-3">
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
            {review.reviewCommand && (
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {review.reviewCommand}
              </span>
            )}
            {isMerged && (
              <span className="ml-2 rounded bg-violet-500/10 px-1.5 py-0.5 font-bold font-mono text-[10px] text-violet-600 dark:text-violet-400">
                Merged
              </span>
            )}
          </span>
          {review.reviewDone && !review.isReviewing && (
            <button
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onNewReview}
              title="New review"
            >
              <RotateCcw className="size-4" />
            </button>
          )}
          {learningsStatus === "processing" && (
            <Brain className="size-4 animate-pulse text-violet-500" />
          )}
          {learningsStatus === "completed" && (learningsCount ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 text-violet-500">
              <Brain className="size-4" />
              <span className="font-mono text-[10px]">{learningsCount}</span>
            </span>
          )}
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {/* During streaming: thinking block (collapsed) + "Reviewing..." */}
        {review.isReviewing && (
          <ChatBubble
            isStreaming
            messageRole="assistant"
            sender={config.provider === "claude" ? "claude" : "codex"}
            timestamp={review.reviewStartedAt}
          >
            <MessageContent
              blocks={
                review.reviewOutput
                  ? [
                      {
                        type: "thinking" as const,
                        thinking: review.reviewOutput,
                      },
                    ]
                  : undefined
              }
              content="Reviewing..."
              isStreaming
            />
          </ChatBubble>
        )}

        {/* Completed review: process log as thinking block + findings */}
        {review.reviewSplit && (
          <>
            <ChatBubble
              contextPercent={review.reviewContextPercent ?? undefined}
              messageRole="assistant"
              sender={config.provider === "claude" ? "claude" : "codex"}
              timestamp={review.reviewStartedAt}
            >
              <MessageContent
                blocks={
                  review.reviewSplit.processLog
                    ? [
                        {
                          type: "thinking" as const,
                          thinking: review.reviewSplit.processLog,
                        },
                      ]
                    : undefined
                }
                content={formatReviewSummary(
                  review.reviewSplit.findings.length
                )}
              />
            </ChatBubble>
            {review.effectiveVerdict && (
              <div className="pl-2">
                <VerdictBanner
                  isDeclined={review.declined}
                  isSubmitting={review.isSubmittingDecline}
                  onDecline={review.handleDecline}
                  verdict={review.effectiveVerdict}
                />
              </div>
            )}
            {review.hasDeclineVerdict &&
              !review.declined &&
              !review.findingsRevealed &&
              review.reviewSplit.findings.length > 0 && (
                <div className="pl-2">
                  <Button
                    onClick={() => review.setFindingsRevealed(true)}
                    size="sm"
                    variant="ghost"
                  >
                    See findings ({review.reviewSplit.findings.length})
                  </Button>
                </div>
              )}
            {review.showFindings && review.reviewSplit.findings.length > 0 && (
              <div className="space-y-2 pl-2">
                {review.reviewSplit.findings.map((finding) => {
                  const idx = finding.originalIndex;
                  const isProviderDup = duplicateIndices?.has(idx) ?? false;
                  const isPRCommentDup = prCommentDupIndices?.has(idx) ?? false;
                  return (
                    <FindingCard
                      duplicateLabel={isPRCommentDup ? "In PR" : "Dup"}
                      finding={finding}
                      index={idx}
                      isDuplicate={isProviderDup || isPRCommentDup}
                      isOwnPR={isOwnPR}
                      isSubmitted={review.submittedFindings.has(idx)}
                      isSubmitting={review.submittingFindings.has(idx)}
                      key={`finding-${idx}`}
                      onChat={chat.handleChatAboutFinding}
                      onSubmitComment={review.handleSubmitComment}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* Chat messages (after review completes) */}
        {review.reviewDone &&
          chatMessages.map((msg, idx) => {
            const statusNote = REVIEW_STATUS_NOTES[msg.content];
            if (statusNote && msg.role === "user") {
              return (
                <StatusNote
                  className={statusNote.className}
                  idx={idx}
                  key={msg.id}
                  text={statusNote.text}
                />
              );
            }

            return (
              <ChatMessageItem
                chatHistoryContextPercent={chatHistory?.contextPercent ?? null}
                isLastAssistant={
                  idx === lastAssistantIndex && !stream.isStreaming
                }
                key={msg.id}
                msg={msg}
                onAction={chat.handleChatActionForProvider}
                streamContextPercent={stream.contextPercent}
              />
            );
          })}

        {/* Streaming chat response */}
        {stream.isStreaming &&
          (stream.streamingContent || stream.streamingBlocks.length > 0) && (
            <ChatBubble
              bubbleClassName="bg-muted text-foreground border border-border border-emerald-500/30"
              isStreaming
              messageRole="assistant"
              roleClassName={
                chat.streamingProvider === "codex"
                  ? undefined
                  : "text-emerald-600 dark:text-emerald-400"
              }
              sender={chat.streamingProvider === "codex" ? "codex" : "claude"}
              timestamp={stream.streamStartedAt}
            >
              <MessageContent
                blocks={stream.streamingBlocks}
                content={
                  parseSuggestedActions(stream.streamingContent)
                    .contentWithoutActions
                }
                isStreaming
              />
            </ChatBubble>
          )}

        {/* Waiting indicator */}
        {stream.isStreaming &&
          !stream.streamingContent &&
          stream.streamingBlocks.length === 0 && (
            <WaitingDots provider={chat.streamingProvider} />
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
        {review.isReviewing ? (
          <Button
            className="w-full"
            onClick={review.handleStopReview}
            variant="outline"
          >
            <Square className="mr-2 size-3" />
            Stop Review
          </Button>
        ) : (
          <ReviewChatInput
            chatInput={chat.chatInput}
            chatMessageCount={chatMessages.length}
            inputRef={inputRef}
            isStreaming={stream.isStreaming}
            mentionState={chat.mentionState}
            onFileSelect={chat.handleFileSelect}
            onInputChange={chat.handleInputChange}
            onKeyDown={chat.handleKeyDown}
            onMentionFilesChange={chat.setMentionFiles}
            onMentionStateChange={chat.setMentionState}
            onSendChat={chat.handleSendChat}
            onStopStreaming={stream.stopStreaming}
            repoPath={repoPath}
            slash={chat.slash}
            ticketId={ticketId}
          />
        )}
      </div>
    </div>
  );
}

// --- File-private sub-components ---

type ChatMessageItemProps = {
  msg: {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
    sender?: string;
    blocks?: ContentBlock[];
  };
  isLastAssistant: boolean;
  streamContextPercent: number | null;
  chatHistoryContextPercent: number | null;
  onAction: (action: SuggestedAction, provider: "claude" | "codex") => void;
};

function ChatMessageItem({
  msg,
  isLastAssistant,
  streamContextPercent,
  chatHistoryContextPercent,
  onAction,
}: Readonly<ChatMessageItemProps>) {
  const { actions, contentWithoutActions } =
    msg.role === "assistant"
      ? parseSuggestedActions(msg.content)
      : {
          actions: [] as SuggestedAction[],
          contentWithoutActions: msg.content,
        };
  const displayContent =
    msg.role === "assistant"
      ? stripProtocolMetadata(contentWithoutActions)
      : msg.content;
  const effectiveActions = isLastAssistant ? actions : [];
  const effectiveSender: "claude" | "codex" =
    msg.sender === "codex" ? "codex" : "claude";
  return (
    <ChatBubble
      actions={effectiveActions}
      bubbleClassName={
        msg.role === "user"
          ? "bg-blue-500/10 dark:bg-blue-500/10 text-blue-900 dark:text-blue-100 border border-blue-500/20"
          : "bg-muted text-foreground border border-border"
      }
      contextPercent={
        isLastAssistant
          ? (streamContextPercent ?? chatHistoryContextPercent ?? undefined)
          : undefined
      }
      messageRole={msg.role}
      onAction={(action) => onAction(action, effectiveSender)}
      onCopy={async () => {
        try {
          await navigator.clipboard.writeText(displayContent);
          toast.success("Copied to clipboard");
        } catch {
          toast.error("Failed to copy");
        }
      }}
      roleClassName={getRoleClassName(msg.role, effectiveSender)}
      roleLabel={msg.role === "user" ? "you" : undefined}
      sender={msg.role === "assistant" ? effectiveSender : undefined}
      timestamp={msg.timestamp ?? ""}
    >
      {msg.role === "user" ? (
        <UserMessageContent content={msg.content} />
      ) : (
        <MessageContent blocks={msg.blocks} content={displayContent} />
      )}
    </ChatBubble>
  );
}

function WaitingDots({ provider }: Readonly<{ provider: "claude" | "codex" }>) {
  const dotColor =
    provider === "codex" ? "bg-muted-foreground/60" : "bg-emerald-500/60";
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <div className="flex gap-1">
        <span
          className={`size-1.5 animate-bounce rounded-full ${dotColor} [animation-delay:0ms]`}
        />
        <span
          className={`size-1.5 animate-bounce rounded-full ${dotColor} [animation-delay:150ms]`}
        />
        <span
          className={`size-1.5 animate-bounce rounded-full ${dotColor} [animation-delay:300ms]`}
        />
      </div>
      <span className="font-mono text-muted-foreground text-xs">
        analyzing...
      </span>
    </div>
  );
}

type ReviewChatInputProps = {
  chatInput: string;
  mentionState: MentionState | null;
  slash: ReturnType<typeof useSlashCommands>;
  isStreaming: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  repoPath: string;
  ticketId: string;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSendChat: () => void;
  onFileSelect: (file: string) => void;
  onMentionStateChange: (state: MentionState | null) => void;
  onMentionFilesChange: (files: string[]) => void;
  chatMessageCount: number;
  onStopStreaming: () => void;
};

function ReviewChatInput({
  chatInput,
  mentionState,
  slash,
  isStreaming,
  inputRef,
  repoPath,
  ticketId,
  onInputChange,
  onKeyDown,
  onSendChat,
  onFileSelect,
  onMentionStateChange,
  onMentionFilesChange,
  chatMessageCount,
  onStopStreaming,
}: Readonly<ReviewChatInputProps>) {
  return (
    <>
      <div className="relative flex items-end gap-3">
        <span className="shrink-0 pb-2.5 font-bold font-mono text-emerald-600 text-sm dark:text-emerald-500">
          {">"}
        </span>
        <div className="relative flex-1">
          {mentionState?.isOpen && (
            <FileMentionAutocomplete
              isOpen
              onClose={() => onMentionStateChange(null)}
              onFilesChange={onMentionFilesChange}
              onSelect={onFileSelect}
              onSelectedIndexChange={(i) =>
                onMentionStateChange(
                  mentionState ? { ...mentionState, selectedIndex: i } : null
                )
              }
              query={mentionState.query}
              repoPath={repoPath}
              selectedIndex={mentionState.selectedIndex}
              ticketId={ticketId}
            />
          )}
          {slash.slashState?.isOpen && (
            <SlashCommandDropdown
              commands={slash.filteredCommands}
              onSelect={slash.selectCommand}
              selectedIndex={slash.slashState.selectedIndex}
            />
          )}
          {/* @codex/@claude prefix highlight overlay */}
          {/^@(claude|codex)\s/i.test(chatInput) && (
            <div
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 py-2 font-mono text-sm leading-relaxed"
            >
              <span
                className={cn(
                  "font-semibold",
                  /^@claude\s/i.test(chatInput)
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-blue-600 dark:text-blue-400"
                )}
              >
                {chatInput.split(/\s/)[0]}
              </span>
              <span className="text-foreground">
                {chatInput.slice(chatInput.search(/\s/))}
              </span>
            </div>
          )}
          <textarea
            className={cn(
              "w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground",
              "py-2 pr-10 font-mono leading-relaxed",
              "focus:outline-none focus:ring-0",
              "disabled:cursor-not-allowed disabled:opacity-50",
              /^@(claude|codex)\s/i.test(chatInput) &&
                "text-transparent caret-foreground"
            )}
            disabled={isStreaming}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            placeholder="Ask about the review findings... (@claude or @codex)"
            ref={inputRef}
            rows={1}
            style={{
              minHeight: "40px",
              maxHeight: "50vh",
              overflow: "hidden",
            }}
            value={chatInput}
          />
          {isStreaming ? (
            <button
              className={cn(
                "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                "cursor-pointer transition-all duration-200",
                "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
              )}
              onClick={onStopStreaming}
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
              onClick={onSendChat}
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
          {chatMessageCount} message
          {chatMessageCount === 1 ? "" : "s"}
        </span>
      </div>
    </>
  );
}

// --- Helpers + remaining file-private components ---

function getRoleClassName(
  role: string,
  sender: "claude" | "codex"
): string | undefined {
  if (role === "user") {
    return "text-blue-600 dark:text-blue-400";
  }
  if (sender === "codex") {
    return undefined;
  }
  return "text-emerald-600 dark:text-emerald-400";
}

const REVIEW_STATUS_NOTES: Record<
  string,
  { text: string; className?: string }
> = {
  [CHAT_SENTINEL.CLAUDE_CONFERRED_TO_CODEX]: {
    text: "Claude asked Codex for input",
    className: "text-blue-600/70 dark:text-blue-400/70",
  },
  [CHAT_SENTINEL.CODEX_CONFERRED_TO_CLAUDE]: {
    text: "Codex asked Claude for input",
    className: "text-blue-600/70 dark:text-blue-400/70",
  },
};

// --- Finding card ---

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
  const { title: findingTitle, description: findingBody } = parseFindingTitle(
    finding.message
  );
  const humanized = finding.humanizedBody?.trim() || undefined;
  // Prefer humanized body for display. This is also what gets posted as a PR
  // comment (see buildCommentBody), so the UI matches the outcome exactly.
  const displayBody = humanized ?? findingBody;
  const title = findingTitle.slice(0, 100);

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
        <div
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            style.badge
          )}
        >
          <Icon className={cn("size-3.5", style.text)} />
        </div>
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
        <button
          className="mt-0.5 shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
          onClick={() => setCollapsed(true)}
          title="Collapse"
          type="button"
        >
          <ChevronRight className="size-3.5 rotate-90" />
        </button>
      </div>
      <div className="space-y-2 pl-[34px]">
        <p className="font-semibold text-[13px] text-foreground leading-snug">
          {findingTitle}
        </p>
        {displayBody && (
          <div className="text-[12px] text-foreground/70 leading-relaxed">
            <ReactMarkdown
              components={chatMarkdownComponents}
              remarkPlugins={[remarkGfm]}
            >
              {displayBody}
            </ReactMarkdown>
          </div>
        )}
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
          <>
            <button
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-[11px] transition-colors",
                commentButtonStyle(isSubmitting, isDuplicate)
              )}
              disabled={isSubmitting || isDuplicate}
              onClick={() => onSubmitComment(index, finding)}
            >
              <CommentButtonContent
                duplicateLabel={duplicateLabel}
                isDuplicate={isDuplicate}
                isSubmitting={isSubmitting}
              />
            </button>
            {isSubmitted && (
              <span className="inline-flex items-center gap-1 font-medium text-[11px] text-emerald-600 dark:text-emerald-400">
                <Check className="size-3" />
                Commented
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Comment button helpers (avoids nested ternaries — SonarQube S3358) ---

function commentButtonStyle(
  isSubmitting: boolean,
  isDuplicate: boolean
): string {
  if (isDuplicate) {
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400 cursor-default";
  }
  if (isSubmitting) {
    return "bg-muted text-muted-foreground cursor-wait";
  }
  return "bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground cursor-pointer";
}

function CommentButtonContent({
  isSubmitting,
  isDuplicate,
  duplicateLabel,
}: Readonly<{
  isSubmitting: boolean;
  isDuplicate: boolean;
  duplicateLabel?: string;
}>) {
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
