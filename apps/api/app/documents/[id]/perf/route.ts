import { success } from "@repo/api/src/types/common";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

export const GET = withAuth<PerfSummary | null, "/documents/[id]/perf">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const result = await documentsService.getPerformanceData(
      resolvedId,
      user.organizationId
    );

    return NextResponse.json(success(result));
  }
);
