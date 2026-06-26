import type { ResolveInlineImagesResponse } from "@repo/api/src/types/attachment";
import { log } from "@repo/observability/log";
import { attachmentsService } from "@/app/documents/attachments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { resolveInlineImagesValidator } from "../validators";

type ResolveInlineImagesDiagnostics = {
  requestedCount?: number;
};

function getResolveInlineImagesDiagnostics(
  value: unknown
): ResolveInlineImagesDiagnostics {
  if (!(isRecord(value) && Array.isArray(value.attachmentIds))) {
    return {};
  }

  return { requestedCount: value.attachmentIds.length };
}

async function readResolveInlineImagesDiagnostics(
  request: Request
): Promise<ResolveInlineImagesDiagnostics> {
  try {
    return getResolveInlineImagesDiagnostics(await request.clone().json());
  } catch {
    return {};
  }
}

export const POST = withAnyAuth<
  ResolveInlineImagesResponse,
  "/documents/[id]/attachments/resolve"
>(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const diagnostics = await readResolveInlineImagesDiagnostics(request);
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        log.warn(
          "[documents/attachments] Inline image resolve document not found",
          {
            documentId: id,
            ...diagnostics,
            reason: "document_not_found",
          }
        );
        return notFoundResponse("Document");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        resolveInlineImagesValidator
      );
      if (parseError) {
        log.warn(
          "[documents/attachments] Inline image resolve validation rejected",
          {
            documentId: resolvedId,
            ...diagnostics,
            reason: "validation_rejected",
          }
        );
        return parseError;
      }

      const result = await attachmentsService.resolveInlineImages(
        resolvedId,
        user.organizationId,
        body.attachmentIds
      );

      return successResponse(result);
    } catch (error) {
      if (error instanceof Error && error.message === "Document not found") {
        return notFoundResponse("Document");
      }
      return errorResponse("Failed to resolve inline images", error);
    }
  },
  { requiredScopes: ["read"] }
);
