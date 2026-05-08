import type { BulkIngestAgentResponse } from "@repo/api/src/types/agent";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { agentsService } from "../service";
import { bulkIngestValidator } from "../validators";

export const POST = withAnyAuth<BulkIngestAgentResponse, "/agents/bulk-ingest">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    try {
      const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
      if (!adminCheck) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        bulkIngestValidator
      );
      if (parseError) {
        return parseError;
      }

      const result = await agentsService.bulkIngest(
        user.organizationId,
        user.id,
        body
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to bulk ingest agents", error);
    }
  }
);
