import "server-only";

import { featureFlagSnapshotRequestSchema } from "@repo/api/src/types/feature-flag-snapshot";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { parsePreviewSchemaRequestBody } from "../request-body";
import {
  FEATURE_FLAG_SNAPSHOT_REQUEST_MAX_BYTES,
  FeatureFlagSnapshotFailureReason,
} from "./constants";
import { storeFeatureFlagSnapshot } from "./service";

/**
 * ISS-12048: stores a `$vibe` session's production flag snapshot in its branch
 * preview schema, where that preview's `apps/api` pins every flag to it
 * (`apps/api/lib/feature-flags/feature-flag-snapshot.ts`). A repeat POST
 * replaces the stored snapshot, which is how a refresh lands.
 *
 * GitHub OIDC like the sibling routes, with its own audience and workflow. This
 * route owns only the status codes: `HostNotAllowed` 403, `NotAPreviewSchema`
 * 400, everything else 500.
 */

const requestValidator = featureFlagSnapshotRequestSchema.extend({
  branch: repoBranchSchema,
});

/** Fixed, for the same credential-disclosure reason as the seed route. */
const UNEXPECTED_FAILURE_MESSAGE =
  "Failed to store a flag snapshot: the request failed before the write ran; see the api-stage logs for this request";

const STATUS_BY_REASON: Record<FeatureFlagSnapshotFailureReason, number> = {
  [FeatureFlagSnapshotFailureReason.HostNotAllowed]: 403,
  [FeatureFlagSnapshotFailureReason.NotAPreviewSchema]: 400,
  [FeatureFlagSnapshotFailureReason.Failed]: 500,
};

async function handlePost(request: NextRequest): Promise<Response> {
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaFeatureFlagSnapshot,
    });
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } =
      await parsePreviewSchemaRequestBody(
        request,
        requestValidator,
        FEATURE_FLAG_SNAPSHOT_REQUEST_MAX_BYTES
      );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }

    const schema = deriveBranchSchemaName(
      body.branch,
      normalizePreviewSchemaName
    );
    const result = await storeFeatureFlagSnapshot(
      body.branch,
      schema,
      body.snapshot
    );
    if (!result.ok) {
      return errorResponse(
        result.message,
        null,
        STATUS_BY_REASON[result.reason]
      );
    }

    const { ok, ...stored } = result;
    return successResponse(stored);
  } catch (error) {
    log.error(UNEXPECTED_FAILURE_MESSAGE, {
      error: sanitizeOperatorMessageFragment(parseError(error)),
    });
    return errorResponse(UNEXPECTED_FAILURE_MESSAGE, null, 500);
  }
}

export const POST = withRequestCompleted(handlePost);
