import {
  DesktopAgentSessionsAckReason,
  type DesktopAgentSessionsSyncResponse,
} from "@repo/api/src/types/agent-session";
import { type ApiResult, failure } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { desktopAgentSessionsSyncService } from "./service";

const DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES = 262_144;

/**
 * Targeted desktop session sync over the same API-key channel used by
 * local-first trace comments. This lets a desktop comment create the cloud
 * parent SESSION artifact before uploading the comment without waiting behind
 * the bulk relay backfill queue.
 */
export const POST = withAnyAuth<
  DesktopAgentSessionsSyncResponse,
  "/desktop/agent-sessions/sync"
>(async ({ user, clerkUserId }, request) => {
  const computeTargetId = new URL(request.url).searchParams
    .get("computeTargetId")
    ?.trim();
  if (!computeTargetId) {
    return badRequestResponse("computeTargetId is required");
  }

  const { rawBody, response } = await readDesktopAgentSessionsSyncBody(request);
  if (response) {
    return response;
  }

  try {
    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      rawBody,
      userId: user.id,
    });

    if (result.ok) {
      return successResponse(result.value);
    }
    if (
      result.error === Status.BadRequest ||
      result.error === DesktopAgentSessionsAckReason.ValidationFailed
    ) {
      return badRequestResponse("Invalid agent-session sync payload");
    }
    if (
      result.error === Status.Forbidden ||
      result.error === DesktopAgentSessionsAckReason.FeatureDisabled
    ) {
      return forbiddenResponse();
    }
    if (result.error === DesktopAgentSessionsAckReason.RateLimited) {
      return rateLimitedResponse();
    }
    return errorResponse("Failed to sync agent session", result.error);
  } catch (error) {
    return errorResponse("Failed to sync agent session", error);
  }
});

async function readDesktopAgentSessionsSyncBody(
  request: Request
): Promise<
  | { rawBody: unknown; response: null }
  | { rawBody: null; response: NextResponse<ApiResult<never>> }
> {
  const bodyText = await request.text().catch(() => null);
  if (bodyText === null) {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }

  if (
    new TextEncoder().encode(bodyText).byteLength >
    DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES
  ) {
    return {
      rawBody: null,
      response: NextResponse.json(failure("Request body too large"), {
        status: 413,
      }),
    };
  }

  try {
    return { rawBody: JSON.parse(bodyText) as unknown, response: null };
  } catch {
    return { rawBody: null, response: badRequestResponse("Invalid JSON body") };
  }
}

function rateLimitedResponse(): NextResponse<ApiResult<never>> {
  return NextResponse.json(failure("Rate limited"), { status: 429 });
}
