import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { auth } from "@repo/auth/server";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";

type ResolvedAuthContext = {
  organizationId: string;
  userId: string;
};

/**
 * Resolves user identity from either an API key (`sk_live_*`) or a Clerk
 * session, returning a lightweight context suitable for SSE and streaming
 * endpoints that cannot use `withAnyAuth` (which requires NextResponse<ApiResult>).
 *
 * Returns `null` when authentication fails for any reason.
 */
export function resolveAnyAuthContext(
  request: Request,
  options?: { requiredScopes?: ApiKeyScope[] }
): Promise<ResolvedAuthContext | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token?.startsWith("sk_live_")) {
    return resolveApiKeyTokenContext(
      token,
      options?.requiredScopes ?? ["read"]
    );
  }

  return resolveClerkContext();
}

/**
 * Verifies an API key token and returns a lightweight auth context.
 * Exported for non-standard auth paths (Socket.IO, SSE) that extract
 * tokens outside the normal Request flow.
 */
export async function resolveApiKeyTokenContext(
  token: string,
  requiredScopes: ApiKeyScope[] = ["read"]
): Promise<ResolvedAuthContext | null> {
  const keyContext = await apiKeysService.verifyKey(token);
  if (!keyContext) {
    return null;
  }

  if (!requiredScopes.every((scope) => keyContext.scopes.includes(scope))) {
    return null;
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return null;
  }

  const organization = await organizationsService.findById(
    keyContext.organizationId
  );
  if (!organization) {
    return null;
  }

  return {
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
  };
}

async function resolveClerkContext(): Promise<ResolvedAuthContext | null> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!(clerkUserId && clerkOrgId)) {
    return null;
  }

  const organization = await organizationsService.findByClerkId(clerkOrgId);
  if (!organization) {
    return null;
  }

  const user = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );
  if (!user?.active) {
    return null;
  }

  return {
    organizationId: organization.id,
    userId: user.id,
  };
}
