import { failure } from "@repo/api/src/types/common";
import { type NextRequest, NextResponse } from "next/server";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { authenticateChatRunnerRequest } from "../chat-runner-auth";
import { chatSessionsService } from "../service";
import { turnValidator } from "../validators";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const auth = await authenticateChatRunnerRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const { claims } = auth;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      turnValidator
    );
    if (parseError) {
      return parseError;
    }

    if (claims.chatKey !== body.chatKey) {
      return NextResponse.json(failure("Token does not match chat"), {
        status: 403,
      });
    }

    const result = await chatSessionsService.upsertTurn(
      claims.userId,
      claims.organizationId,
      body
    );

    if (result.conflict) {
      return NextResponse.json(
        {
          success: false,
          error: `Chat is bound to provider ${result.boundProvider}`,
          boundProvider: result.boundProvider,
        },
        { status: 409 }
      );
    }

    return successResponse({
      chat: result.chat,
      resumeSessionId: result.resumeSessionId,
    });
  } catch (error) {
    return errorResponse("Failed to record chat turn", error);
  }
}
