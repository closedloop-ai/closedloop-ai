import { failure } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import {
  authenticateChatRunner,
  type ChatRunnerClaims,
} from "@repo/auth/chat-runner-jwt";
import { NextResponse } from "next/server";

export type ChatRunnerAuthResult = Result<ChatRunnerClaims, Response>;

/**
 * Authenticate a chat-runner request at the top of a route handler.
 * Returns a `Result` so callers avoid duplicating try/catch + early-return.
 * On failure, the error carries a ready-to-return 401 `Response`.
 */
export async function authenticateChatRunnerRequest(
  request: Request
): Promise<ChatRunnerAuthResult> {
  try {
    const claims = await authenticateChatRunner(request);
    if (claims) {
      return Result.ok<ChatRunnerClaims, Response>(claims);
    }
    return Result.err<ChatRunnerClaims, Response>(
      NextResponse.json(failure("Missing chat runner token"), { status: 401 })
    );
  } catch {
    return Result.err<ChatRunnerClaims, Response>(
      NextResponse.json(failure("Invalid chat runner token"), { status: 401 })
    );
  }
}
