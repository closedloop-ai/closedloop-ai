import type { CustomFieldReferenceResolveResponse } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { referenceSearchService } from "../../reference-search-service";
import { referenceTargetResolveValidator } from "../../reference-search-validators";

/**
 * POST /custom-fields/references/resolve - Resolve many reference target ids
 * into the chip projection in one round trip.
 *
 * POST for a READ because the request body is a list of up to
 * `REFERENCE_RESOLVE_MAX_IDS` uuids, which does not fit a query string. The
 * `read` scope is declared explicitly for exactly that reason: `withAnyAuth`
 * would otherwise infer `write` from the verb and lock read-only API keys out
 * of a read.
 */
export const POST = withAnyAuth<
  CustomFieldReferenceResolveResponse,
  "/custom-fields/references/resolve"
>(
  async ({ user }, request) => {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      referenceTargetResolveValidator
    );
    if (parseError) {
      return parseError;
    }

    try {
      const result = await referenceSearchService.resolveTargets(
        body.targetIds,
        user.organizationId
      );
      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to resolve reference targets", error);
    }
  },
  { requiredScopes: ["read"] }
);
