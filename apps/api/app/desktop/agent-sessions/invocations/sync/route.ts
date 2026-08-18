import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncRejectReason,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncBatchSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { type ApiResult, failure } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  readCappedRequestText,
  successResponse,
} from "@/lib/route-utils";
import { desktopAgentComponentInvocationsSyncService } from "./service";

/**
 * Dedicated component-invocation sync; session schema v2 is unchanged. Accepts
 * every version in `AGENT_COMPONENT_INVOCATION_SYNC_SUPPORTED_PROTOCOL_VERSIONS`
 * (v1 telemetry-free, v2 telemetry-carrying) so an older Desktop keeps syncing
 * against this build, and echoes the request's version on the ack so that older
 * client's strict ack parser still recognizes the reply.
 */
export const POST = withAnyAuth<
  AgentComponentInvocationSyncAck,
  "/desktop/agent-sessions/invocations/sync"
>(async ({ user, clerkUserId }, request) => {
  const computeTargetId = new URL(request.url).searchParams
    .get("computeTargetId")
    ?.trim();
  if (!computeTargetId) {
    return badRequestResponse("computeTargetId is required");
  }

  const { rawBody, response } = await readInvocationSyncBody(request);
  if (response) {
    return response;
  }
  if (hasUnsupportedProtocolVersion(rawBody)) {
    return NextResponse.json(
      failure("Unsupported component invocation sync protocol", {
        code: AgentComponentInvocationSyncRejectReason.ProtocolUnsupported,
      }),
      { status: 501 }
    );
  }
  const parsed = agentComponentInvocationSyncBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequestResponse("Invalid component invocation sync payload");
  }
  const part = parsed.data.parts[0];
  if (!part) {
    return badRequestResponse("Invalid component invocation sync payload");
  }

  try {
    const result = await desktopAgentComponentInvocationsSyncService.sync({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      part,
      userId: user.id,
    });
    if (result.ok) {
      return successResponse(result.value);
    }
    if (result.error === Status.Forbidden) {
      return forbiddenResponse();
    }
    return errorResponse("Failed to sync component invocations", result.error);
  } catch (error) {
    return errorResponse("Failed to sync component invocations", error);
  }
});

async function readInvocationSyncBody(
  request: Request
): Promise<
  | { rawBody: unknown; response: null }
  | { rawBody: null; response: NextResponse<ApiResult<never>> }
> {
  const cappedBody = await readCappedRequestText(
    request,
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_BATCH_BYTES
  ).catch(() => null);
  if (cappedBody === null) {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }
  if (!cappedBody.ok) {
    return {
      rawBody: null,
      response: NextResponse.json(failure("Request body too large"), {
        status: 413,
      }),
    };
  }
  try {
    return { rawBody: JSON.parse(cappedBody.value) as unknown, response: null };
  } catch {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }
}

function hasUnsupportedProtocolVersion(rawBody: unknown): boolean {
  if (
    typeof rawBody !== "object" ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    return false;
  }
  const protocolVersion = Reflect.get(rawBody, "protocolVersion");
  // ISS-4976: the gate is a SET membership test, not equality with one
  // constant. A version this build does not know still answers the retryable
  // `protocol_unsupported` (501) rather than falling through to the `.strict()`
  // schema, whose 400 the Desktop client classes as a permanent
  // `validation_failed` and dead-letters after five attempts.
  //
  // @thadeusb review: the membership test itself is the SHARED predicate, so
  // this gate and the Desktop outbox loader answer "can I handle this version?"
  // from the one tuple the producer picks from and cannot drift apart.
  return (
    typeof protocolVersion === "number" &&
    !isSupportedAgentComponentInvocationSyncProtocolVersion(protocolVersion)
  );
}
