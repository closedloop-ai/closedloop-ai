import { success } from "@repo/api/src/types/common";
import type { PerformanceDataResponse } from "@repo/api/src/types/performance";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const GET = withAuth<PerformanceDataResponse, "/artifacts/[id]/perf">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const result = await artifactsService.getPerformanceData(
      id,
      user.organizationId
    );

    const response: PerformanceDataResponse =
      result !== null
        ? { status: "success", data: result }
        : { status: "not_found", data: null };

    return NextResponse.json(success(response));
  }
);
