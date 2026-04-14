import { failure } from "@repo/api/src/types/common";
import { type NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { authenticateChatRunnerRequest } from "../../chat-runner-auth";
import { genericChatsService } from "../../service";
import { completeTurnValidator } from "../../validators";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await authenticateChatRunnerRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const { claims } = auth;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      completeTurnValidator
    );
    if (parseError) {
      return parseError;
    }

    if (claims.chatKey !== body.chatKey) {
      return NextResponse.json(failure("Token does not match chat"), {
        status: 403,
      });
    }

    const result = await genericChatsService.appendAssistantTurn(
      claims.userId,
      body
    );

    if ("chat" in result) {
      return successResponse({ chat: result.chat });
    }
    if ("notFound" in result) {
      return notFoundResponse("Chat");
    }
    return NextResponse.json(
      {
        success: false,
        error: `Chat is bound to provider ${result.boundProvider}`,
        boundProvider: result.boundProvider,
      },
      { status: 409 }
    );
  } catch (error) {
    return errorResponse("Failed to complete chat turn", error);
  }
}
