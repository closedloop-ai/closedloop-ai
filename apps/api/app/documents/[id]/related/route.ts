import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

export const GET = withAnyAuth<string[], "/documents/[id]/related">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const relatedIds = await documentsService.findRelatedDocuments(
      resolvedId,
      user.organizationId
    );

    return NextResponse.json(success(relatedIds));
  }
);
