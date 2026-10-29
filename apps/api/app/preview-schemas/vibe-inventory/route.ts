import "server-only";

import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { isVibeEnvironmentBranch } from "@repo/database/scripts/vibe-environment-retention";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { vibeInventoryService } from "./service";

/**
 * ISS-12216 (PRD-783 FR9): read-only. With `branch`, whether that vibe
 * branch's schema still exists, which decides whether a branch deletion was a
 * discard (release the pins) or an engineering merge (keep them). Without it,
 * every vibe, prototype and functional-prototype environment the
 * registry knows (ISS-12414), for the weekly inventory. GitHub
 * OIDC like the sibling routes, with its own audience pinned to
 * `prototype-pin-alias.yml` on main.
 */

const inventoryQueryValidator = z
  .object({
    branch: repoBranchSchema
      .refine(isVibeEnvironmentBranch, "branch must be a vibe/ branch")
      .optional(),
  })
  .strict();

async function handleGet(request: NextRequest): Promise<Response> {
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaVibeInventory,
    });
    if (authError) {
      return authError;
    }
    const { params, errorResponse: queryError } = parseQueryParams(
      request,
      inventoryQueryValidator
    );
    if (queryError) {
      return queryError;
    }
    if (params.branch !== undefined) {
      return successResponse(
        await vibeInventoryService.readSchemaPresence(params.branch)
      );
    }
    return successResponse({
      environments: await vibeInventoryService.listEnvironments(),
    });
  } catch (error) {
    log.error(UNEXPECTED_INVENTORY_FAILURE_MESSAGE, {
      error: sanitizeOperatorMessageFragment(parseError(error)),
    });
    return errorResponse(UNEXPECTED_INVENTORY_FAILURE_MESSAGE, null, 500);
  }
}

const UNEXPECTED_INVENTORY_FAILURE_MESSAGE =
  "Unexpected failure while reading vibe environments";

export const GET = withRequestCompleted(handleGet);
