import type { ChatSession } from "@repo/database";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { chatSessionsService } from "./service";
import {
  appendMessagesValidator,
  createChatSessionValidator,
} from "./validators";

type ChatResponse = { chat: ChatSession | null };
type DeleteResponse = { deleted: boolean };

export const GET = withAnyAuth<ChatResponse, "/chat-sessions">(
  async ({ user }, request) => {
    try {
      const chatKey = request.nextUrl.searchParams.get("chatKey");
      if (!chatKey) {
        return badRequestResponse("chatKey query parameter is required");
      }

      const chat = await chatSessionsService.findByKey(user.id, chatKey);

      if (!chat || chat.userId !== user.id) {
        return successResponse<ChatResponse>({ chat: null });
      }

      return successResponse<ChatResponse>({ chat });
    } catch (error) {
      return errorResponse("Failed to fetch chat session", error);
    }
  }
);

export const POST = withAnyAuth<ChatResponse, "/chat-sessions">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createChatSessionValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await chatSessionsService.create({
        userId: user.id,
        organizationId: user.organizationId,
        chatKey: body.chatKey,
        provider: body.provider,
        model: body.model,
        context: body.context,
        messages: body.messages,
      });

      if ("conflict" in result) {
        return conflictResponse(
          `Chat is bound to provider ${result.boundProvider}; start a new chat to change providers`
        );
      }

      return successResponse<ChatResponse>({ chat: result.chat });
    } catch (error) {
      return errorResponse("Failed to create chat session", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const PATCH = withAnyAuth<ChatResponse, "/chat-sessions">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        appendMessagesValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await chatSessionsService.appendMessages(
        user.id,
        body.chatKey,
        body.provider,
        body.messages,
        body.sessionId
      );

      if ("notFound" in result) {
        return notFoundResponse("Chat");
      }
      if ("conflict" in result) {
        return conflictResponse(
          `Chat is bound to provider ${result.boundProvider}; start a new chat to change providers`
        );
      }

      return successResponse<ChatResponse>({ chat: result.chat });
    } catch (error) {
      return errorResponse("Failed to append messages to chat session", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<DeleteResponse, "/chat-sessions">(
  async ({ user }, request) => {
    try {
      const chatKey = request.nextUrl.searchParams.get("chatKey");
      if (!chatKey) {
        return badRequestResponse("chatKey query parameter is required");
      }

      const deleted = await chatSessionsService.deleteChat(user.id, chatKey);

      return successResponse<DeleteResponse>({ deleted });
    } catch (error) {
      return errorResponse("Failed to delete chat session", error);
    }
  },
  { requiredScopes: ["delete"] }
);
