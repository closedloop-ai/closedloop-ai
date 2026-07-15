import "server-only";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  archiveCatalogItem,
  getCatalogItemDetail,
  updateCatalogItem,
} from "../service";
import { updateCatalogItemBodySchema } from "../validators";

/**
 * GET /catalog/{id}
 *
 * Org-visible (no admin gate). Returns a single CatalogItem with a
 * presigned logo GET URL (15 min TTL) when a logo asset is present.
 */
export const GET = withAnyAuth<CatalogItemDto, "/catalog/[id]">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    try {
      const result = await getCatalogItemDetail({
        id,
        organizationId: user.organizationId,
      });

      if (!result.ok) {
        return notFoundResponse("Catalog item");
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to fetch catalog item", error);
    }
  }
);

/**
 * PATCH /catalog/{id}
 *
 * Update mutable fields on a CatalogItem. Admins can update org-owned custom
 * catalog management fields; item creators can update only their own editable
 * org_custom metadata/content. Returns 403 for read-only, archived, non-owned,
 * or otherwise unsupported mutations.
 */
export const PATCH = withAnyAuth<CatalogItemDto, "/catalog/[id]">(
  async ({ user, clerkOrgId, clerkUserId }, request, params) => {
    const { id } = await params;

    const { body, errorResponse: parseError } = await parseBody(
      request,
      updateCatalogItemBodySchema
    );
    if (parseError) {
      return parseError;
    }

    try {
      const canUpdateAny = await isOrgAdmin(clerkOrgId, clerkUserId);
      const result = await updateCatalogItem({
        id,
        organizationId: user.organizationId,
        userId: user.id,
        canUpdateAny,
        name: body.name,
        description: body.description,
        sortOrder: body.sortOrder,
        enabled: body.enabled,
        coaching: body.coaching,
        coachingConfig: body.coachingConfig,
        content: body.content,
      });

      if (!result.ok) {
        if (result.error === 404) {
          return notFoundResponse("Catalog item");
        }
        return forbiddenResponse();
      }

      return successResponse(result.value);
    } catch (error) {
      return errorResponse("Failed to update catalog item", error);
    }
  }
);

/**
 * DELETE /catalog/{id}
 *
 * Admin-only. Soft-archive a CatalogItem (sets archived=true).
 * Returns 403 for curated items.
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/catalog/[id]">(
  async ({ user, clerkOrgId, clerkUserId }, _request, params) => {
    const adminCheck = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!adminCheck) {
      return forbiddenResponse();
    }

    const { id } = await params;

    try {
      const result = await archiveCatalogItem({
        id,
        organizationId: user.organizationId,
      });

      if (!result.ok) {
        if (result.error === 404) {
          return notFoundResponse("Catalog item");
        }
        return forbiddenResponse();
      }

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to archive catalog item", error);
    }
  }
);
