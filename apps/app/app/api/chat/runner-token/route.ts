import type { ApiResult } from "@repo/api/src/types/common";
import type { User } from "@repo/api/src/types/user";
import {
  DEFAULT_TTL_SECONDS,
  issueChatRunnerToken,
} from "@repo/auth/chat-runner-jwt";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveApiOrigin } from "@/lib/api-origin";

const bodyValidator = z.object({
  chatKey: z.string().min(1, "chatKey is required"),
});

type MintResponse = {
  token: string;
  apiBaseUrl: string;
  expiresAt: string;
};

type GetToken = () => Promise<string | null>;

export async function POST(request: NextRequest): Promise<Response> {
  let clerkUserId: string | null = null;
  let getToken: GetToken;
  try {
    const session = await auth();
    clerkUserId = session.userId;
    getToken = session.getToken;
  } catch (error) {
    log.error("Failed to read Clerk session for runner-token mint", {
      error: parseError(error),
    });
    return NextResponse.json(
      { error: "Failed to mint chat runner token" },
      { status: 500 }
    );
  }

  if (!clerkUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const dbUser = await fetchDbUser(apiBaseUrl, getToken);
  if (!dbUser) {
    return NextResponse.json(
      { error: "Failed to resolve authenticated user" },
      { status: 500 }
    );
  }

  let token: string;
  try {
    token = await issueChatRunnerToken({
      userId: dbUser.id,
      organizationId: dbUser.organizationId,
      chatKey,
    });
  } catch (error) {
    log.error("Failed to sign chat runner token", {
      error: parseError(error),
    });
    return NextResponse.json(
      { error: "Failed to mint chat runner token" },
      { status: 500 }
    );
  }

  const expiresAt = new Date(
    Date.now() + DEFAULT_TTL_SECONDS * 1000
  ).toISOString();

  const payload: MintResponse = { token, apiBaseUrl, expiresAt };
  return NextResponse.json(payload);
}

/**
 * Resolves the authenticated Clerk session to internal DB UUIDs via the
 * `apps/api` `/me` endpoint. That endpoint flows through `withAuth`, which
 * performs find-or-create on the users/organizations rows, so a first-time
 * user who has a Clerk account but no DB row yet is onboarded transparently.
 *
 * Returns null on any failure; the caller is expected to surface 500 and
 * must NOT fall back to lookup-only resolution.
 */
async function fetchDbUser(
  apiBaseUrl: string,
  getToken: GetToken
): Promise<User | null> {
  let clerkToken: string | null;
  try {
    clerkToken = await getToken();
  } catch (error) {
    log.error("Failed to read Clerk session token", {
      error: parseError(error),
    });
    return null;
  }

  if (!clerkToken) {
    log.error("Clerk session token missing when minting runner token");
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/me`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${clerkToken}`,
      },
    });
  } catch (error) {
    log.error("Network error calling /me for runner-token mint", {
      error: parseError(error),
    });
    return null;
  }

  if (!response.ok) {
    log.error("/me returned non-OK status for runner-token mint", {
      status: response.status,
    });
    return null;
  }

  let envelope: ApiResult<User>;
  try {
    envelope = (await response.json()) as ApiResult<User>;
  } catch (error) {
    log.error("/me returned non-JSON body for runner-token mint", {
      error: parseError(error),
    });
    return null;
  }

  if (!envelope.success) {
    log.error("/me returned error envelope for runner-token mint", {
      error: envelope.error,
    });
    return null;
  }

  return envelope.data;
}
