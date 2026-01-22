import type { Artifact } from "@repo/api/src/types/artifact";
import { failure, success } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async ({ user }, _request, params) => {
    try {
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
    } catch (error) {
      let message: string;
      if (error instanceof Error) {
        message = error.message;
      } else if (typeof error === "object") {
        message = JSON.stringify(error);
      } else {
        message = String(error);
      }
      log.error("Failed to regenerate implementation plan", { error: message });
      return NextResponse.json(failure(`Regeneration failed: ${message}`), {
        status: 500,
      });
    }
  }
);
