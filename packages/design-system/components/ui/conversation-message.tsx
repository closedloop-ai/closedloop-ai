"use client";

import { cn } from "@closedloop-ai/design-system/lib/utils";
import { BotIcon, UserIcon } from "lucide-react";

export type ConversationMessageRole = "user" | "assistant";

export type ConversationMessageProps = {
  role: ConversationMessageRole;
  content: string;
  className?: string;
};

export function ConversationMessage({
  role,
  content,
  className,
}: Readonly<ConversationMessageProps>) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "flex gap-2",
        isUser ? "flex-row-reverse" : "flex-row",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground",
          isUser ? "bg-primary/10 text-primary" : "bg-muted"
        )}
      >
        {isUser ? (
          <UserIcon className="size-3.5" />
        ) : (
          <BotIcon className="size-3.5" />
        )}
      </span>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>
    </div>
  );
}
