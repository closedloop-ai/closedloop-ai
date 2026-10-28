import type { CustomFieldReferenceSearchResponse } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  formatZodErrors,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  DisallowedReferenceSourceError,
  ReferenceFieldNotFoundError,
  referenceSearchService,
} from "../../reference-search-service";
import {
  referenceFieldIdValidator,
  referenceTargetSearchValidator,
} from "../../reference-search-validators";

/**
 * GET /custom-fields/:id/reference-targets - Typeahead over the artifacts this
 * reference field may point at.
 *
 * Scoping is the field's, not the caller's: the permitted populations are read
 * from the field row and the organization comes from the authenticated user, so
 * neither can be widened by the request.
 */
export const GET = withAnyAuth<
  CustomFieldReferenceSearchResponse,
  "/custom-fields/[id]/reference-targets"
>(async ({ user }, request, params) => {
  const { id } = await params;
  const fieldId = referenceFieldIdValidator.safeParse(id);
  if (!fieldId.success) {
    return badRequestResponse(formatZodErrors(fieldId.error.issues));
  }

  const { params: query, errorResponse: parseError } = parseQueryParams(
    request,
    referenceTargetSearchValidator
  );
  if (parseError) {
    return parseError;
  }

  try {
    const result = await referenceSearchService.searchTargets({
      fieldId: fieldId.data,
      organizationId: user.organizationId,
      query: query.query,
      sources: query.sources,
      limit: query.limit,
      excludeEntityId: query.excludeEntityId,
    });
    return successResponse(result);
  } catch (error) {
    if (error instanceof ReferenceFieldNotFoundError) {
      return notFoundResponse("Custom field");
    }
    if (error instanceof DisallowedReferenceSourceError) {
      return badRequestResponse(error.message);
    }
    return errorResponse("Failed to search reference targets", error);
  }
});
