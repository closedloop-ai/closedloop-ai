"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  if (typeof globalThis.localStorage === "undefined") {
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

function getMockWelcomeMessage(artifactType: string): string {
  let label = "this";
  if (artifactType === "issue") {
    label = "this issue";
  } else if (artifactType === "prd") {
    label = "this PRD";
  } else if (artifactType === "plan") {
    label = "this plan";
  }
  return `Ask me anything about ${label}. Chat isn’t connected yet—your messages will appear here.`;
}

type ArtifactChatPanelProps = {
  artifactType: string;
  artifactId: string;
};

/**
 * Mocked chat panel for the right gutter. Uses conversation primitives and a
 * typeable prompt input; not connected to an LLM yet.
 */
export function ArtifactChatPanel({
  artifactId: _artifactId,
  artifactType,
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

  // Scroll to bottom when new messages are added
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is intentional
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          <ConversationTranscript className="min-h-0" messages={messages} />
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
