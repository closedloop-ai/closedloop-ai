import type { AgentVersionSummary } from "@repo/api/src/types/agent";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentsService } from "../../service";

export const GET = withAnyAuth<
  { versions: AgentVersionSummary[] },
  "/agents/[idOrSlug]/versions"
>(async ({ user }, _request, params) => {
  try {
    const { idOrSlug } = await params;
    const versions = await agentsService.findVersions(
      idOrSlug,
      user.organizationId
    );

    if (!versions) {
      return notFoundResponse("Agent");
    }

    return successResponse({ versions });
  } catch (error) {
    return errorResponse("Failed to fetch agent versions", error);
  }
});
