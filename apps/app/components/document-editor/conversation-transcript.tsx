"use client";

import { ConversationMessage } from "./conversation-message";

export type ConversationMessageItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type ConversationTranscriptProps = {
  messages: ConversationMessageItem[];
  className?: string;
};

/**
 * Scrollable list of conversation messages. Use with ConversationMessage for layout.
 */
export function ConversationTranscript({
  messages,
  className,
}: Readonly<ConversationTranscriptProps>) {
  return (
    <div aria-label="Conversation" className={className} role="log">
      <div className="flex flex-col gap-4">
        {messages.map((msg) => (
          <ConversationMessage
            content={msg.content}
            key={msg.id}
            role={msg.role}
          />
        ))}
      </div>
    </div>
  );
}
