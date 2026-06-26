"use client";

import {
  ConversationMessage,
  type ConversationMessageRole,
} from "./conversation-message";

export type ConversationMessageItem = {
  id: string;
  role: ConversationMessageRole;
  content: string;
};

export type ConversationTranscriptProps = {
  messages: ConversationMessageItem[];
  className?: string;
};

export function ConversationTranscript({
  messages,
  className,
}: Readonly<ConversationTranscriptProps>) {
  return (
    <div aria-label="Conversation" className={className} role="log">
      <div className="flex flex-col gap-4">
        {messages.map((message) => (
          <ConversationMessage
            content={message.content}
            key={message.id}
            role={message.role}
          />
        ))}
      </div>
    </div>
  );
}
