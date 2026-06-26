import type { ChatMessage, ContentBlock } from "@repo/app/chat/lib/types";

export type ChatStreamState = {
  streamingContent: string;
  streamingBlocks: ContentBlock[];
  isStreaming: boolean;
  error: string | null;
  pendingUserMessage: ChatMessage | null;
  streamStartedAt: string;
  contextPercent: number | null;
};

export const initialChatStreamState: ChatStreamState = {
  streamingContent: "",
  streamingBlocks: [],
  isStreaming: false,
  error: null,
  pendingUserMessage: null,
  streamStartedAt: "",
  contextPercent: null,
};

export type ChatStreamAction =
  | { type: "send/start"; startedAt: string }
  | { type: "send/finish" }
  | { type: "text/update"; content: string }
  | {
      type: "block/addToolUse";
      tool: { id: string; name: string; input: unknown };
    }
  | {
      type: "block/updateToolResult";
      result: { id: string; content: string; is_error: boolean };
    }
  | { type: "block/addThinking"; id: string; content: string }
  | { type: "error/set"; message: string }
  | { type: "error/clear" }
  | { type: "usage/set"; percent: number }
  | { type: "pendingMessage/set"; message: ChatMessage | null; now: string };

export function chatStreamReducer(
  state: ChatStreamState,
  action: ChatStreamAction
): ChatStreamState {
  switch (action.type) {
    case "send/start":
      return {
        ...state,
        streamingContent: "",
        streamingBlocks: [],
        isStreaming: true,
        error: null,
        streamStartedAt: action.startedAt,
      };
    case "send/finish":
      return {
        ...state,
        isStreaming: false,
        streamingContent: "",
        streamingBlocks: [],
        pendingUserMessage: null,
        streamStartedAt: "",
      };
    case "text/update":
      return { ...state, streamingContent: action.content };
    case "block/addToolUse":
      return {
        ...state,
        streamingBlocks: [
          ...state.streamingBlocks,
          {
            type: "tool_use",
            id: action.tool.id,
            name: action.tool.name,
            input: action.tool.input,
          },
        ],
      };
    case "block/updateToolResult":
      return {
        ...state,
        streamingBlocks: state.streamingBlocks.map((block) =>
          block.id === action.result.id
            ? {
                ...block,
                type: "tool_result",
                content: action.result.content,
                is_error: action.result.is_error,
              }
            : block
        ),
      };
    case "block/addThinking":
      return {
        ...state,
        streamingBlocks: [
          ...state.streamingBlocks,
          { type: "thinking", id: action.id, thinking: action.content },
        ],
      };
    case "error/set":
      return { ...state, error: action.message };
    case "error/clear":
      return { ...state, error: null };
    case "usage/set":
      return { ...state, contextPercent: action.percent };
    case "pendingMessage/set": {
      const next = action.message;
      const wasNull = state.pendingUserMessage === null;
      const becomingNonNull = next !== null && wasNull;
      return {
        ...state,
        pendingUserMessage: next,
        streamStartedAt:
          becomingNonNull && !state.streamStartedAt
            ? action.now
            : state.streamStartedAt,
      };
    }
    default:
      return state;
  }
}
