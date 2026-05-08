import type { ApiResult } from "@repo/api/src/types/common";
import { Result } from "@repo/api/src/types/result";
import type { User } from "@repo/api/src/types/user";
import { auth } from "@repo/auth/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";

type GetToken = () => Promise<string | null>;

export type ClerkSession = {
  clerkUserId: string;
  getToken: GetToken;
};

/**
 * Read the Clerk session for a runner-token request. Returns a
 * `Result<ClerkSession, Response>`: 401 when the session is missing, 500
 * when Clerk itself fails. The returned `getToken` is a pass-through to
 * the Clerk session helper and must be invoked later (once the body has
 * been validated) to mint a bearer for the `/me` exchange.
 */
export async function resolveClerkSession(): Promise<
  Result<ClerkSession, Response>
> {
  try {
    const session = await auth();
    if (!session.userId) {
      return Result.err(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      );
    }
    return Result.ok({
      clerkUserId: session.userId,
      getToken: session.getToken,
    });
  } catch (error) {
    log.error("Failed to read Clerk session for runner-token mint", {
      error: parseError(error),
    });
    return Result.err(
      NextResponse.json(
        { error: "Failed to mint chat runner token" },
        { status: 500 }
      )
    );
  }
}

export type ResolvedRunnerUser = {
  userId: string;
  organizationId: string;
};

/**
 * Exchange a Clerk session token for the internal DB user via the
 * `apps/api` `/me` endpoint. That endpoint flows through `withAuth`, which
 * performs find-or-create on the users/organizations rows, so a first-time
 * user who has a Clerk account but no DB row yet is onboarded transparently.
 *
 * Returns a `Result<ResolvedRunnerUser, Response>` where failure carries a
 * ready-to-return 500. The caller must NOT fall back to lookup-only
 * resolution, which is why every error path funnels into the same 500
 * response with no retry.
 */
export async function resolveRunnerDbUser(
  apiBaseUrl: string,
  getToken: GetToken
): Promise<Result<ResolvedRunnerUser, Response>> {
  const dbUser = await fetchDbUser(apiBaseUrl, getToken);
  if (!dbUser) {
    return Result.err(
      NextResponse.json(
        { error: "Failed to resolve authenticated user" },
        { status: 500 }
      )
    );
  }
  return Result.ok({
    userId: dbUser.id,
    organizationId: dbUser.organizationId,
  });
}

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
