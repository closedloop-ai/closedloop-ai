import { success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { artifactsService } from "../../service";

export const GET = withAnyAuth<string[], "/artifacts/[id]/related">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const relatedIds = await artifactsService.findRelatedArtifacts(
      id,
      user.organizationId
    );

    return NextResponse.json(success(relatedIds));
  }
);
