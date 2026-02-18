import { success } from "@repo/api/src/types/common";
import type { PerfSummary } from "@repo/api/src/types/performance";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const GET = withAuth<PerfSummary | null, "/artifacts/[id]/perf">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const result = await artifactsService.getPerformanceData(
      id,
      user.organizationId
    );

    return NextResponse.json(success(result));
  }
);
