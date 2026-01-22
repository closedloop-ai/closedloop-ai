import type { Artifact } from "@repo/api/src/types/artifact";
import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const result = await artifactsService.regenerateImplementationPlan(
      id,
      user.organizationId,
      user.id
    );

    if (!result.success) {
      return NextResponse.json(failure(result.error), {
        status: result.status,
      });
    }

    return NextResponse.json(success(result.artifact as Artifact));
  }
);
