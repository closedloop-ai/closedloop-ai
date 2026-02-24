import type { WorkstreamWithProject } from "@repo/api/src/types/workstream";
import { WorkstreamState } from "@repo/database";
import { workstreamsService } from "@/app/workstreams/service";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";

export const GET = withAuth<WorkstreamWithProject[], "/dashboard/workstreams">(
  async ({ user }) => {
    try {
      const workstreams = await workstreamsService.findAllByOrganization(
        user.organizationId,
        {
          excludeStates: [
            WorkstreamState.COMPLETED,
            WorkstreamState.CANCELLED,
            WorkstreamState.DEPLOYED,
          ],
        }
      );
      return successResponse(workstreams);
    } catch (error) {
      return errorResponse("Failed to fetch in-progress workstreams", error);
    }
  }
);
