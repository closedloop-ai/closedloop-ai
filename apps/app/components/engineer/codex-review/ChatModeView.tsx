"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowLeft,
  Brain,
  MessageSquare,
  MessagesSquare,
  Search,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ChatBubble } from "@/components/engineer/chat/ChatBubble";
import { ChatInput } from "@/components/engineer/chat/ChatInput";
import { MessageContent } from "@/components/engineer/chat/MessageContent";
import type { ChatMessage } from "@/components/engineer/chat/types";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import type { useChatStream } from "@/hooks/engineer/use-chat-stream";
import type { useCodexDebate } from "@/hooks/engineer/use-codex-debate";
import type { SuggestedAction } from "@/lib/engineer/chat-utils";
import { parseSuggestedActions } from "@/lib/engineer/chat-utils";
import type {
  ReviewFinding,
  ReviewFindings,
} from "@/lib/engineer/codex-review-parser";
import { severityToPriority } from "./constants";
import { FindingsPanel } from "./FindingsPanel";
import { PriorityBadge } from "./PriorityBadge";

type ChatModeViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  isCompleted: boolean;
  // Findings
  findings: ReviewFindings;
  dismissedFindings: Set<number>;
  expandedFindings: Set<number>;
  selectedFindingIndex: number | null;
  onSelectFinding: (idx: number | null) => void;
  onToggleFindingExpand: (idx: number) => void;
  onToggleFindingDismiss: (idx: number) => void;
  onOpenFindingChat: (idx: number) => void;
  onExitChatMode: () => void;
  // Chat
  chatMessages: ChatMessage[];
  chatInput: string;
  onChatInputChange: (value: string) => void;
  onSendChat: () => void;
  chatHistory?: { messages: ChatMessage[] };
  activeChatHistory?: {
    messages: ChatMessage[];
    contextPercent?: number | null;
  };
  // Streams
  activeStream: ReturnType<typeof useChatStream>;
  // Debate
  debate: ReturnType<typeof useCodexDebate>;
  // Actions
  onAction: (action: SuggestedAction) => void;
  onClearChat: () => Promise<void>;
  // Learnings
  learningsStatus?: "none" | "processing" | "completed";
  learningsCount?: number;
};

export function ChatModeView({
  open,
  onOpenChange,
  ticketId,
  isExpanded,
  onToggleExpand,
  isCompleted,
  findings,
  dismissedFindings,
  expandedFindings,
  selectedFindingIndex,
  onSelectFinding,
  onToggleFindingExpand,
  onToggleFindingDismiss,
  onOpenFindingChat,
  onExitChatMode,
  chatMessages,
  chatInput,
  onChatInputChange,
  onSendChat,
  chatHistory,
  activeChatHistory,
  activeStream,
  debate,
  onAction,
  onClearChat,
  learningsStatus,
  learningsCount,
}: Readonly<ChatModeViewProps>) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const initialChatScrollDone = useRef(false);

  const isAnyStreaming =
    activeStream.isStreaming || !!debate.codexStream.pendingUserMessage;
  const selectedFinding =
    selectedFindingIndex == null
      ? null
      : findings.findings[selectedFindingIndex];

  const chatPaneTitle = buildChatPaneTitle(selectedFinding, debate.debateMode);

  // Auto-scroll chat
  useEffect(() => {
    if (!chatEndRef.current) {
      return;
    }
    if (!initialChatScrollDone.current && chatMessages.length > 0) {
      initialChatScrollDone.current = true;
      requestAnimationFrame(() =>
        chatEndRef.current?.scrollIntoView({ behavior: "instant" })
      );
    } else {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <ExpandableDialogContent
        className="flex h-[80vh] w-[95vw] max-w-6xl flex-col p-0 sm:max-w-6xl"
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      >
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5" />
            Code Review - {ticketId}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Left pane - Findings */}
          <FindingsLeftPane
            chatHistory={chatHistory}
            dismissedFindings={dismissedFindings}
            expandedFindings={expandedFindings}
            findings={findings}
            isCompleted={isCompleted}
            onExitChatMode={onExitChatMode}
            onOpenFindingChat={onOpenFindingChat}
            onSelectFinding={onSelectFinding}
            onToggleFindingDismiss={onToggleFindingDismiss}
            onToggleFindingExpand={onToggleFindingExpand}
            selectedFindingIndex={selectedFindingIndex}
          />

          {/* Right pane - Chat */}
          <div className="flex w-1/2 flex-col">
            <ChatPaneHeader
              chatPaneTitle={chatPaneTitle}
              debate={debate}
              learningsCount={learningsCount}
              learningsStatus={learningsStatus}
              selectedFinding={selectedFinding}
            />
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <ChatMessageList
                chatMessages={chatMessages}
                contextPercent={
                  activeStream.contextPercent ??
                  activeChatHistory?.contextPercent ??
                  null
                }
                debate={debate}
                isAnyStreaming={isAnyStreaming}
                onAction={onAction}
              />
              <StreamingBubbles
                activeStream={activeStream}
                activeStreamStartedAt={activeStream.streamStartedAt}
                codexStreamStartedAt={debate.codexStream.streamStartedAt}
                debate={debate}
                selectedFindingIndex={selectedFindingIndex}
              />
              <div ref={chatEndRef} />
            </div>
            <ChatInput
              footer={
                <ChatFooter
                  hasHistory={(activeChatHistory?.messages?.length ?? 0) > 0}
                  messageCount={chatMessages.length}
                  onClear={onClearChat}
                />
              }
              isStreaming={activeStream.isStreaming}
              onChange={onChatInputChange}
              onSend={onSendChat}
              onStop={activeStream.stopStreaming}
              placeholder={
                selectedFindingIndex === null
                  ? "Ask about the findings..."
                  : "Ask about this finding..."
              }
              value={chatInput}
            />
          </div>
        </div>
      </ExpandableDialogContent>
    </Dialog>
  );
}

// --- Sub-components extracted from the chat mode JSX ---

function buildChatPaneTitle(
  selectedFinding: ReviewFinding | null,
  debateMode: boolean
): string {
  if (selectedFinding) {
    const firstLine = selectedFinding.message.split("\n")[0];
    return `Finding: ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;
  }
  if (debateMode) {
    return "Claude vs Codex Debate";
  }
  return "All Findings Discussion";
}

type FindingsLeftPaneProps = {
  findings: ReviewFindings;
  dismissedFindings: Set<number>;
  expandedFindings: Set<number>;
  selectedFindingIndex: number | null;
  onSelectFinding: (idx: number | null) => void;
  onToggleFindingExpand: (idx: number) => void;
  onToggleFindingDismiss: (idx: number) => void;
  onOpenFindingChat: (idx: number) => void;
  onExitChatMode: () => void;
  isCompleted: boolean;
  chatHistory?: { messages: ChatMessage[] };
};

function FindingsLeftPane({
  findings,
  dismissedFindings,
  expandedFindings,
  selectedFindingIndex,
  onSelectFinding,
  onToggleFindingExpand,
  onToggleFindingDismiss,
  onOpenFindingChat,
  onExitChatMode,
  isCompleted,
  chatHistory,
}: Readonly<FindingsLeftPaneProps>) {
  return (
    <div className="flex w-1/2 flex-col border-r">
      <div className="border-b p-4">
        <h3 className="font-medium">Review Findings</h3>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* General Discussion option */}
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm transition-colors",
            selectedFindingIndex === null
              ? "border-l-2 border-l-primary bg-muted/30"
              : "hover:bg-muted/50"
          )}
          onClick={() => onSelectFinding(null)}
          type="button"
        >
          <MessagesSquare className="size-4 text-muted-foreground" />
          <span className="font-medium">All Findings</span>
          {chatHistory?.messages && chatHistory.messages.length > 0 && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {chatHistory.messages.length} msg
              {chatHistory.messages.length === 1 ? "" : "s"}
            </span>
          )}
        </button>

        <FindingsPanel
          chatMode
          dismissedFindings={dismissedFindings}
          expandedFindings={expandedFindings}
          findings={findings}
          onOpenChat={onOpenFindingChat}
          onSelectFinding={onSelectFinding}
          onToggleDismiss={onToggleFindingDismiss}
          onToggleExpand={onToggleFindingExpand}
          selectedFindingIndex={selectedFindingIndex}
        />
      </div>
      <div className="border-t p-4">
        <Button
          className="w-full"
          onClick={onExitChatMode}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft className="mr-2 size-4" />
          {isCompleted ? "Back to Review" : "Back to Review Config"}
        </Button>
      </div>
    </div>
  );
}

type ChatPaneHeaderProps = {
  chatPaneTitle: string;
  debate: ReturnType<typeof useCodexDebate>;
  selectedFinding: ReviewFinding | null;
  learningsStatus?: "none" | "processing" | "completed";
  learningsCount?: number;
};

function ChatPaneHeader({
  chatPaneTitle,
  debate,
  selectedFinding,
  learningsStatus,
  learningsCount,
}: Readonly<ChatPaneHeaderProps>) {
  return (
    <div className="border-b p-4">
      <h3 className="flex items-center gap-2 truncate font-medium">
        <MessageSquare className="size-4 shrink-0" />
        <span className="truncate">{chatPaneTitle}</span>
        {learningsStatus === "processing" && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground text-xs"
            title="Extracting learnings from this conversation..."
          >
            <Brain className="h-3.5 w-3.5 animate-pulse" />
          </span>
        )}
        {learningsStatus === "completed" && (learningsCount ?? 0) > 0 && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground text-xs"
            title={`${learningsCount} learning${learningsCount === 1 ? "" : "s"} captured from this conversation`}
          >
            <Brain className="h-3.5 w-3.5" />
            {learningsCount}
          </span>
        )}
      </h3>
      {debate.debateMode && (
        <p className="mt-1 text-muted-foreground text-xs">
          Debating: {debate.debateFinding}
        </p>
      )}
      {selectedFinding && (
        <div className="mt-1 flex items-center gap-2">
          <PriorityBadge
            priority={
              selectedFinding.priority ||
              severityToPriority(selectedFinding.severity)
            }
          />
          {selectedFinding.file && (
            <code className="font-mono text-muted-foreground text-xs">
              {selectedFinding.file}
              {selectedFinding.line ? `:${selectedFinding.line}` : ""}
            </code>
          )}
        </div>
      )}
    </div>
  );
}

type ChatMessageListProps = {
  chatMessages: ChatMessage[];
  isAnyStreaming: boolean;
  debate: ReturnType<typeof useCodexDebate>;
  onAction: (action: SuggestedAction) => void;
  contextPercent: number | null;
};

function ChatMessageList({
  chatMessages,
  isAnyStreaming,
  debate,
  onAction,
  contextPercent,
}: Readonly<ChatMessageListProps>) {
  return (
    <>
      {chatMessages.map((msg, idx) => {
        const isLast = idx === chatMessages.length - 1;
        const isLastAssistant = msg.role === "assistant" && isLast;
        const { actions, contentWithoutActions } =
          msg.role === "assistant"
            ? parseSuggestedActions(msg.content)
            : {
                actions: [] as SuggestedAction[],
                contentWithoutActions: msg.content,
              };

        const effectiveSender = debate.getEffectiveSender(msg);
        const debateActions = debate.getDebateActions(
          msg,
          isLast,
          isAnyStreaming
        );
        const normalActions = isLastAssistant && !isAnyStreaming ? actions : [];
        const effectiveActions =
          debateActions.length > 0 ? debateActions : normalActions;

        return (
          <ChatBubble
            actions={effectiveActions}
            contextPercent={isLastAssistant ? contextPercent : undefined}
            index={idx}
            key={msg.id}
            messageRole={effectiveSender === "codex" ? "user" : msg.role}
            onAction={onAction}
            onCopy={async () => {
              try {
                await navigator.clipboard.writeText(contentWithoutActions);
                toast.success("Copied to clipboard");
              } catch {
                toast.error("Failed to copy");
              }
            }}
            sender={effectiveSender}
            timestamp={msg.timestamp}
          >
            <MessageContent
              blocks={msg.blocks}
              content={contentWithoutActions}
            />
          </ChatBubble>
        );
      })}
    </>
  );
}

type StreamingBubblesProps = {
  activeStream: ReturnType<typeof useChatStream>;
  debate: ReturnType<typeof useCodexDebate>;
  selectedFindingIndex: number | null;
  activeStreamStartedAt: string;
  codexStreamStartedAt: string;
};

function StreamingBubbles({
  activeStream,
  debate,
  selectedFindingIndex,
  activeStreamStartedAt,
  codexStreamStartedAt,
}: Readonly<StreamingBubblesProps>) {
  return (
    <>
      {activeStream.isStreaming &&
        (activeStream.streamingContent ||
          activeStream.streamingBlocks.length > 0) && (
          <ChatBubble
            isStreaming
            messageRole="assistant"
            sender={
              debate.debateMode && selectedFindingIndex === null
                ? "claude"
                : undefined
            }
            timestamp={activeStreamStartedAt}
          >
            <MessageContent
              blocks={activeStream.streamingBlocks}
              content={activeStream.streamingContent}
              isStreaming
            />
          </ChatBubble>
        )}
      {debate.codexStream.pendingUserMessage && (
        <ChatBubble
          isStreaming
          messageRole="assistant"
          sender="codex"
          timestamp={codexStreamStartedAt}
        >
          <MessageContent
            blocks={debate.codexStream.pendingUserMessage.blocks}
            content={debate.codexStream.pendingUserMessage.content}
            isStreaming
          />
        </ChatBubble>
      )}
    </>
  );
}

type ChatFooterProps = {
  messageCount: number;
  hasHistory: boolean;
  onClear: () => Promise<void>;
};

function ChatFooter({
  messageCount,
  hasHistory,
  onClear,
}: Readonly<ChatFooterProps>) {
  return (
    <div className="flex items-center justify-between px-5 pb-3">
      <span className="font-mono text-[10px] text-muted-foreground">
        Shift+Enter for new line
      </span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {messageCount} message{messageCount === 1 ? "" : "s"}
        </span>
        {hasHistory && (
          <button
            className="cursor-pointer font-mono text-[10px] text-muted-foreground/50 transition-colors hover:text-destructive"
            onClick={onClear}
            title="Clear chat"
            type="button"
          >
            clear
          </button>
        )}
      </div>
    </div>
  );
}
