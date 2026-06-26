import type {
  ConversationContentBlock,
  ConversationEnvelope,
  ConversationMessage,
  JsonValue,
} from "@repo/design-system/components/ui/types";

export function stringifyJsonValue(value: JsonValue) {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function ensureConversationBlocks(
  message: ConversationMessage
): ConversationContentBlock[] {
  if (message.blocks && message.blocks.length > 0) {
    return message.blocks;
  }

  if (message.content.trim().length === 0) {
    return [];
  }

  return [{ type: "text", text: message.content }];
}

export function messagesToEnvelopes(
  messages: ConversationMessage[]
): ConversationEnvelope[] {
  return messages.map((message) => {
    const content = ensureConversationBlocks(message);

    if (message.role === "assistant") {
      return {
        id: message.id,
        type: "assistant",
        author: message.author,
        createdAt: message.createdAt,
        content,
        usage: message.usage
          ? {
              inputTokens: message.usage.inputTokens,
              outputTokens: message.usage.outputTokens,
            }
          : null,
      };
    }

    if (message.role === "user") {
      return {
        id: message.id,
        type: "user",
        author: message.author,
        createdAt: message.createdAt,
        content,
      };
    }

    return {
      id: message.id,
      type: message.role,
      createdAt: message.createdAt,
      data: {
        author: message.author,
        content: message.content,
      },
    };
  });
}
