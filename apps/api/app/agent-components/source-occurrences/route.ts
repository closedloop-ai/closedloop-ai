import type { SourceOccurrenceListResponse } from "@repo/api/src/types/component-resolution";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentsService } from "../service";
import { sourceOccurrenceQuerySchema } from "../validators";

/**
 * FEA-3704: org-scoped, paginated read of the source occurrences ("where was
 * this exact `DefinitionVersion` seen") for one version. Thin route → fat
 * service: all org-scoping, counting, and paging live in the service /
 * definition-registry read, which filters on BOTH the auth user's
 * `organizationId` AND the requested `definitionVersionId` — so a caller can
 * never read another org's occurrences even with a leaked foreign version id.
 *
 * A static segment, so it wins over the sibling `[slug]` dynamic route for the
 * literal `/agent-components/source-occurrences` path (Next.js App Router
 * precedence). Dual auth (`withAnyAuth`, `read` scope) covers both browser
 * (Clerk) and API-key / desktop-session callers.
 */
export const GET = withAnyAuth<
  SourceOccurrenceListResponse,
  "/agent-components/source-occurrences"
>(
  async ({ user }, request) => {
    const parsed = parseQueryParams(request, sourceOccurrenceQuerySchema);
    if (parsed.errorResponse) {
      return parsed.errorResponse;
    }
    const { definitionVersionId, offset, limit } = parsed.params;
    try {
      const response =
        await agentComponentsService.getSourceOccurrencePageForOrg(
          user.organizationId,
          definitionVersionId,
          offset,
          limit
        );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch source occurrences", error);
    }
  },
  { requiredScopes: ["read"] }
);
