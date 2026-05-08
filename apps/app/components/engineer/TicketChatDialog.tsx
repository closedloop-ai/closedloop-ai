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
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderGit2,
  Loader2,
  MessageSquare,
  PlayCircle,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import pluralize from "pluralize";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageContent } from "@/components/chat/MessageContent";
import type { ChatMessage } from "@/components/chat/types";
import { UserMessageContent } from "@/components/chat/UserMessageContent";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import { useChatStream } from "@/hooks/chat/use-chat-stream";
import { useCodexAvailable } from "@/hooks/engineer/use-codex-available";
import {
  formatTime,
  type LearningUsed,
  parseSuggestedActions,
} from "@/lib/chat/chat-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";
import { ticketChatHistoryOptions } from "@/lib/engineer/queries/tickets";
import type { EngineerTicket } from "@/types/engineer";

type TicketChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: EngineerTicket;
  repoPath: string;
  repoBehindBy?: number; // Number of commits behind origin/main (0 = up to date)
  initialMessage?: string; // Pre-populated context message for learnings scenario
};

/**
 * TicketChatDialog - A dialog for asking Claude questions about a ticket
 * before starting the planning process
 */
export function TicketChatDialog({
  open,
  onOpenChange,
  ticket,
  repoPath,
  repoBehindBy = 0,
  initialMessage,
}: Readonly<TicketChatDialogProps>) {
  const [input, setInput] = useState("");
  const [contextExpanded, setContextExpanded] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isClearChatDialogOpen, setIsClearChatDialogOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const stream = useChatStream();
  const { data: codexData } = useCodexAvailable();

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Clean description for display (strip markdown images, limit length)
  const cleanDescription = ticket.description
    ? ticket.description
        .replaceAll(/!\[.*?\]\(.*?\)/g, "") // Remove image markdown
        .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Convert links to text
        .trim()
    : null;

  // Load chat history for this ticket
  const { data: history, isLoading: isLoadingHistory } = useQuery({
    ...ticketChatHistoryOptions(ticket.identifier),
    enabled: open,
  });

  // Auto-scroll to bottom when new messages arrive
  const initialScrollDone = useRef(false);
  const scrollToBottom = useCallback((instant?: boolean) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  useEffect(() => {
    if (
      !initialScrollDone.current &&
      history?.messages &&
      history.messages.length > 0
    ) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      scrollToBottom();
    }
  }, [history?.messages, scrollToBottom]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Send a message to Claude
  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || stream.isStreaming) {
        return;
      }

      const trimmedInput = messageText.trim();

      stream.setPendingUserMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmedInput,
        timestamp: new Date().toISOString(),
      });

      await stream.sendMessage(
        "/api/gateway/ticket-chat",
        {
          ticketId: ticket.identifier,
          message: trimmedInput,
          ticketContext: {
            identifier: ticket.identifier,
            title: ticket.title,
            description: ticket.description,
            url: ticket.url,
          },
          repoPath,
          codexAvailable: codexData?.available,
        },
        {
          onComplete: async () => {
            await queryClient.invalidateQueries({
              queryKey: queryKeys.ticketChatHistory(ticket.identifier),
            });
          },
          onLearningsUsed: (used: LearningUsed[]) => {
            fetch("/api/gateway/symphony/record-learning-use", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ticketId: ticket.identifier,
                repoPath,
                learnings: used,
              }),
            }).catch((err) =>
              console.error("Failed to record learning use:", err)
            );
          },
        }
      );
    },
    [
      stream,
      ticket.identifier,
      ticket.title,
      ticket.description,
      ticket.url,
      repoPath,
      codexData?.available,
      queryClient,
    ]
  );

  // Track if we've sent the initial message for this dialog session
  const initialMessageSentRef = useRef(false);

  // Send initial message if provided (only once per dialog open)
  useEffect(() => {
    if (
      open &&
      initialMessage &&
      !initialMessageSentRef.current &&
      !isLoadingHistory
    ) {
      initialMessageSentRef.current = true;
      // Small delay to let the dialog render first
      setTimeout(() => {
        sendMessage(initialMessage);
      }, 200);
    }
    // Reset when dialog closes
    if (!open) {
      initialMessageSentRef.current = false;
    }
  }, [open, initialMessage, isLoadingHistory, sendMessage]);

  // Handle sending from the input field
  const handleSend = () => {
    if (input.trim() && !stream.isStreaming) {
      const msg = input;
      setInput("");
      sendMessage(msg);
    }
  };

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Clear entire chat history
  const handleClearChat = async () => {
    try {
      const response = await fetch(
        `/api/gateway/ticket-chat?ticketId=${encodeURIComponent(ticket.identifier)}`,
        { method: "DELETE" }
      );
      if (response.ok) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.ticketChatHistory(ticket.identifier),
        });
      }
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  // Combine history messages with pending user message for display
  const historyMessages = history?.messages || [];
  const messages = stream.pendingUserMessage
    ? [...historyMessages, stream.pendingUserMessage]
    : historyMessages;

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <ExpandableDialogContent
          className="flex h-[80vh] max-h-[800px] w-[95vw] max-w-2xl flex-col gap-0 overflow-hidden border-border bg-background p-0 md:max-w-3xl lg:max-w-4xl"
          isExpanded={isExpanded}
          onToggleExpand={() => setIsExpanded((v) => !v)}
        >
          <DialogTitle className="sr-only">{`Ask Claude about ${ticket.identifier}`}</DialogTitle>

          {/* Ticket context header */}
          <div className="shrink-0 border-border border-b bg-muted/30 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-medium font-mono text-muted-foreground text-xs">
                    {ticket.identifier}
                  </span>
                  <a
                    className="text-muted-foreground transition-colors hover:text-primary"
                    href={ticket.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="View in Linear"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                </div>
                <h3 className="line-clamp-2 font-medium text-sm">
                  {ticket.title}
                </h3>
                {/* Repo path indicator */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <FolderGit2 className="size-3 text-muted-foreground" />
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {repoPath}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Warning banner if repo is out of date */}
          {repoBehindBy > 0 && (
            <div className="flex items-center gap-2 border-amber-500/20 border-b bg-amber-500/10 px-5 py-2.5">
              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="font-medium text-amber-700 text-xs dark:text-amber-300">
                Repository is {repoBehindBy} {pluralize("commit", repoBehindBy)}{" "}
                behind origin/main
              </span>
            </div>
          )}

          {/* Messages area */}
          <div className="chat-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {isLoadingHistory && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!isLoadingHistory &&
              messages.length === 0 &&
              !stream.isStreaming && (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
                    <MessageSquare className="size-5 text-muted-foreground" />
                  </div>
                  <p className="font-mono text-muted-foreground text-sm">
                    Ask Claude about this ticket
                  </p>
                  <p className="mt-1 max-w-[280px] text-muted-foreground/70 text-xs">
                    Get help understanding requirements, scope, or
                    implementation approaches
                  </p>
                </div>
              )}
            {!isLoadingHistory &&
              (messages.length > 0 || stream.isStreaming) && (
                <>
                  {(() => {
                    // Find the index of the last assistant message (excluding streaming)
                    let lastAssistantIdx = -1;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "assistant") {
                        lastAssistantIdx = i;
                        break;
                      }
                    }

                    return messages.map((msg, idx) => {
                      const isLastAssistant =
                        idx === lastAssistantIdx && !stream.isStreaming;
                      return (
                        <MessageBubble
                          index={idx}
                          isLastAssistantMessage={isLastAssistant}
                          key={msg.id}
                          message={msg}
                          onSendAction={
                            isLastAssistant ? sendMessage : undefined
                          }
                        />
                      );
                    });
                  })()}
                  {stream.isStreaming &&
                    (stream.streamingContent ||
                      stream.streamingBlocks.length > 0) && (
                      <MessageBubble
                        index={messages.length}
                        isStreaming
                        message={{
                          id: "streaming",
                          role: "assistant",
                          content: stream.streamingContent,
                          timestamp: new Date().toISOString(),
                          blocks: stream.streamingBlocks,
                        }}
                      />
                    )}
                  {stream.isStreaming &&
                    !stream.streamingContent &&
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
                  {stream.error && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 font-mono text-red-600 text-xs dark:text-red-400">
                      Error: {stream.error}
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </>
              )}
          </div>

          {/* Input area */}
          <div className="shrink-0 border-border border-t bg-muted/30">
            {/* Context indicator - only show before first message is sent */}
            {historyMessages.length === 0 && (
              <div className="mx-4 mt-3 mb-0">
                <button
                  className="w-full cursor-pointer rounded-lg border border-primary/20 bg-primary/10 p-2.5 text-left transition-colors hover:bg-primary/15"
                  onClick={() => setContextExpanded(!contextExpanded)}
                  type="button"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="size-3.5 shrink-0 text-primary" />
                    <span className="flex-1 font-medium text-primary text-xs">
                      Ticket + codebase context
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-3.5 text-primary transition-transform",
                        contextExpanded && "rotate-180"
                      )}
                    />
                  </div>
                  {contextExpanded && (
                    <div className="mt-2 border-primary/20 border-t pt-2">
                      <p className="mb-1 font-medium font-mono text-[11px] text-foreground">
                        {ticket.title}
                      </p>
                      {cleanDescription && (
                        <>
                          <p className="line-clamp-4 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                            {cleanDescription}
                          </p>
                          {cleanDescription.length > 200 && (
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground/50 italic">
                              Preview only - full description sent to Claude
                            </p>
                          )}
                        </>
                      )}
                      {!cleanDescription && (
                        <p className="font-mono text-[11px] text-muted-foreground/60 italic">
                          No description
                        </p>
                      )}
                    </div>
                  )}
                </button>
              </div>
            )}

            <div className="relative flex items-end gap-3 p-4 pt-3">
              <span className="shrink-0 pb-2.5 font-bold font-mono text-primary text-sm">
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
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about this ticket..."
                  ref={inputRef}
                  rows={1}
                  style={{
                    minHeight: "40px",
                    maxHeight: "50vh",
                    overflow: "hidden",
                  }}
                  value={input}
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
                    type="button"
                  >
                    <Square className="size-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      input.trim()
                        ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90"
                        : "cursor-not-allowed bg-muted text-muted-foreground"
                    )}
                    disabled={!input.trim()}
                    onClick={handleSend}
                    type="button"
                  >
                    <Send className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between px-4 pb-4">
              <span className="font-mono text-[10px] text-muted-foreground">
                Shift+Enter for new line
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {messages.length} message{messages.length === 1 ? "" : "s"}
                </span>
                {historyMessages.length > 0 && (
                  <button
                    className="flex cursor-pointer items-center gap-1 font-mono text-[10px] text-muted-foreground/50 transition-colors hover:text-destructive"
                    onClick={() => setIsClearChatDialogOpen(true)}
                    title="Clear chat history"
                    type="button"
                  >
                    <Trash2 className="size-3" />
                    clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </ExpandableDialogContent>
      </Dialog>
      <AlertDialog
        onOpenChange={setIsClearChatDialogOpen}
        open={isClearChatDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear ticket chat history?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all saved messages for this ticket.
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
    </>
  );
}

/**
 * Message bubble component
 */
const MessageBubble = memo(function MessageBubble({
  message,
  index,
  isStreaming = false,
  isLastAssistantMessage = false,
  onSendAction,
}: Readonly<{
  message: ChatMessage;
  index: number;
  isStreaming?: boolean;
  isLastAssistantMessage?: boolean;
  onSendAction?: (message: string) => void;
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
      contentWithoutActions: parsed.contentWithoutActions,
    };
  }, [isUser, isStreaming, isLastAssistantMessage, message.content]);

  return (
    <div
      className={cn(
        "group fade-in slide-in-from-bottom-2 flex animate-in flex-col gap-1 duration-300",
        isUser ? "items-end" : "items-start"
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Role indicator */}
      <div className="flex items-center gap-2 px-1">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-wider",
            isUser ? "text-muted-foreground" : "text-primary"
          )}
        >
          {isUser ? "you" : "closedloop.dev"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {formatTime(message.timestamp)}
        </span>
      </div>

      {/* Message content */}
      <div
        className={cn(
          "min-w-0 max-w-[90%] overflow-hidden rounded-xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-[#3b5bdb] text-white dark:bg-[#364fc7]"
            : "bg-[#E5E5EA] text-foreground dark:bg-[#38383D]",
          isStreaming && "border-primary/30"
        )}
      >
        {isUser ? (
          <UserMessageContent content={message.content} />
        ) : (
          <MessageContent
            blocks={message.blocks}
            content={contentWithoutActions}
            isStreaming={isStreaming}
          />
        )}
      </div>

      {/* Suggested action buttons for assistant messages */}
      {!(isUser || isStreaming) && actions.length > 0 && onSendAction && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
          {actions.map((action) => (
            <button
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-xs",
                "border border-primary/20 bg-primary/10 text-primary",
                "cursor-pointer transition-colors hover:border-primary/30 hover:bg-primary/20"
              )}
              key={action.message}
              onClick={() => onSendAction(action.message)}
              type="button"
            >
              <PlayCircle className="size-3" />
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
