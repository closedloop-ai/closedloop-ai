import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

const requestChangesSchema = z.object({
  changes: z.string().min(1, "Changes description is required"),
});

export const POST = withAuth<
  { success: true; message: string },
  "/artifacts/[id]/request-changes"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const body = await request.json();

    const parsed = requestChangesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        failure(parsed.error.issues[0]?.message ?? "Invalid request"),
        { status: 400 }
      );
    }

    const result = await artifactsService.requestPlanChanges(
      id,
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
        artifactId: result.artifactId,
      })
    );
  } catch (error) {
    return errorResponse("Failed to request changes", error);
  }
});
