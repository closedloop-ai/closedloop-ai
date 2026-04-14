import { failure } from "@repo/api/src/types/common";
import {
  authenticateChatRunner,
  type ChatRunnerClaims,
} from "@repo/auth/chat-runner-jwt";
import { NextResponse } from "next/server";

export type ChatRunnerAuthResult =
  | { ok: true; claims: ChatRunnerClaims }
  | { ok: false; response: Response };

/**
 * Authenticate a chat-runner request at the top of a route handler. Mirrors
 * `authenticateLoopRunner` in `apps/api/lib/auth/loop-runner-jwt.ts`: returns
 * a result object so callers avoid duplicating try/catch + early-return.
 */
export async function authenticateChatRunnerRequest(
  request: Request
): Promise<ChatRunnerAuthResult> {
  try {
    const claims = await authenticateChatRunner(request);
    if (claims) {
      return { ok: true, claims };
    }
    return {
      ok: false,
      response: NextResponse.json(failure("Missing chat runner token"), {
        status: 401,
      }),
    };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(failure("Invalid chat runner token"), {
        status: 401,
      }),
    };
  }
}
