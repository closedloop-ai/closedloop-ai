import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import { auth, getAuth, verifyToken } from "@repo/auth/server";
import { ApiKeySource } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import { apiKeysService } from "@/app/api-keys/service";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import type { VerifiedApiKeyContextWithMetadata } from "./api-key-context";
import {
  getDesktopManagedPopRequestFailure,
  resolveDesktopManagedPopMode,
} from "./desktop-managed-pop";

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
export async function resolveAnyAuthContext(
  request: Request,
  options?: { requiredScopes?: ApiKeyScope[] }
): Promise<ResolvedAuthContext | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (token?.startsWith("sk_live_")) {
    return resolveApiKeyTokenContext(token, {
      request,
      requiredScopes: options?.requiredScopes ?? ["read"],
    });
  }

  const requestContext = await resolveClerkRequestContext(request);
  if (requestContext) {
    return requestContext;
  }

  if (token) {
    const bearerContext = await resolveClerkBearerTokenContext(token);
    if (bearerContext) {
      return bearerContext;
    }
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
  options:
    | ApiKeyScope[]
    | {
        request?: Request;
        requiredScopes?: ApiKeyScope[];
      } = {}
): Promise<ResolvedAuthContext | null> {
  const resolvedOptions = Array.isArray(options)
    ? { requiredScopes: options }
    : options;
  const requiredScopes = resolvedOptions.requiredScopes ?? ["read"];
  const keyContext = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
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

  const popAccepted = await isDesktopManagedPopAccepted(
    { ...keyContext, clerkUserId: user.clerkId },
    resolvedOptions.request
  );
  if (!popAccepted) {
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

async function isDesktopManagedPopAccepted(
  keyContext: VerifiedApiKeyContextWithMetadata & {
    clerkUserId?: string | null;
  },
  request: Request | undefined
): Promise<boolean> {
  if (
    keyContext.source !== ApiKeySource.DESKTOP_MANAGED ||
    !(keyContext.boundPublicKey && keyContext.gatewayId)
  ) {
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  if (request) {
    const popFailure = await getDesktopManagedPopRequestFailure({
      keyContext,
      request,
    });
    if (popFailure) {
      return false;
    }
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  const mode = await resolveDesktopManagedPopMode(keyContext);
  if (mode !== "enforce") {
    waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));
    return true;
  }

  return false;
}

function resolveClerkRequestContext(
  request: Request
): Promise<ResolvedAuthContext | null> {
  try {
    const requestAuth = getAuth(request as Parameters<typeof getAuth>[0], {
      acceptsToken: "any",
    });
    if (!(requestAuth.userId && requestAuth.orgId)) {
      return Promise.resolve(null);
    }

    return resolveClerkIdentityContext(requestAuth.userId, requestAuth.orgId);
  } catch {
    return Promise.resolve(null);
  }
}

async function resolveClerkBearerTokenContext(
  token: string
): Promise<ResolvedAuthContext | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return null;
  }

  try {
    const claims = await verifyToken(token, { secretKey });
    const clerkUserId = typeof claims.sub === "string" ? claims.sub : null;
    const clerkOrgId = typeof claims.org_id === "string" ? claims.org_id : null;

    if (!(clerkUserId && clerkOrgId)) {
      return null;
    }
    return resolveClerkIdentityContext(clerkUserId, clerkOrgId);
  } catch {
    return null;
  }
}

async function resolveClerkContext(): Promise<ResolvedAuthContext | null> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!(clerkUserId && clerkOrgId)) {
    return null;
  }

  return resolveClerkIdentityContext(clerkUserId, clerkOrgId);
}

async function resolveClerkIdentityContext(
  clerkUserId: string,
  clerkOrgId: string
): Promise<ResolvedAuthContext | null> {
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
