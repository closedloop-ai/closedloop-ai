import "server-only";

import { success } from "@repo/api/src/types/common";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGitHubOidcToken } from "@/lib/auth/github-oidc-auth";
import { errorResponse, parseBody, scheduleLogFlush } from "@/lib/route-utils";
import type { DropResult, DryRunResult, SweepResult } from "./service";
import { previewSchemaCleanupService } from "./service";

const cleanupRequestValidator = z.object({
  dryRun: z.boolean().optional(),
  branch: z.string().min(1).optional(),
});

type CleanupResponse = SweepResult | DryRunResult | DropResult;

export async function POST(
  request: NextRequest
): Promise<NextResponse<CleanupResponse> | Response> {
  try {
    const authError = await validateGitHubOidcToken(request);
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } = await parseBody(
      request,
      cleanupRequestValidator
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }

    const { dryRun, branch } = body;

    if (branch && dryRun) {
      return errorResponse(
        "Combining branch with dryRun is not supported — omit dryRun to drop the branch schema",
        null,
        400
      );
    }

    if (branch) {
      const result =
        await previewSchemaCleanupService.dropSchemaForBranch(branch);
      if (result.error !== null) {
        return errorResponse(
          `Failed to drop schema for branch "${branch}": ${result.error}`,
          result.error,
          500
        );
      }
      return NextResponse.json(success(result));
    }

    if (dryRun) {
      const result = await previewSchemaCleanupService.runDryRun();
      if (result.counters.registryReadErrored > 0) {
        return errorResponse(
          `Dry-run completed with ${result.counters.registryReadErrored} registry-read error(s)`,
          null,
          500
        );
      }
      return NextResponse.json(success(result));
    }

    const result = await previewSchemaCleanupService.runDailySweep();
    if (result.exitCode !== 0) {
      return errorResponse(
        `Daily sweep completed with errors: ${result.summary}`,
        null,
        500
      );
    }
    return NextResponse.json(success(result));
  } finally {
    scheduleLogFlush();
  }
}
