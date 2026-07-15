import type { ApiResult } from "@repo/api/src/types/common";
import { failure } from "@repo/api/src/types/common";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopAgentComponentsPayloadSchema } from "@/lib/desktop-agent-sessions-schema";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { desktopComponentsSyncService } from "./service";

const DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES = 262_144; // 256 KiB

export type DesktopComponentsSyncResponse = { synced: boolean };

/**
 * POST /desktop/components/sync?computeTargetId=<id>
 *
 * Receives a batch of component inventory existence rows materialized by the
 * desktop at transcript-import time. Upserts `AgentComponent` rows in the cloud
 * keyed by `(computeTargetId, componentKind, externalComponentId)`.
 *
 * - 256 KiB request body cap (same as agent-sessions sync).
 * - Accepts any authenticated caller (API-key, desktop-session, or Clerk session).
 * - Verifies compute-target ownership before writing.
 * - Delegates to `desktopComponentsSyncService.sync`; no server-side re-parse.
 *
 * Schema version is validated against `AGENT_COMPONENT_SYNC_SCHEMA_VERSION`.
 */
export const POST = withAnyAuth<
  DesktopComponentsSyncResponse,
  "/desktop/components/sync"
>(async ({ user, clerkUserId }, request) => {
  const computeTargetId = new URL(request.url).searchParams
    .get("computeTargetId")
    ?.trim();
  if (!computeTargetId) {
    return badRequestResponse("computeTargetId is required");
  }

  const { rawBody, response } = await readDesktopComponentsSyncBody(request);
  if (response) {
    return response;
  }

  const parsed = desktopAgentComponentsPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequestResponse("Invalid component sync payload");
  }

  try {
    const result = await desktopComponentsSyncService.sync({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      payload: parsed.data,
      userId: user.id,
    });

    if (result.ok) {
      return successResponse(result.value);
    }
    // The ownership gate returns `Status.Forbidden` (403), matching the
    // reference desktop agent-sessions sync route. (Previously this compared
    // against the string "forbidden", which never matched the numeric error,
    // so an ownership failure fell through to a 500 instead of a 403.)
    if (result.error === Status.Forbidden) {
      return forbiddenResponse();
    }
    return errorResponse("Failed to sync component inventory", result.error);
  } catch (error) {
    return errorResponse("Failed to sync component inventory", error);
  }
});

async function readDesktopComponentsSyncBody(
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
    DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES
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
