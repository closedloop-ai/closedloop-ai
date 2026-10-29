import "server-only";

import { success } from "@repo/api/src/types/common";
import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { deriveBranchSchemaName } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { sanitizeOperatorMessageFragment } from "@repo/database/scripts/migrate-deploy-recovery";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  GitHubOidcCaller,
  validateGitHubOidcToken,
} from "@/lib/auth/github-oidc-auth";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { repoBranchSchema } from "@/lib/repo-validator-helpers";
import { errorResponse } from "@/lib/route-utils";
import { parsePreviewSchemaRequestBody } from "../request-body";
import { SeedFailureReason } from "./constants";
import { seedPreviewSchema } from "./service";

/**
 * ISS-6804: seeds a branch's preview schema with the FEA-1715 Seed Sandbox,
 * in-process. The stage-deploy workflow's `ensure-preview-schema` job POSTs
 * here right after `/preview-schemas/ensure` succeeds — a SEPARATE request, so
 * the seed gets its own 300s budget instead of sharing the ensure's with
 * migrate + clone.
 *
 * Same auth scheme as the sibling routes (GitHub OIDC), its OWN audience: an
 * ensure token cannot seed and a seed token cannot migrate. Same fail-closed
 * host invariant, owned by the service. This route owns only the status codes:
 * `HostNotAllowed` → 403, `NotAPreviewSchema` → 400, everything else → 500.
 */

/** The seed on a `ci-preview` profile is well inside this; ceiling for safety. */
export const maxDuration = 300;

const seedRequestValidator = z.object({
  branch: repoBranchSchema,
});

/**
 * What an unexpected throw answers with. Fixed, and carries no fragment of the
 * exception: the operator gets the actionable half from the logs, and the
 * printed response body cannot become a credential-disclosure channel.
 */
const UNEXPECTED_SEED_FAILURE_MESSAGE =
  "Failed to seed a schema: the request failed before the seed ran; see the api-stage logs for this request";

const STATUS_BY_REASON: Record<SeedFailureReason, number> = {
  [SeedFailureReason.HostNotAllowed]: 403,
  [SeedFailureReason.NotAPreviewSchema]: 400,
  [SeedFailureReason.AlreadyRunning]: 409,
  [SeedFailureReason.Failed]: 500,
};

async function handlePost(request: NextRequest): Promise<Response> {
  try {
    const authError = await validateGitHubOidcToken(request, {
      caller: GitHubOidcCaller.PreviewSchemaSeed,
    });
    if (authError) {
      return authError;
    }

    const { body, errorResponse: parseErrorResponse } =
      await parsePreviewSchemaRequestBody(request, seedRequestValidator);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }

    const schema = deriveBranchSchemaName(
      body.branch,
      normalizePreviewSchemaName
    );
    const result = await seedPreviewSchema(body.branch, schema);

    if (!result.ok) {
      return errorResponse(
        result.message,
        null,
        STATUS_BY_REASON[result.reason]
      );
    }

    const { ok, ...seeded } = result;
    return NextResponse.json(success(seeded));
  } catch (error) {
    // Preconditions above can throw — a rejected schema derivation, an AWS
    // signer built from malformed IAM config. This route owns a JSON error
    // envelope, so it answers in that envelope rather than leaking an
    // unhandled 500 (apps/api/AGENTS.md).
    //
    // The response is a FIXED string. A signer/config/module-load throw can
    // carry a credential-bearing URL, and the workflow step prints this body —
    // so unlike the seed's own failure (which the service sanitizes and can
    // safely quote), an unexpected throw is not reflected at all. The
    // sanitized detail goes to the log for the operator (review: davetho).
    log.error(UNEXPECTED_SEED_FAILURE_MESSAGE, {
      error: sanitizeOperatorMessageFragment(parseError(error)),
    });
    return errorResponse(UNEXPECTED_SEED_FAILURE_MESSAGE, null, 500);
  }
}

export const POST = withRequestCompleted(handlePost);
