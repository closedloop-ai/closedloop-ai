import { NextResponse } from "next/server";
import { resolveApiOrigin } from "@/lib/api-origin";

const DESKTOP_ONBOARDING_PROTOCOL_VERSION = "1";
const DEFAULT_RELAY_ORIGIN = "https://relay.closedloop.ai";

/**
 * GET /.well-known/closedloop-desktop.json
 * Publishes trusted origins Desktop may use after the user confirms this web app URL.
 */
export function GET(request: Request) {
  return NextResponse.json(
    {
      apiOrigin: resolveApiOrigin({
        nextUrl: new URL(request.url),
      }),
      relayOrigin: resolveRelayOrigin(),
      onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function resolveRelayOrigin(): string {
  const configured =
    process.env.NEXT_PUBLIC_RELAY_ORIGIN ??
    process.env.CL_RELAY_ORIGIN ??
    DEFAULT_RELAY_ORIGIN;
  try {
    return new URL(configured).origin;
  } catch {
    return new URL(DEFAULT_RELAY_ORIGIN).origin;
  }
}
