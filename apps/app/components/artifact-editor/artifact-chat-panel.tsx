"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConversationMessageItem,
  ConversationTranscript,
} from "@/components/artifact-editor/conversation-transcript";
import { PromptInput } from "@/components/artifact-editor/prompt-input";

function getMockWelcomeMessage(artifactType: string): string {
  let label = "this";
  if (artifactType === "issue") {
    label = "this issue";
  } else if (artifactType === "prd") {
    label = "this PRD";
  } else if (artifactType === "plan") {
    label = "this plan";
  }
  return `Ask me anything about ${label}. Chat isn't connected yet—your messages will appear here.`;
}

type ArtifactChatPanelProps = {
  artifactType: string;
  artifactId: string;
};

/**
 * Chat panel for the right gutter. Uses conversation primitives and a
 * typeable prompt input; not connected to an LLM yet.
 */
export function ArtifactChatPanel({
  artifactId: _artifactId,
  artifactType,
}: Readonly<ArtifactChatPanelProps>) {
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<ConversationMessageItem[]>(() => [
    {
      id: "welcome",
      role: "assistant",
      content: getMockWelcomeMessage(artifactType),
    },
  ]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

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
      content: "Chat isn't connected yet. This is a mock.",
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInputValue("");
  }, [inputValue]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <ConversationTranscript className="min-h-0" messages={messages} />
        <div ref={transcriptEndRef} />
      </div>
      <div className="shrink-0 p-3">
        <PromptInput
          onChange={setInputValue}
          onSubmit={handleSubmit}
          placeholder="Ask anything"
          value={inputValue}
        />
      </div>
    </div>
  );
}
