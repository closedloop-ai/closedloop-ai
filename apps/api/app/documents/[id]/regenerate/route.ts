import { failure, success } from "@repo/api/src/types/common";
import { type Document, DocumentType } from "@repo/api/src/types/document";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

const regenerateBodySchema = z
  .object({
    reverseSynthesisLink: z.string().url().optional(),
  })
  .optional();

export const POST = withAuth<Document, "/documents/[id]/regenerate">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      // Look up artifact to determine type-specific dispatch
      const artifact = await documentsService.findByIdSimple(
        resolvedId,
        user.organizationId
      );
      if (!artifact) {
        return NextResponse.json(failure("Artifact not found"), {
          status: 404,
        });
      }

      // Parse optional body (PRD generation accepts reverseSynthesisLink)
      let body: z.infer<typeof regenerateBodySchema>;
      try {
        const rawBody = await request.json().catch(() => undefined);
        body = regenerateBodySchema.parse(rawBody);
      } catch {
        return NextResponse.json(failure("Invalid request body"), {
          status: 400,
        });
      }

      let result: Awaited<
        ReturnType<typeof documentsService.regenerateImplementationPlan>
      >;

      if (artifact.type === DocumentType.Prd) {
        result = await documentsService.generatePRD(
          resolvedId,
          user.organizationId,
          user.id,
          body?.reverseSynthesisLink ?? null
        );
      } else {
        result = await documentsService.regenerateImplementationPlan(
          resolvedId,
          user.organizationId,
          user.id
        );
      }

      if (!result.success) {
        return NextResponse.json(failure(result.error), {
          status: result.status,
        });
      }

      return NextResponse.json(success(result.document));
    } catch (error) {
      return errorResponse("Failed to regenerate artifact", error);
    }
  }
);
