import type { AgentVersionDetail } from "@repo/api/src/types/agent";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentsService } from "../../../service";

export const GET = withAnyAuth<
  AgentVersionDetail,
  "/agents/[idOrSlug]/versions/[version]"
>(async ({ user }, _request, params) => {
  try {
    const { idOrSlug, version: versionStr } = await params;
    const version = Number.parseInt(versionStr, 10);
    if (Number.isNaN(version) || version < 1) {
      return badRequestResponse("Version must be a positive integer");
    }

    const versionDetail = await agentsService.findVersion(
      idOrSlug,
      user.organizationId,
      version
    );

    if (!versionDetail) {
      return notFoundResponse("Agent version");
    }

    return successResponse(versionDetail);
  } catch (error) {
    return errorResponse("Failed to fetch agent version", error);
  }
});
