import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAnyAuth<string[], "/artifacts/[id]/related">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const relatedIds = await artifactsService.findRelatedArtifacts(
      resolvedId,
      user.organizationId
    );

    return NextResponse.json(success(relatedIds));
  }
);
