import {
  DEFAULT_TTL_SECONDS,
  issueChatRunnerToken,
} from "@repo/auth/chat-runner-jwt";

export type ChatRunnerTokenPayload = {
  token: string;
  apiBaseUrl: string;
  expiresAt: Date;
};

/**
 * Mint a chat runner token and build the internal response payload.
 * `expiresAt` is a typed `Date` — callers that serialize via
 * `NextResponse.json` get a proper ISO-8601 string on the wire because
 * `Date.prototype.toJSON` returns an ISO string, so callers never have to
 * reach for `.toISOString()` themselves.
 */
export async function createRunnerTokenResponse(opts: {
  userId: string;
  organizationId: string;
  chatKey: string;
  apiBaseUrl: string;
}): Promise<ChatRunnerTokenPayload> {
  const token = await issueChatRunnerToken({
    userId: opts.userId,
    organizationId: opts.organizationId,
    chatKey: opts.chatKey,
  });
  const expiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
  return { token, apiBaseUrl: opts.apiBaseUrl, expiresAt };
}
