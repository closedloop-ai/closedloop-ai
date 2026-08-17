import type { DesktopTelemetryReceiveResponse } from "@repo/api/src/types/desktop-telemetry";
import {
  DESKTOP_PLUGIN_VERSION_HEADER,
  DesktopWriteLaneRestErrorCode,
} from "@repo/api/src/types/desktop-write-lane";
import { Status } from "@repo/api/src/types/result";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
} from "@/lib/route-utils";
import { readBoundedJsonBody, requireComputeTargetId } from "../route-helpers";
import { desktopTelemetryService } from "./service";

/**
 * Matches the agent-sessions sync cap: telemetry events carry bounded
 * diagnostics (logTail is truncated server-side during sanitization), so a
 * well-formed event never approaches this.
 */
const DESKTOP_TELEMETRY_REQUEST_MAX_BYTES = 262_144;

/**
 * FEA-3425: explicit function ceiling. The path is one compute-target
 * ownership lookup plus synchronous validation/sanitization/logging — 15s is
 * generous headroom above the desktop client's 10s abort.
 */
export const maxDuration = 15;

/**
 * FEA-3425 (PLN-1437 Phase 3): REST twin of the relay `desktop.telemetry`
 * socket event, letting sessioned desktop installs deliver diagnostics
 * telemetry over the authenticated HTTP write lane instead of the static-key
 * relay socket. The desktop client is fire-and-forget, but every non-2xx
 * branch still carries a machine-readable `code`
 * ({@link DesktopWriteLaneRestErrorCode}) for operators, mirroring the
 * analytics and agent-sessions twins.
 */
export const POST = withAnyAuth<
  DesktopTelemetryReceiveResponse,
  "/desktop/telemetry"
>(async ({ user, clerkUserId }, request) => {
  const { computeTargetId, response: targetResponse } =
    requireComputeTargetId(request);
  if (targetResponse) {
    return targetResponse;
  }

  const { rawBody, response } = await readBoundedJsonBody(
    request,
    DESKTOP_TELEMETRY_REQUEST_MAX_BYTES
  );
  if (response) {
    return response;
  }

  try {
    const result = await desktopTelemetryService.receive({
      clerkUserId,
      computeTargetId,
      organizationId: user.organizationId,
      pluginVersion:
        request.headers.get(DESKTOP_PLUGIN_VERSION_HEADER) ?? undefined,
      rawBody,
      userId: user.id,
    });

    if (result.ok) {
      return successResponse(result.value);
    }
    if (result.error === Status.Forbidden) {
      return forbiddenResponse({
        code: DesktopWriteLaneRestErrorCode.TargetNotOwned,
      });
    }
    return badRequestResponse("Invalid desktop telemetry payload", {
      code: DesktopWriteLaneRestErrorCode.ValidationFailed,
    });
  } catch (error) {
    return errorResponse("Failed to receive desktop telemetry", error, 500, {
      code: DesktopWriteLaneRestErrorCode.InternalError,
    });
  }
});
