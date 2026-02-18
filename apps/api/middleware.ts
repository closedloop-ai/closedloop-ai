import { authMiddleware } from "@repo/auth/proxy";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

const TRAILING_SLASH_REGEX = /\/$/;
const LEADING_DOT_REGEX = /^\./;
const DEFAULT_PREVIEW_SUFFIX = "preview.closedloop-stage.ai";
const LOCALHOST_ORIGIN_REGEX = /^http:\/\/localhost:\d+$/;

// Allowed origins for CORS - built from environment variables
function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>(["http://localhost:3000"]);

  // Add the configured app URL (works for staging, production, or preview)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    origins.add(appUrl);
    // Also add without trailing slash in case of mismatch
    origins.add(appUrl.replace(TRAILING_SLASH_REGEX, ""));
  }

  const webUrl = process.env.NEXT_PUBLIC_WEB_URL;
  if (webUrl) {
    origins.add(webUrl);
    origins.add(webUrl.replace(TRAILING_SLASH_REGEX, ""));
  }

  return origins;
}

const allowedOrigins = getAllowedOrigins();

function getPreviewSuffix(): string | null {
  const suffix =
    process.env.NEXT_PUBLIC_PREVIEW_DOMAIN ??
    process.env.PREVIEW_DOMAIN ??
    DEFAULT_PREVIEW_SUFFIX;
  const normalized = suffix.replace(LEADING_DOT_REGEX, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function isPreviewOrigin(origin: string | null): boolean {
  if (!origin) {
    return false;
  }

  try {
    const hostname = new URL(origin).hostname.toLowerCase();

    // Check preview suffix domain (e.g., app-stage.preview.closedloop-stage.ai)
    const suffix = getPreviewSuffix();
    if (suffix && hostname.endsWith(suffix.toLowerCase())) {
      return true;
    }

    // Check Vercel preview URLs (e.g., app-stage-git-branch-team.vercel.app)
    // Only allow app-* origins (not arbitrary vercel.app domains)
    if (hostname.endsWith(".vercel.app") && hostname.startsWith("app-")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function isLocalhostOrigin(origin: string | null): boolean {
  return !!origin && LOCALHOST_ORIGIN_REGEX.test(origin);
}

function isOriginAllowed(origin: string | null): boolean {
  return (
    !!origin &&
    (allowedOrigins.has(origin) ||
      isLocalhostOrigin(origin) ||
      isPreviewOrigin(origin))
  );
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };

  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin"; // important with CDN caching
  }

  return headers;
}

function addCorsHeaders(response: Response, origin: string | null) {
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

const handleOptions = (request: NextRequest) => {
  const origin = request.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
};

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent
) {
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  const origin = request.headers.get("origin");
  const response =
    (await authMiddleware(() => NextResponse.next())(request, event)) ??
    NextResponse.next();
  return addCorsHeaders(response, origin);
}

export const config = {
  matcher: [
    // Run middleware on all routes except Next.js internals
    "/((?!_next).*)",
  ],
};
