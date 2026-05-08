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
  nextUrl: Pick<URL, "hostname" | "protocol">;
};

export function resolveApiOrigin(request?: ApiOriginRequest): string {
  if (request) {
    const rewrittenHostname = rewritePreviewHostname(request.nextUrl.hostname);
    if (rewrittenHostname) {
      return `${request.nextUrl.protocol}//${rewrittenHostname}`;
    }
  }

  if (typeof window !== "undefined") {
    const rewrittenHostname = rewritePreviewHostname(window.location.hostname);
    if (rewrittenHostname) {
      return `${window.location.protocol}//${rewrittenHostname}`;
    }
  }

  const configured = env.NEXT_PUBLIC_API_URL;
  if (configured && configured !== LOCAL_API_FALLBACK) {
    return configured;
  }

  return LOCAL_API_FALLBACK;
}
