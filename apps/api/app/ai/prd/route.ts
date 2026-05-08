import {
  agents,
  createAgentUIStreamResponse,
  type UIMessage,
} from "@repo/ai/server";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { scheduleLogFlush, unauthorizedResponse } from "@/lib/route-utils";

// TODO: zod schema for request body
export const POST = async (request: Request): Promise<Response> => {
  try {
    const { isAuthenticated } = await auth();

    if (!isAuthenticated) {
      return unauthorizedResponse();
    }

    const { messages }: { messages: UIMessage[] } = await request.json();

    return createAgentUIStreamResponse({
      agent: agents.generatePRD,
      uiMessages: messages,
    });
  } catch (error) {
    const message = parseError(error);
    log.error(message);
    scheduleLogFlush();
    return new Response(
      JSON.stringify({ message: "Something went wrong", ok: false }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
