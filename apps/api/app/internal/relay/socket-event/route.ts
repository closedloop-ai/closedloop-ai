import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { NextResponse } from "next/server";
import { DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES } from "@/lib/desktop-gateway-wire";
import { validateInternalSecret } from "@/lib/internal-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  logRequestBodyOverCap,
  readCappedRequestText,
  scheduleLogFlush,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { dispatchSocketEvent, extractCorrelationContext } from "./service";

async function handlePost(request: Request): Promise<Response> {
  const requestArrivedAt = Date.now();

  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // This route hand-parses its body rather than going through `parseBody`, so
  // it had no byte cap at all. `parseBody` is not the fix here: it answers with
  // the repo's `ApiResult` failure shape, while this internal route returns a
  // bare `{ error }` the relay already parses — swapping it would be a wire
  // change on a peer that ships separately. Its capped-read primitive is.
  //
  // The bound is the gateway's payload ceiling rather than the 4 MiB route
  // default, as a deliberate superset: the relay forwards this body as an
  // ENVELOPE around the payload (`{event, payload, auth, targetId, …}`), so a
  // cap sized to the payload alone would not actually bound the body. The
  // relay's own socket.io ingress is far tighter, so nothing near 10 MiB is
  // reachable in practice — this exists so the route cannot be the unbounded
  // one if that ever changes.
  const bodyText = await readCappedRequestText(
    request,
    DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES
  );
  if (!bodyText.ok) {
    // `logRequestBodyOverCap` schedules its own flush.
    logRequestBodyOverCap(request, DESKTOP_GATEWAY_MAX_PAYLOAD_BYTES);
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText.value);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.event !== "string") {
    return NextResponse.json({ error: "Missing event field" }, { status: 400 });
  }

  const event = body.event;
  const payload = body.payload;
  const auth = isRecord(body.auth)
    ? (body.auth as {
        organizationId: string;
        userId: string;
        clerkUserId?: string | null;
      })
    : null;
  const targetId =
    typeof body.targetId === "string" ? body.targetId : undefined;
  // Extract correlation context forwarded by the relay worker (T-2.6)
  const correlation = extractCorrelationContext(body);

  try {
    const result = await dispatchSocketEvent({
      event,
      payload,
      auth,
      targetId,
      correlation,
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
    log.error("Internal relay socket-event handler failed", {
      event,
      computeTargetId: targetId ?? correlation.computeTargetId ?? null,
      gatewaySessionIdHash: redactGatewaySessionId(
        correlation.gatewaySessionId
      ),
      requestId: correlation.requestId,
      error,
    });
    scheduleLogFlush();
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export const POST = withRequestCompleted(handlePost);
