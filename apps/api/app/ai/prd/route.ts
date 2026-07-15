import {
  agents,
  createAgentUIStreamResponse,
  PRD_AGENT_REQUEST_TIMEOUT_MS,
  safeValidateUIMessages,
} from "@repo/ai/server";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { z } from "zod";
import {
  badRequestResponse,
  parseBody,
  scheduleLogFlush,
  unauthorizedResponse,
} from "@/lib/route-utils";

/**
 * Platform function time budget (seconds). Set explicitly rather than relying on
 * Vercel's invisible 300s default so the ceiling is intentional and stays above
 * `PRD_AGENT_REQUEST_TIMEOUT_MS`: the SDK timeout must fire first and emit a
 * controlled stream error before the platform hard-kills the function.
 */
export const maxDuration = 300;

/** Max UTF-8 size of the request body, to bound memory before parsing. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
/** Max number of messages forwarded to the agent in a single request. */
const MAX_MESSAGES = 100;

/**
 * Coarse shape + size bounds for the request body. The individual message
 * shape is validated separately with `safeValidateUIMessages` so the parsed
 * values are typed as `UIMessage[]` without an unsafe cast.
 */
const requestBodySchema = z.object({
  messages: z.array(z.unknown()).max(MAX_MESSAGES),
});

export const POST = async (request: Request): Promise<Response> => {
  try {
    const { isAuthenticated } = await auth();

    if (!isAuthenticated) {
      return unauthorizedResponse();
    }

    const parsed = await parseBody(request, requestBodySchema, {
      maxBytes: MAX_BODY_BYTES,
    });
    if (parsed.errorResponse) {
      return parsed.errorResponse;
    }

    const validated = await safeValidateUIMessages({
      messages: parsed.body.messages,
    });
    if (!validated.success) {
      return badRequestResponse("Invalid messages payload");
    }

    return createAgentUIStreamResponse({
      agent: agents.generatePRD,
      uiMessages: validated.data,
      // Bound each request's wall-clock time so a runaway tool loop cannot hang
      // the connection indefinitely (complements the agent's stepCount guard).
      timeout: { totalMs: PRD_AGENT_REQUEST_TIMEOUT_MS },
      // Errors thrown while the agent runs — an Anthropic API failure, the
      // PRD_AGENT_REQUEST_TIMEOUT_MS abort, or a tool failure — happen after
      // this Response is returned, so the try/catch above can never see them.
      // Without an onError they are invisible in server telemetry and the
      // client only gets the SDK's generic default. Log them through the same
      // path as the catch block (parseError + log.error + flush) and return a
      // controlled, non-leaking message to include in the data stream.
      onError: (error) => {
        const message = parseError(error);
        log.error(message);
        scheduleLogFlush();
        return "Something went wrong while generating the PRD.";
      },
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
