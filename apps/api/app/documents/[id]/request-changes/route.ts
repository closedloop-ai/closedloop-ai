import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

const requestChangesSchema = z.object({
  changes: z.string().min(1, "Changes description is required"),
});

export const POST = withAuth<
  { success: true; message: string },
  "/documents/[id]/request-changes"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const body = await request.json();

    const parsed = requestChangesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        failure(parsed.error.issues[0]?.message ?? "Invalid request"),
        { status: 400 }
      );
    }

    const result = await documentsService.requestPlanChanges(
      resolvedId,
      user.organizationId,
      user.id,
      parsed.data.changes
    );

    if (!result.success) {
      return NextResponse.json(failure(result.error), {
        status: result.status,
      });
    }

    return NextResponse.json(
      success({
        success: true,
        message: result.message,
        documentId: result.documentId,
      })
    );
  } catch (error) {
    return errorResponse("Failed to request changes", error);
  }
});
