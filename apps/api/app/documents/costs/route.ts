import { documentCostsRequestSchema } from "@repo/api/src/types/document-costs";
import { documentCostScopeService } from "@/app/documents/document-cost-scope-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

export const POST = withAnyAuth(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      documentCostsRequestSchema
    );
    if (parseError) {
      return parseError;
    }
    const costs = await documentCostScopeService.read(
      user.organizationId,
      user.id,
      body
    );
    if (!costs.ok) {
      return badRequestResponse(costs.error);
    }
    return successResponse(costs.value);
  } catch (error) {
    return errorResponse("Failed to read document costs", error);
  }
});
