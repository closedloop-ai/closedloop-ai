"use client";

import { GitPullRequestArrow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationMessage } from "@/components/artifact-editor/conversation-message";
import {
  type ConversationMessageItem,
  ConversationTranscript,
} from "@/components/artifact-editor/conversation-transcript";
import { PromptInput } from "@/components/artifact-editor/prompt-input";

const STORAGE_KEY = "artifact-chat-panel-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 320;

function getStoredWidth(): number {
  if (globalThis.window === undefined) {
    return DEFAULT_WIDTH;
  }
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const n = Number.parseInt(stored, 10);
      if (Number.isFinite(n)) {
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

function setStoredWidth(w: number) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(w));
  } catch {
    // ignore
  }
}

const MOCK_ARTIFACT_LABELS: Record<string, string> = {
  branch: "this branch",
  issue: "this issue",
  plan: "this plan",
  prd: "this PRD",
};

function getMockWelcomeMessage(artifactType: string): string {
  const label = MOCK_ARTIFACT_LABELS[artifactType] ?? "this";
  return `Ask me anything about ${label}. Chat isn’t connected yet—your messages will appear here.`;
}

type ArtifactChatPanelProps = {
  artifactType: string;
  artifactId: string;
  /**
   * When set (e.g. PR comment selected on branch view), shows a context card after the
   * welcome message (design: secondary card, PR label, summary, muted body block).
   */
  contextSelection?: ArtifactChatContextSelection;
};

function PrCommentContextCard({
  context,
}: Readonly<{ context: ArtifactChatPrCommentContext }>) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <GitPullRequestArrow aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold text-[11px]">PR Comment Context</span>
      </div>
      {context.filePath ? (
        <div className="rounded-md bg-muted px-2 py-2 font-mono text-[11px] text-foreground leading-snug">
          {context.filePath}
          {context.line != null ? `:${context.line}` : ""}
        </div>
      ) : null}
      <div className="rounded-md bg-muted p-2 text-foreground text-xs leading-relaxed">
        {context.body}
      </div>
    </div>
  );
}

/** Mock chat gutter: transcript + prompt; optional PR comment context card. */
export function ArtifactChatPanel({
  artifactId: _artifactId,
  artifactType,
  contextSelection = null,
}: Readonly<ArtifactChatPanelProps>) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<ConversationMessageItem[]>(() => [
    {
      id: "welcome",
      role: "assistant",
      content: getMockWelcomeMessage(artifactType),
    },
  ]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    setWidth(getStoredWidth());
  }, []);

  // Scroll to bottom when messages or injected PR context changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages + context id intentional
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, contextSelection?.id]);

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      return;
    }
    const userMsg: ConversationMessageItem = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    const assistantMsg: ConversationMessageItem = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "Chat isn’t connected yet. This is a mock.",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInputValue("");
  }, [inputValue]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) {
          return;
        }
        const delta = dragRef.current.startX - ev.clientX;
        const newWidth = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, dragRef.current.startWidth + delta)
        );
        setWidth(newWidth);
        setStoredWidth(newWidth);
      };

      const onMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width]
  );

  return (
    <div
      className="flex min-h-0 shrink-0 overflow-hidden border-l bg-background"
      style={{ width }}
    >
      <button
        aria-label="Resize chat panel"
        className="w-1 shrink-0 cursor-col-resize border-y-0 border-r-0 border-l bg-transparent p-0 transition-colors hover:bg-primary/30 focus:outline-none active:bg-primary/50"
        onMouseDown={handleResizeStart}
        type="button"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          <ConversationMessage
            content={messages[0].content}
            role={messages[0].role}
          />
          {contextSelection ? (
            <PrCommentContextCard context={contextSelection} />
          ) : null}
          {messages.length > 1 ? (
            <ConversationTranscript
              className="min-h-0"
              messages={messages.slice(1)}
            />
          ) : null}
          <div ref={transcriptEndRef} />
        </div>
        <div className="shrink-0 border-t p-3">
          <PromptInput
            onChange={setInputValue}
            onSubmit={handleSubmit}
            placeholder="Ask anything"
            value={inputValue}
          />
        </div>
      </div>
    </div>
  );
}

/** PR comment context card payload for the branch-view chat gutter (stub). */
export type ArtifactChatPrCommentContext = {
  id: string;
  filePath?: string;
  line?: number;
  body: string;
};

export type ArtifactChatContextSelection = ArtifactChatPrCommentContext | null;
