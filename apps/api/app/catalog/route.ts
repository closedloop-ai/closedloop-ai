import "server-only";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { createCatalogItem, listCatalogItemsForOrg } from "./service";
import {
  createCatalogItemBodySchema,
  listCatalogQuerySchema,
} from "./validators";

/**
 * GET /catalog
 *
 * List CatalogItems visible to the calling org: org-specific items +
 * curated global items. Org-visible (no admin gate). Excludes archived
 * items by default; pass `?includeArchived=true` to include them.
 */
export const GET = withAnyAuth<CatalogItemDto[], "/catalog">(
  async ({ user }, request) => {
    const searchParams = new URL(request.url).searchParams;
    const parseResult = listCatalogQuerySchema.safeParse(
      Object.fromEntries(searchParams.entries())
    );
    if (!parseResult.success) {
      return badRequestResponse("Invalid query parameters");
    }

    try {
      const items = await listCatalogItemsForOrg({
        organizationId: user.organizationId,
        includeArchived: parseResult.data.includeArchived,
      });
      return successResponse(items);
    } catch (error) {
      return errorResponse("Failed to list catalog items", error);
    }
  }
);

/**
 * POST /catalog
 *
 * Create a new CatalogItem. Admin-only (isOrgAdmin gate).
 * After creation, upload assets via POST /catalog/upload-intent and
 * confirm with POST /catalog/confirm.
 */
export const POST = withAnyAuth<CatalogItemDto, "/catalog">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!adminCheck) {
      return forbiddenResponse();
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      createCatalogItemBodySchema
    );
    if (parseError) {
      return parseError;
    }

    try {
      const result = await createCatalogItem({
        organizationId: user.organizationId,
        userId: user.id,
        targetKind: body.targetKind,
        name: body.name,
        description: body.description,
        sortOrder: body.sortOrder,
        coaching: body.coaching,
        coachingConfig: body.coachingConfig,
        parentPackId: body.parentPackId,
        content: body.content,
      });

      if (!result.ok) {
        // 404: parent pack missing / not visible to the org.
        // 403: parent exists but is not an org-owned Pack container.
        if (result.error === 404) {
          return notFoundResponse("Parent pack");
        }
        return forbiddenResponse();
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to create catalog item", error);
    }
  }
);
