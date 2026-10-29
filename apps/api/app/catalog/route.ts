import "server-only";

import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { requireOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { recordOrganizationWrite } from "@/lib/organization-write-receipt";
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
 * Create a new CatalogItem. Admin-only (`requireOrgAdmin` gate).
 * After creation, upload assets via POST /catalog/upload-intent and
 * confirm with POST /catalog/confirm.
 */
export const POST = withAnyAuth<CatalogItemDto, "/catalog">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, _params, receipts) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        createCatalogItemBodySchema
      );
      if (parseError) {
        return parseError;
      }

      try {
        const result = await createCatalogItem(
          {
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
          },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          // 404: parent pack missing / not visible to the org.
          // 403: parent exists but is not an org-owned Pack container.
          if (result.error === 404) {
            return notFoundResponse("Parent pack");
          }
          return forbiddenResponse();
        }

        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to create catalog item", error);
      }
    }
  )
);
