import { artifactLinksService } from "@/app/artifact-links/service";
import { validateCronSecret } from "@/lib/auth/cron-secret";
import { errorResponse, successResponse } from "@/lib/route-utils";

// Bounded, separately committed batches; unfinished work resumes next hour.
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const denied = validateCronSecret(
    request,
    "[cleanup-artifact-link-tree-pages]"
  );
  if (denied) {
    return denied;
  }
  try {
    return successResponse({
      deleted: await artifactLinksService.sweepExpiredTreePages(),
    });
  } catch (error) {
    return errorResponse("Artifact link tree page cleanup failed", error);
  }
}
