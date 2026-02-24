import type { Artifact } from "@repo/api/src/types/artifact";
import { failure, success } from "@repo/api/src/types/common";
import { ArtifactType as PrismaArtifactType } from "@repo/database";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

const regenerateBodySchema = z
  .object({
    reverseSynthesisLink: z.string().url().optional(),
  })
  .optional();

export const POST = withAuth<Artifact, "/artifacts/[id]/regenerate">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      // Look up artifact to determine type-specific dispatch
      const artifact = await artifactsService.findByIdSimple(
        id,
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
        ReturnType<typeof artifactsService.regenerateImplementationPlan>
      >;

      if (artifact.type === PrismaArtifactType.PRD) {
        result = await artifactsService.generatePRD(
          id,
          user.organizationId,
          user.id,
          body?.reverseSynthesisLink ?? null
        );
      } else {
        result = await artifactsService.regenerateImplementationPlan(
          id,
          user.organizationId,
          user.id
        );
      }

      if (!result.success) {
        return NextResponse.json(failure(result.error), {
          status: result.status,
        });
      }

      return NextResponse.json(success(result.artifact));
    } catch (error) {
      return errorResponse("Failed to regenerate artifact", error);
    }
  }
);
