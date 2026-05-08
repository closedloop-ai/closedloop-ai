import { NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";

const DESKTOP_ONBOARDING_PROTOCOL_VERSION = "1";
const DEFAULT_RELAY_ORIGIN = "https://relay.closedloop.ai";

/**
 * GET /.well-known/closedloop-desktop.json
 * Publishes trusted origins Desktop may use after the user confirms this web app URL.
 */
export function GET(request: Request) {
  const apiOrigin = resolveApiOrigin({
    nextUrl: new URL(request.url),
  });

  return NextResponse.json(
    {
      apiOrigin,
      relayOrigin: resolveRelayOrigin(apiOrigin),
      onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function resolveRelayOrigin(apiOrigin: string): string {
  const configured = getConfiguredRelayOrigin(apiOrigin);

  if (!configured && isLocalhostOrigin(apiOrigin)) {
    return apiOrigin;
  }

  try {
    return new URL(configured ?? DEFAULT_RELAY_ORIGIN).origin;
  } catch {
    return new URL(DEFAULT_RELAY_ORIGIN).origin;
  }
}

function getConfiguredRelayOrigin(apiOrigin: string): string | undefined {
  const serverConfigured = process.env.CL_RELAY_ORIGIN?.trim();
  if (serverConfigured) {
    return serverConfigured;
  }

  const publicConfigured = process.env.NEXT_PUBLIC_RELAY_ORIGIN?.trim();
  if (publicConfigured) {
    return publicConfigured;
  }

  const localRelayApiUrl = process.env.RELAY_API_URL?.trim();
  if (
    localRelayApiUrl &&
    isLocalhostOrigin(apiOrigin) &&
    isLocalhostOrigin(localRelayApiUrl)
  ) {
    return localRelayApiUrl;
  }

  return undefined;
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
