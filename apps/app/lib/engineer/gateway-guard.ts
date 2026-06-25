import type { ClerkMiddlewareAuth } from "@repo/auth/server";
import { type NextRequest, NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";
import { GATEWAY_PATH_PREFIX, GATEWAY_RELAY_PATH_PREFIX } from "./constants";

/**
 * SECURITY CRITICAL. The localhost-only enforcement for the Engineer gateway.
 *
 * Extracted from `apps/app/proxy.ts` (which imports and calls `gatewayGuard`
 * in the Clerk middleware chain) so the 403/401 decisions are independently
 * unit-testable. This does NOT relax enforcement — the guard still runs in the
 * proxy before any gateway request is allowed through.
 *
 * - `/api/gateway/*` spawns local CLI processes and touches the local
 *   filesystem, so it is ALWAYS localhost-only (403 for any non-local host).
 * - `/api/gateway-relay/*` is cloud-safe but requires an authenticated user
 *   with a registered compute target.
 */

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function isGatewayLocalPath(pathname: string): boolean {
  return pathname.startsWith(GATEWAY_PATH_PREFIX);
}

function isGatewayRelayPath(pathname: string): boolean {
  return pathname.startsWith(GATEWAY_RELAY_PATH_PREFIX);
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
 * Guards gateway API routes to localhost or authenticated users with
 * registered compute targets (cached for 30s).
 *
 * Gateway API routes spawn local CLI processes (Claude, git, codex) and
 * read/write the local filesystem. They must never be accessible in deployed
 * environments — gatewayGuard only blocks the UI, not the HTTP layer.
 *
 * See CLAUDE.md "Engineer Feature — Architectural Exception" for full context.
 */
export async function gatewayGuard(
  auth: ClerkMiddlewareAuth,
  request: NextRequest
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;
  const isLocal = isGatewayLocalPath(pathname);
  const isRelay = isGatewayRelayPath(pathname);

  if (!(isLocal || isRelay)) {
    return null;
  }

  const hostname = request.headers.get("host")?.split(":")[0] ?? "";
  if (LOCALHOST_HOSTNAMES.has(hostname)) {
    return null;
  }

  // /api/gateway/* routes spawn local CLI processes — always localhost-only.
  if (isLocal) {
    return NextResponse.json(
      { error: "Gateway API is only available on localhost" },
      { status: 403 }
    );
  }

  // /api/gateway-relay/* routes are cloud-safe but require a compute target.
  const authState = await auth();
  if (!authState.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await authState.getToken();
  const hasComputeTarget =
    typeof token === "string" && token.length > 0
      ? await fetchHasComputeTarget(request, token).catch(() => false)
      : false;

  if (hasComputeTarget) {
    return null;
  }

  return NextResponse.json(
    { error: "Gateway API requires a registered compute target" },
    { status: 403 }
  );
}
