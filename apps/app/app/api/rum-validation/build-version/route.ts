import { NextResponse } from "next/server";
import { env } from "@/env";
import { getDatadogRumVersion } from "@/lib/datadog-rum/config";

export function GET(): Response {
  if (env.RUM_VALIDATION_ROUTE_ENABLED !== "true") {
    return new Response(null, { status: 404 });
  }

  return NextResponse.json(
    { datadogRumVersion: getDatadogRumVersion() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
