import "server-only";

import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { appliedMigrationsService } from "./service";

/**
 * ISS-11782/ISS-11783: read-only. The migrations `prisma migrate deploy` has
 * recorded on this deployment's `public` schema, for the stage gate that holds
 * `production` and the `stage-migrated` ref back until a SHA's migrations have
 * been applied. GitHub OIDC like the sibling routes, with its own audience
 * pinned to `deploy-production.yml` and `stage-migrated-ref.yml` on main.
 */

const UNEXPECTED_FAILURE_MESSAGE =
  "Unexpected failure while reading the applied migrations";

async function handleGet(request: NextRequest): Promise<Response> {
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaAppliedMigrations,
    });
    if (authError) {
      return authError;
    }
    return successResponse({
      migrations: await appliedMigrationsService.list(),
    });
  } catch (error) {
    log.error(UNEXPECTED_FAILURE_MESSAGE, {
      error: sanitizeOperatorMessageFragment(parseError(error)),
    });
    return errorResponse(UNEXPECTED_FAILURE_MESSAGE, null, 500);
  }
}

export const GET = withRequestCompleted(handleGet);
