import {
  agents,
  createAgentUIStreamResponse,
  type UIMessage,
} from "@repo/ai/server";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";

export const POST = async (request: Request): Promise<Response> => {
  try {
    const { isAuthenticated } = await auth();

    if (!isAuthenticated) {
      return new Response("Not authenticated", { status: 401 });
    }

    const { messages }: { messages: UIMessage[] } = await request.json();

    return createAgentUIStreamResponse({
      agent: agents.generatePRD,
      uiMessages: messages,
    });
  } catch (error) {
    const message = parseError(error);
    log.error(message);

    return new Response(
      JSON.stringify({ message: "Something went wrong", ok: false }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
