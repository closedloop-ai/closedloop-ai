import { sessionMeshRetentionService } from "@/app/session-mesh/retention-service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { errorResponse, successResponse } from "@/lib/route-utils";

export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const denied = validateCronSecret(request, "[cleanup-session-mesh]");
  if (denied) {
    return denied;
  }
  try {
    return successResponse(await sessionMeshRetentionService.sweep());
  } catch (error) {
    return errorResponse("Session Mesh retention cleanup failed", error);
  }
}
