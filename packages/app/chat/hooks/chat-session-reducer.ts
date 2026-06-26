import type { ChatMessage } from "@repo/app/chat/lib/types";

export type ChatSessionState = {
  inputValue: string;
  localError: string | null;
  pendingUserMessage: ChatMessage | null;
};

export const initialChatSessionState: ChatSessionState = {
  inputValue: "",
  localError: null,
  pendingUserMessage: null,
};

export type ChatSessionAction =
  | { type: "input/set"; value: string }
  | { type: "error/set"; message: string | null }
  | { type: "pending/set"; message: ChatMessage | null }
  | { type: "pending/clear" }
  | { type: "send/start"; message: ChatMessage }
  | { type: "upsertFailure/restoreDraft"; draft: string; message: string };

export function chatSessionReducer(
  state: ChatSessionState,
  action: ChatSessionAction
): ChatSessionState {
  switch (action.type) {
    case "input/set":
      return { ...state, inputValue: action.value };
    case "error/set":
      return { ...state, localError: action.message };
    case "pending/set":
      return { ...state, pendingUserMessage: action.message };
    case "pending/clear":
      return state.pendingUserMessage === null
        ? state
        : { ...state, pendingUserMessage: null };
    case "send/start":
      return {
        ...state,
        inputValue: "",
        pendingUserMessage: action.message,
      };
    case "upsertFailure/restoreDraft":
      return {
        ...state,
        inputValue: action.draft,
        pendingUserMessage: null,
        localError: action.message,
      };
    default:
      return state;
  }
}
