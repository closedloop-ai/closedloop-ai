import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { validateInternalSecret } from "@/lib/internal-auth";
import { scheduleLogFlush } from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { dispatchSocketEvent, extractCorrelationContext } from "./service";

export async function POST(request: Request): Promise<Response> {
  const requestArrivedAt = Date.now();

  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.event !== "string") {
    return NextResponse.json({ error: "Missing event field" }, { status: 400 });
  }

  const event = body.event;
  const payload = body.payload;
  const auth = isRecord(body.auth)
    ? (body.auth as { organizationId: string; userId: string })
    : null;
  const targetId =
    typeof body.targetId === "string" ? body.targetId : undefined;
  // Extract correlation context forwarded by the relay worker (T-2.6)
  const correlation = extractCorrelationContext(body);
  // pluginVersion is inside the payload object (relay enriches the event payload, not the top-level body)
  const pluginVersion =
    isRecord(payload) && typeof payload.pluginVersion === "string"
      ? payload.pluginVersion
      : undefined;

  try {
    const result = await dispatchSocketEvent({
      event,
      payload,
      auth,
      targetId,
      correlation,
      pluginVersion,
      requestArrivedAt,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result.response);
  } catch (error) {
    log.error("Internal relay socket-event handler failed", { event, error });
    scheduleLogFlush();
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
