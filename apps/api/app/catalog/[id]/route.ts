import "server-only";

import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { Status } from "@repo/api/src/types/result";
import { getOrgAdminStatus, requireOrgAdmin } from "@/lib/auth/org-admin";
import { roleUnresolvedResponse } from "@/lib/auth/org-admin-denial";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { recordOrganizationWrite } from "@/lib/organization-write-receipt";
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
    // The path segment is untrusted and `CatalogItem.id` is `@db.Uuid`, so a
    // malformed one raises at the driver and the catch below would report a
    // caller's typo as a 500, recording a RouteHandler error span with it.
    if (!isUuid(id)) {
      return notFoundResponse("Catalog item");
    }

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
 * or otherwise unsupported mutations — and 503 only when the refusal was one an
 * admin would have survived and the caller's role could not be read.
 */
export const PATCH = withAnyAuth<CatalogItemDto, "/catalog/[id]">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, params, receipts) => {
      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Catalog item");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateCatalogItemBodySchema
      );
      if (parseError) {
        return parseError;
      }

      try {
        // The admin verdict is a CAPABILITY here, not a gate: a creator may edit
        // their own item without it. So an unresolved role runs the own-item path
        // anyway — when that succeeds the role could not have changed the answer,
        // and refusing would take away an edit that worked before ISS-8661.
        //
        // Which refusals the role could have overturned is the SERVICE's call,
        // because only it knows why it refused: an immutable item (curated,
        // archived, or a body edit on a target kind that carries none) refuses an
        // admin too and keeps its 403, and only an authorization-dependent
        // refusal comes back as the 503 mapped below.
        const adminStatus = await getOrgAdminStatus(clerkOrgId, clerkUserId);
        const result = await updateCatalogItem(
          {
            id,
            organizationId: user.organizationId,
            userId: user.id,
            canUpdateAny: adminStatus.isAdmin,
            adminDenialReason: adminStatus.isAdmin
              ? undefined
              : adminStatus.reason,
            name: body.name,
            description: body.description,
            sortOrder: body.sortOrder,
            enabled: body.enabled,
            coaching: body.coaching,
            coachingConfig: body.coachingConfig,
            content: body.content,
          },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          if (result.error === Status.NotFound) {
            return notFoundResponse("Catalog item");
          }
          if (result.error === Status.ServiceUnavailable) {
            return roleUnresolvedResponse();
          }
          if (result.error === Status.Forbidden) {
            return forbiddenResponse();
          }
          return errorResponse("Failed to update catalog item", result.error);
        }

        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to update catalog item", error);
      }
    }
  )
);

/**
 * DELETE /catalog/{id}
 *
 * Admin-only. Soft-archive a CatalogItem (sets archived=true).
 * Returns 403 for curated items.
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/catalog/[id]">(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, _request, params, receipts) => {
      const denial = await requireOrgAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { id } = await params;
      if (!isUuid(id)) {
        return notFoundResponse("Catalog item");
      }

      try {
        const result = await archiveCatalogItem(
          { id, organizationId: user.organizationId },
          recordOrganizationWrite(receipts)
        );

        if (!result.ok) {
          if (result.error === 404) {
            return notFoundResponse("Catalog item");
          }
          return forbiddenResponse();
        }

        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to archive catalog item", error);
      }
    }
  )
);
