import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const GET = withAuth<string[], "/artifacts/[id]/related">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const relatedIds = await artifactsService.findRelatedArtifacts(
      id,
      user.organizationId
    );

    return NextResponse.json(success(relatedIds));
  }
);
