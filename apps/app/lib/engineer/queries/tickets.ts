import { queryOptions } from "@tanstack/react-query";
import type { ContentBlock } from "@/components/engineer/chat";
import { queryKeys } from "./keys";

export type TicketChatHistory = {
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
    blocks?: ContentBlock[];
  }>;
  ticketId: string;
  sessionId?: string;
};

export function ticketChatHistoryOptions(ticketId: string) {
  return queryOptions<TicketChatHistory>({
    queryKey: queryKeys.ticketChatHistory(ticketId),
    queryFn: async () => {
      const response = await fetch(
        `/api/gateway/ticket-chat?ticketId=${encodeURIComponent(ticketId)}`
      );
      if (!response.ok) {
        return { messages: [], ticketId };
      }
      return response.json();
    },
  });
}
