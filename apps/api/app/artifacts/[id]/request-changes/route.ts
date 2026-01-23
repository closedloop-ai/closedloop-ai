import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/auth/with-auth";
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
    // Log full error structure for debugging
    console.error("Request changes error:", error);
    if (error && typeof error === "object" && !(error instanceof Error)) {
      console.error("Error object structure:", JSON.stringify(error, null, 2));
    }

    // Extract message from various error formats
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    } else if (error && typeof error === "object") {
      // Handle Prisma/other errors that may have nested message
      const errObj = error as Record<string, unknown>;
      message =
        (errObj.message as string) ??
        (errObj.error as string) ??
        JSON.stringify(error);
    } else {
      message = String(error);
    }

    return NextResponse.json(failure(`Request changes failed: ${message}`), {
      status: 500,
    });
  }
});
