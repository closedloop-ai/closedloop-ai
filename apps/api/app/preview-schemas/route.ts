import "server-only";

import { success } from "@repo/api/src/types/common";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { validateGitHubOidcToken } from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { errorResponse } from "@/lib/route-utils";
import { parsePreviewSchemaRequestBody } from "./request-body";
import type { DropResult, DryRunResult, SweepResult } from "./service";
import { previewSchemaCleanupService } from "./service";

const cleanupRequestValidator = z.object({
  dryRun: z.boolean().optional(),
  branch: repoBranchSchema.optional(),
});

type CleanupResponse = SweepResult | DryRunResult | DropResult;

async function handlePost(
  request: NextRequest
): Promise<NextResponse<CleanupResponse> | Response> {
  try {
    const authError = await validateGitHubOidcToken(request);
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } =
      await parsePreviewSchemaRequestBody(request, cleanupRequestValidator);
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
        // The workflow step prints this body into a GitHub Actions log, which
        // is far more widely readable than a Vercel log, and `result.error` is
        // raw Prisma text (ISS-7567). Same protected sink as the seed route.
        const detail = sanitizeOperatorMessageFragment(result.error);
        return errorResponse(
          `Failed to drop schema for branch "${branch}": ${detail}`,
          detail,
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
  } catch (error) {
    // The sweep and dry-run paths can reject (a raw query, a GitHub read), and
    // this route owns a JSON error envelope. The response is a FIXED string:
    // an unexpected throw can carry credential-bearing text, and unlike the
    // service's own typed failure it has not been through the sanitizer.
    log.error(UNEXPECTED_CLEANUP_FAILURE_MESSAGE, {
      error: sanitizeOperatorMessageFragment(parseError(error)),
    });
    return errorResponse(UNEXPECTED_CLEANUP_FAILURE_MESSAGE, null, 500);
  }
}

const UNEXPECTED_CLEANUP_FAILURE_MESSAGE =
  "Unexpected failure while cleaning up preview schemas";

export const POST = withRequestCompleted(handlePost);
