import { env } from "@/env";

const LOCAL_API_FALLBACK = "http://localhost:3002";
const APP_PREFIX_REGEX = /^app-/;

function rewritePreviewHostname(hostname: string): string | null {
  if (hostname.includes(".preview.") && hostname.startsWith("app-")) {
    return hostname.replace(APP_PREFIX_REGEX, "api-");
  }

  if (hostname.includes(".vercel.app") && hostname.startsWith("app-")) {
    return hostname.replace(APP_PREFIX_REGEX, "api-");
  }

  return null;
}

type ApiOriginRequest = {
  nextUrl?: Pick<URL, "hostname" | "protocol">;
  url?: string;
};

export function resolveApiOrigin(request?: ApiOriginRequest): string {
  if (request) {
    const nextUrl = request.nextUrl ?? getRequestUrl(request);
    const rewrittenHostname = nextUrl
      ? rewritePreviewHostname(nextUrl.hostname)
      : null;
    if (nextUrl && rewrittenHostname) {
      return `${nextUrl.protocol}//${rewrittenHostname}`;
    }
  }

  if (globalThis.window !== undefined) {
    const rewrittenHostname = rewritePreviewHostname(
      globalThis.window.location.hostname
    );
    if (rewrittenHostname) {
      return `${globalThis.window.location.protocol}//${rewrittenHostname}`;
    }
  }

  if (globalThis.window === undefined && env.SERVER_API_URL) {
    return env.SERVER_API_URL;
  }

  const configured = env.NEXT_PUBLIC_API_URL;
  if (configured && configured !== LOCAL_API_FALLBACK) {
    return configured;
  }

  return LOCAL_API_FALLBACK;
}

function getRequestUrl(request: ApiOriginRequest): URL | null {
  if (!request.url) {
    return null;
  }

  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}
