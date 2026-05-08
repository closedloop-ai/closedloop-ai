import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiOrigin } from "@/lib/api-origin";
import {
  resolveClerkSession,
  resolveRunnerDbUser,
} from "@/lib/chat/runner-token/authenticateChatRunnerUser";
import { createRunnerTokenResponse } from "@/lib/chat/runner-token/createRunnerTokenResponse";

const bodyValidator = z.object({
  chatKey: z.string().min(1, "chatKey is required"),
});

export async function POST(request: NextRequest): Promise<Response> {
  const clerkResult = await resolveClerkSession();
  if (!clerkResult.ok) {
    return clerkResult.error;
  }
  const { getToken } = clerkResult.value;

  let chatKey: string;
  try {
    const parsed = bodyValidator.parse(await request.json());
    chatKey = parsed.chatKey;
  } catch (error) {
    log.error("Invalid runner-token request body", {
      error: parseError(error),
    });
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const apiBaseUrl = resolveApiOrigin(request);
  const dbUserResult = await resolveRunnerDbUser(apiBaseUrl, getToken);
  if (!dbUserResult.ok) {
    return dbUserResult.error;
  }
  const { userId, organizationId } = dbUserResult.value;

  try {
    const payload = await createRunnerTokenResponse({
      userId,
      organizationId,
      chatKey,
      apiBaseUrl,
    });
    return NextResponse.json(payload);
  } catch (error) {
    log.error("Failed to sign chat runner token", {
      error: parseError(error),
    });
    return NextResponse.json(
      { error: "Failed to mint chat runner token" },
      { status: 500 }
    );
  }
}
