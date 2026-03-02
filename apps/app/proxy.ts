import { authMiddleware } from "@repo/auth/proxy";
import {
  noseconeOptions,
  noseconeOptionsWithToolbar,
  securityMiddleware,
} from "@repo/security/proxy";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { env } from "./env";
import { resolveApiOrigin } from "./lib/api-origin";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const COMPUTE_TARGET_CACHE_TTL_MS = 30_000;

type ProxyAuth = () => Promise<{
  userId: string | null;
  orgId: string | null;
  getToken: () => Promise<string | null>;
}>;

type CacheEntry = {
  value: boolean;
  expiresAt: number;
};

const computeTargetGuardCache = new Map<string, CacheEntry>();

function isEngineerLocalPath(pathname: string): boolean {
  return pathname.startsWith("/api/engineer/");
}

function isEngineerRelayPath(pathname: string): boolean {
  return pathname.startsWith("/api/engineer-relay/");
}

function buildCacheKey(userId: string, orgId: string | null): string {
  return `${orgId ?? "none"}:${userId}`;
}

async function fetchHasComputeTarget(
  request: NextRequest,
  token: string
): Promise<boolean> {
  const response = await fetch(`${resolveApiOrigin(request)}/compute-targets`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json().catch(() => null)) as {
    success: true;
    data: unknown;
  } | null;

  return Boolean(
    payload?.success && Array.isArray(payload.data) && payload.data.length > 0
  );
}

/**
 * Guards engineer API routes to localhost or authenticated users with
 * registered compute targets (cached for 30s).
 *
 * Engineer API routes spawn local CLI processes (Claude, git, codex) and
 * read/write the local filesystem. They must never be accessible in deployed
 * environments — EngineerGuard only blocks the UI, not the HTTP layer.
 *
 * See CLAUDE.md "Engineer Feature — Architectural Exception" for full context.
 */
async function engineerGuard(
  auth: ProxyAuth,
  request: NextRequest
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;
  const isLocal = isEngineerLocalPath(pathname);
  const isRelay = isEngineerRelayPath(pathname);

  if (!(isLocal || isRelay)) {
    return null;
  }

  const hostname = request.headers.get("host")?.split(":")[0] ?? "";
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return null;
  }

  // /api/engineer/* routes spawn local CLI processes — always localhost-only.
  if (isLocal) {
    return NextResponse.json(
      { error: "Engineer API is only available on localhost" },
      { status: 403 }
    );
  }

  // /api/engineer-relay/* routes are cloud-safe but require a compute target.
  const authState = await auth();
  if (!authState.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cacheKey = buildCacheKey(authState.userId, authState.orgId ?? null);
  const cached = computeTargetGuardCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    if (cached.value) {
      return null;
    }
    return NextResponse.json(
      { error: "Engineer API requires a registered compute target" },
      { status: 403 }
    );
  }

  const token = await authState.getToken();
  const hasComputeTarget =
    typeof token === "string" && token.length > 0
      ? await fetchHasComputeTarget(request, token)
      : false;

  computeTargetGuardCache.set(cacheKey, {
    value: hasComputeTarget,
    expiresAt: now + COMPUTE_TARGET_CACHE_TTL_MS,
  });

  if (hasComputeTarget) {
    return null;
  }

  return NextResponse.json(
    { error: "Engineer API requires a registered compute target" },
    { status: 403 }
  );
}

const securityHeaders = env.FLAGS_SECRET
  ? securityMiddleware(noseconeOptionsWithToolbar)
  : securityMiddleware(noseconeOptions);

// Clerk middleware wraps other middleware in its callback
// For apps using Clerk, compose middleware inside authMiddleware callback
// For apps without Clerk, use createNEMO for composition (see apps/web)
export default authMiddleware(async (auth, request) => {
  const guardResponse = await engineerGuard(auth as ProxyAuth, request);
  if (guardResponse) {
    return guardResponse;
  }
  return securityHeaders();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    // Do not use String.raw here! Next.js can't statically analyze String.raw, so this breaks the build.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
